import {
  Binable,
  byteCursor,
  record,
  writeByte,
  writeByteArray,
  writeUnsignedLEB,
  writtenBytes,
} from "./binable.ts";
import { U32, vec } from "./immediate.ts";
import { END, Expression } from "./instruction/binable.ts";
import {
  FunctionIndex,
  GlobalType,
  RefType,
  refType,
  TableIndex,
  TableType,
  typeEquals,
} from "./types.ts";

export { Global, Data, Elem, Table, EncodedGlobal, EncodedData, EncodedElem, EncodedTable };

/** The type of segments given as function indices. */
const functionReference = refType("func", false);

/**
 * The codec of the constant expressions in a module's globals, tables and segments: decoded, as
 * instructions, or encoded, as bytes. Element segments of function references encode compactly, as
 * the function indices of expressions that are a single `ref.func`.
 */
type ExpressionCodec<E> = Binable<E> & {
  funcIndex(expression: E): FunctionIndex | undefined;
  funcRef(index: FunctionIndex): E;
};

const DecodedExpression: ExpressionCodec<Expression> = {
  ...Expression,
  funcIndex: (expression) =>
    expression.length === 1 && expression[0].name === "ref.func"
      ? (expression[0].immediate as FunctionIndex)
      : undefined,
  funcRef: (index) => [{ name: "ref.func", immediate: index }],
};

const REF_FUNC = 0xd2;

/** Constant expressions as bytes, with their final `end`. Reading finds their end by decoding them. */
const EncodedExpression: ExpressionCodec<Uint8Array> = {
  ...Binable<Uint8Array>({
    writeBytes(output, bytes) {
      writeByteArray(output, bytes);
    },
    readBytes(input) {
      let start = input.offset;
      Expression.readBytes(input);
      return input.bytes.slice(start, input.offset);
    },
  }),
  funcIndex(bytes) {
    if (bytes[0] !== REF_FUNC) return undefined;
    let index = 0;
    let i = 1;
    for (let shift = 1; i < bytes.length; i++, shift *= 0x80) {
      index += (bytes[i] & 0x7f) * shift;
      if (bytes[i] < 0x80) break;
    }
    return i === bytes.length - 2 && bytes[i + 1] === END ? index : undefined;
  },
  funcRef(index) {
    let output = byteCursor(8);
    writeByte(output, REF_FUNC);
    writeUnsignedLEB(output, index);
    writeByte(output, END);
    return writtenBytes(output);
  },
};

/** A table, initialized with null unless it has an initializer: `0x40 0x00` precedes those. */
type Table<E = Expression> = TableType & { init?: E };
type Global<E = Expression> = { type: GlobalType; init: E };
type Data<E = Expression> = {
  init: Uint8Array;
  mode: "passive" | { memory: U32; offset: E };
};
type Elem<E = Expression> = {
  type: RefType;
  init: E[];
  mode: "passive" | "declarative" | { table: U32; offset: E };
};
type EncodedTable = Table<Uint8Array>;
type EncodedGlobal = Global<Uint8Array>;
type EncodedData = Data<Uint8Array>;
type EncodedElem = Elem<Uint8Array>;

