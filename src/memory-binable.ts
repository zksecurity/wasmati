import { Binable, Byte, record } from "./binable.ts";
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
  toBytes({ init, ...type }) {
    if (init === undefined) return TableType.toBytes(type);
    return [0x40, 0x00, ...TableType.toBytes(type), ...ConstExpression.toBytes(init)];
  },
  readBytes(bytes, offset) {
    if (bytes[offset] !== 0x40) return TableType.readBytes(bytes, offset);
    if (bytes[offset + 1] !== 0x00) throw Error("malformed table");
    let [type, end] = TableType.readBytes(bytes, offset + 2);
    let init: ConstExpression;
    [init, end] = ConstExpression.readBytes(bytes, end);
    return [{ ...type, init }, end];
  },
});

type Global = { type: GlobalType; init: ConstExpression };
const Global = record<Global>({ type: GlobalType, init: ConstExpression });

type Data = {
  init: Byte[];
  mode: "passive" | { memory: U32; offset: ConstExpression };
};

/** Data segment kinds: 0 is active in memory 0, 1 is passive, 2 is active in an explicit memory. */
const Data = Binable<Data>({
  write(writer, { init, mode }) {
    if (mode === "passive") writer.byte(1);
    else {
      if (mode.memory === 0) writer.byte(0);
      else {
        writer.byte(2);
        writer.unsigned(mode.memory);
      }
      ConstExpression.write(writer, mode.offset);
    }
    writer.unsigned(init.length);
    writer.bytes(init);
  },
  readBytes(bytes, offset) {
    let kind: number;
    [kind, offset] = U32.readBytes(bytes, offset);
    if (kind > 2) throw Error(`malformed data segment kind ${kind}`);
    let mode: Data["mode"] = "passive";
    if (kind !== 1) {
      let memory = 0;
      if (kind === 2) [memory, offset] = U32.readBytes(bytes, offset);
      let expression: ConstExpression;
      [expression, offset] = ConstExpression.readBytes(bytes, offset);
      mode = { memory, offset: expression };
    }
    let init: Byte[];
    [init, offset] = vec(Byte).readBytes(bytes, offset);
    return [{ init, mode }, offset];
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
  toBytes({ type, init, mode }) {
    // write code
    let isPassive = Number(typeof mode === "string");
    // Function indices denote non-null function references.
    let isExplicit = Number(!(typeEquals(type, functionReference) && isFuncIdx(init)));
    // Active segments on table 0 imply their type: (ref func) for indices, funcref for expressions.
    let implied = !isExplicit || typeEquals(type, "funcref");
    let isBit1 = Number(
      typeof mode !== "string" ? mode.table !== 0 || !implied : mode === "declarative",
    );
    let bytes = U32.toBytes((isPassive << 0) | (isBit1 << 1) | (isExplicit << 2));
    // in active mode, write table and offset
    if (typeof mode !== "string") {
      let table = isBit1 ? TableIndex.toBytes(mode.table) : [];
      let offset = Expression.toBytes(mode.offset);
      bytes.push(...table, ...offset);
    }
    // write type
    let typeBytes = isPassive | isBit1 ? (isExplicit ? RefType.toBytes(type) : [0x00]) : [];
    bytes.push(...typeBytes);
    // write init
    let initBytes = isExplicit
      ? Expressions.toBytes(init)
      : FunctionIndices.toBytes(toFuncIdx(init));
    bytes.push(...initBytes);
    return bytes;
  },
  readBytes(bytes, offset) {
    let code: number;
    [code, offset] = U32.readBytes(bytes, offset);
    if (code > 7) throw Error(`malformed element segment kind ${code}`);
    let [isPassive, isBit1, isExplicit] = [code & 1, code & 2, code & 4];
    // parse mode / table / offset
    let mode: Elem["mode"];
    if (isPassive) mode = isBit1 ? "declarative" : "passive";
    else {
      let table: TableIndex = 0;
      let tableOffset: ConstExpression;
      if (isBit1) [table, offset] = TableIndex.readBytes(bytes, offset);
      [tableOffset, offset] = ConstExpression.readBytes(bytes, offset);
      mode = { table, offset: tableOffset };
    }
    // parse type
    let type: RefType = isExplicit ? "funcref" : functionReference;
    if (isPassive | isBit1) {
      if (isExplicit) [type, offset] = RefType.readBytes(bytes, offset);
      else if (bytes[offset++] !== 0x00) throw Error("Elem: invalid elemkind");
    }
    // parse init
    let init: Expressions;
    if (isExplicit) [init, offset] = Expressions.readBytes(bytes, offset);
    else {
      let idx: FunctionIndices;
      [idx, offset] = FunctionIndices.readBytes(bytes, offset);
      init = fromFuncIdx(idx);
    }
    return [{ mode, type, init }, offset];
  },
});
