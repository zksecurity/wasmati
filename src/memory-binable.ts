import { Binable, record, writeByte, writeByteArray, writeUnsignedLEB } from "./binable.ts";
import { U32, vec } from "./immediate.ts";
import { ConstExpression, Expression } from "./instruction/binable.ts";
import {
  FunctionIndex,
  GlobalType,
  RefType,
  refType,
  TableIndex,
  TableType,
  typeEquals,
} from "./types.ts";

/** The type of segments given as function indices. */
const functionReference = refType("func", false);

export { Global, Data, Elem, Table };

/** A table, initialized with null unless it has an initializer: `0x40 0x00` precedes those. */
type Table = TableType & { init?: ConstExpression };
const Table = Binable<Table>({
  writeBytes(output, { init, ...type }) {
    if (init !== undefined) writeByteArray(output, [0x40, 0x00]);
    TableType.writeBytes(output, type);
    if (init !== undefined) ConstExpression.writeBytes(output, init);
  },
  readBytes(input) {
    let { bytes, offset } = input;
    if (bytes[offset] !== 0x40) return TableType.readBytes(input);
    if (bytes[offset + 1] !== 0x00) throw Error("malformed table");
    input.offset += 2;
    let type = TableType.readBytes(input);
    return { ...type, init: ConstExpression.readBytes(input) };
  },
});

type Global = { type: GlobalType; init: ConstExpression };
const Global = record<Global>({ type: GlobalType, init: ConstExpression });

type Data = {
  init: Uint8Array;
  mode: "passive" | { memory: U32; offset: ConstExpression };
};

/** Data segment kinds: 0 is active in memory 0, 1 is passive, 2 is active in an explicit memory. */
const Data = Binable<Data>({
  writeBytes(output, { init, mode }) {
    if (mode === "passive") writeByte(output, 1);
    else {
      if (mode.memory === 0) writeByte(output, 0);
      else {
        writeByte(output, 2);
        writeUnsignedLEB(output, mode.memory);
      }
      ConstExpression.writeBytes(output, mode.offset);
    }
    writeUnsignedLEB(output, init.length);
    writeByteArray(output, init);
  },
  readBytes(input) {
    let kind = U32.readBytes(input);
    if (kind > 2) throw Error(`malformed data segment kind ${kind}`);
    let mode: Data["mode"] = "passive";
    if (kind !== 1) {
      let memory = kind === 2 ? U32.readBytes(input) : 0;
      mode = { memory, offset: ConstExpression.readBytes(input) };
    }
    let length = U32.readBytes(input);
    let end = input.offset + length;
    if (end > input.bytes.length) throw Error("unexpected end");
    let init = input.bytes.slice(input.offset, end);
    input.offset = end;
    return { init, mode };
  },
});

type Elem = {
  type: RefType;
  init: Expression[];
  mode: "passive" | "declarative" | { table: U32; offset: ConstExpression };
};

type FunctionIndices = FunctionIndex[];
const FunctionIndices = vec(FunctionIndex);
type Expressions = Expression[];
const Expressions = vec(Expression);

function fromFuncIdx(funcIdx: FunctionIndices): Expressions {
  return funcIdx.map((i) => [{ name: "ref.func", immediate: i }]);
}
function toFuncIdx(expr: Expressions) {
  return expr.map((e) => e[0].immediate as FunctionIndex);
}
function isFuncIdx(expr: Expressions) {
  return expr.every((e) => e.length === 1 && e[0].name === "ref.func");
}

const Elem = Binable<Elem>({
  writeBytes(output, { type, init, mode }) {
    let isPassive = Number(typeof mode === "string");
    // Function indices denote non-null function references.
    let isExplicit = Number(!(typeEquals(type, functionReference) && isFuncIdx(init)));
    // Active segments on table 0 imply their type: (ref func) for indices, funcref for expressions.
    let implied = !isExplicit || typeEquals(type, "funcref");
    let isBit1 = Number(
      typeof mode !== "string" ? mode.table !== 0 || !implied : mode === "declarative",
    );
    writeUnsignedLEB(output, (isPassive << 0) | (isBit1 << 1) | (isExplicit << 2));
    // in active mode, the table and offset
    if (typeof mode !== "string") {
      if (isBit1) TableIndex.writeBytes(output, mode.table);
      Expression.writeBytes(output, mode.offset);
    }
    if (isPassive | isBit1) {
      if (isExplicit) RefType.writeBytes(output, type);
      else writeByte(output, 0x00);
    }
    if (isExplicit) Expressions.writeBytes(output, init);
    else FunctionIndices.writeBytes(output, toFuncIdx(init));
  },
  readBytes(input) {
    let code = U32.readBytes(input);
    if (code > 7) throw Error(`malformed element segment kind ${code}`);
    let [isPassive, isBit1, isExplicit] = [code & 1, code & 2, code & 4];
    let mode: Elem["mode"];
    if (isPassive) mode = isBit1 ? "declarative" : "passive";
    else {
      let table: TableIndex = isBit1 ? TableIndex.readBytes(input) : 0;
      mode = { table, offset: ConstExpression.readBytes(input) };
    }
    let type: RefType = isExplicit ? "funcref" : functionReference;
    if (isPassive | isBit1) {
      if (isExplicit) type = RefType.readBytes(input);
      else if (input.bytes[input.offset++] !== 0x00) throw Error("Elem: invalid elemkind");
    }
    let init = isExplicit
      ? Expressions.readBytes(input)
      : fromFuncIdx(FunctionIndices.readBytes(input));
    return { mode, type, init };
  },
});