/** The codecs of globals, tables and segments, whose constant expressions are of the given codec. */
function segmentCodecs<E>(Expr: ExpressionCodec<E>) {
  const Table = Binable<Table<E>>({
    writeBytes(output, { init, ...type }) {
      if (init !== undefined) writeByteArray(output, [0x40, 0x00]);
      TableType.writeBytes(output, type);
      if (init !== undefined) Expr.writeBytes(output, init);
    },
    readBytes(input) {
      let { bytes, offset } = input;
      if (bytes[offset] !== 0x40) return TableType.readBytes(input);
      if (bytes[offset + 1] !== 0x00) throw Error("malformed table");
      input.offset += 2;
      let type = TableType.readBytes(input);
      return { ...type, init: Expr.readBytes(input) };
    },
  });

  const Global = record<Global<E>>({ type: GlobalType, init: Expr });

  /** Data segment kinds: 0 is active in memory 0, 1 is passive, 2 is active in an explicit memory. */
  const Data = Binable<Data<E>>({
    writeBytes(output, { init, mode }) {
      if (mode === "passive") writeByte(output, 1);
      else {
        if (mode.memory === 0) writeByte(output, 0);
        else {
          writeByte(output, 2);
          writeUnsignedLEB(output, mode.memory);
        }
        Expr.writeBytes(output, mode.offset);
      }
      writeUnsignedLEB(output, init.length);
      writeByteArray(output, init);
    },
    readBytes(input) {
      let kind = U32.readBytes(input);
      if (kind > 2) throw Error(`malformed data segment kind ${kind}`);
      let mode: Data<E>["mode"] = "passive";
      if (kind !== 1) {
        let memory = kind === 2 ? U32.readBytes(input) : 0;
        mode = { memory, offset: Expr.readBytes(input) };
      }
      let length = U32.readBytes(input);
      let end = input.offset + length;
      if (end > input.bytes.length) throw Error("unexpected end");
      let init = input.bytes.slice(input.offset, end);
      input.offset = end;
      return { init, mode };
    },
  });

  const FunctionIndices = vec(FunctionIndex);
  const Expressions = vec(Expr);

  const Elem = Binable<Elem<E>>({
    writeBytes(output, { type, init, mode }) {
      let isPassive = Number(typeof mode === "string");
      // Function indices denote non-null function references.
      let indices = typeEquals(type, functionReference) ? init.map(Expr.funcIndex) : undefined;
      let isExplicit = Number(indices === undefined || indices.includes(undefined));
      // Active segments on table 0 imply their type: (ref func) for indices, funcref for expressions.
      let implied = !isExplicit || typeEquals(type, "funcref");
      let isBit1 = Number(
        typeof mode !== "string" ? mode.table !== 0 || !implied : mode === "declarative",
      );
      writeUnsignedLEB(output, (isPassive << 0) | (isBit1 << 1) | (isExplicit << 2));
      // in active mode, the table and offset
      if (typeof mode !== "string") {
        if (isBit1) TableIndex.writeBytes(output, mode.table);
        Expr.writeBytes(output, mode.offset);
      }
      if (isPassive | isBit1) {
        if (isExplicit) RefType.writeBytes(output, type);
        else writeByte(output, 0x00);
      }
      if (isExplicit) Expressions.writeBytes(output, init);
      else FunctionIndices.writeBytes(output, indices as FunctionIndex[]);
    },
    readBytes(input) {
      let code = U32.readBytes(input);
      if (code > 7) throw Error(`malformed element segment kind ${code}`);
      let [isPassive, isBit1, isExplicit] = [code & 1, code & 2, code & 4];
      let mode: Elem<E>["mode"];
      if (isPassive) mode = isBit1 ? "declarative" : "passive";
      else {
        let table: TableIndex = isBit1 ? TableIndex.readBytes(input) : 0;
        mode = { table, offset: Expr.readBytes(input) };
      }
      let type: RefType = isExplicit ? "funcref" : functionReference;
      if (isPassive | isBit1) {
        if (isExplicit) type = RefType.readBytes(input);
        else if (input.bytes[input.offset++] !== 0x00) throw Error("Elem: invalid elemkind");
      }
      let init = isExplicit
        ? Expressions.readBytes(input)
        : FunctionIndices.readBytes(input).map(Expr.funcRef);
      return { mode, type, init };
    },
  });

  return { Table, Global, Data, Elem };
}

const { Table, Global, Data, Elem } = segmentCodecs(DecodedExpression);
const {
  Table: EncodedTable,
  Global: EncodedGlobal,
  Data: EncodedData,
  Elem: EncodedElem,
} = segmentCodecs(EncodedExpression);
