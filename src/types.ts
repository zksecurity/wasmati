import { Binable, Bool, Byte, record, withByteCode } from "./binable.ts";
import { S33, U32, U64, vec } from "./immediate.ts";
import type { Tuple } from "./util.ts";

export { i32t, i64t, f32t, f64t, v128t, funcref, externref };
export { TypeIndex, FunctionIndex, MemoryIndex, TableIndex, ElemIndex, DataIndex };
export { GlobalIndex, LocalIndex, LabelIndex, type Index, type IndexSpace };
export {
  HeapType,
  refType,
  isRefType,
  referenced,
  typeEquals,
  isSubtype,
  printValueType,
  type ValueTypeObject,
  type RefTypeObject,
  FunctionType,
  MemoryType,
  GlobalType,
  TableType,
  ValueType,
  RefType,
  type Type,
  type Local,
  ResultType,
  invertRecord,
  valueType,
  type ValueTypeObjects,
  valueTypeLiteral,
  valueTypeLiterals,
  type ValueTypeLiterals,
  functionTypeEquals,
  printFunctionType,
  type JSValue,
  Limits,
  type AddressType,
  addressType,
  valueTypeSet,
};

/**
 * A heap type: abstract, or a defined type. Modules refer to types by index; builders describe a
 * function type structurally until the module assigns its index.
 */
type HeapType = "func" | "extern" | number | FunctionType;
/** References to a heap type. Nullable references to func and extern are written funcref and externref. */
type RefType = "funcref" | "externref" | { ref: HeapType; nullable: boolean };
type NumberOrVectorType = "i32" | "i64" | "f32" | "f64" | "v128";
type ValueType = NumberOrVectorType | RefType;

function refType(heap: HeapType, nullable: boolean): RefType {
  if (nullable && heap === "func") return "funcref";
  if (nullable && heap === "extern") return "externref";
  return { ref: heap, nullable };
}

function isRefType(type: ValueType): type is RefType {
  return typeof type === "object" || type === "funcref" || type === "externref";
}

/** The heap type and nullability of a reference type, including the funcref and externref shorthands. */
function referenced(type: RefType): { ref: HeapType; nullable: boolean } {
  if (type === "funcref") return { ref: "func", nullable: true };
  if (type === "externref") return { ref: "extern", nullable: true };
  return type;
}

function heapTypeEquals(a: HeapType, b: HeapType): boolean {
  if (typeof a === "object" && typeof b === "object") return functionTypeEquals(a, b);
  return a === b;
}

function typeEquals(a: ValueType, b: ValueType): boolean {
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  return a.nullable === b.nullable && heapTypeEquals(a.ref, b.ref);
}

/**
 * Subtyping of function references: non-null references are subtypes of nullable ones, and references
 * to a defined function type are subtypes of references to func.
 */
function isSubtype(a: ValueType, b: ValueType): boolean {
  if (typeEquals(a, b)) return true;
  if (!isRefType(a) || !isRefType(b)) return false;
  const [sub, sup] = [referenced(a), referenced(b)];
  if (sub.nullable && !sup.nullable) return false;
  const concrete = typeof sub.ref === "number" || typeof sub.ref === "object";
  return heapTypeEquals(sub.ref, sup.ref) || (concrete && sup.ref === "func");
}

function printValueType(type: ValueType): string {
  if (typeof type !== "object") return type;
  const heap = typeof type.ref === "object" ? printFunctionType(type.ref) : String(type.ref);
  return `(ref ${type.nullable ? "null " : ""}${heap})`;
}

type Type<L> = { kind: L };
type Local<L = ValueType> = { kind: "local"; type: L; index: number };

function valueTypeLiteral<L extends ValueType>({ kind }: { kind: L }): L {
  return kind;
}
type ValueTypeObjects<T extends Tuple<ValueType>> = {
  [i in keyof T]: Type<T[i]>;
};
function valueType<L extends ValueType>(kind: L): Type<L> {
  return { kind };
}
type ValueTypeLiterals<T extends Tuple<ValueTypeObject>> = {
  [i in keyof T]: T[i] extends { kind: infer L } ? L : never;
};
function valueTypeLiterals<const L extends ValueType[]>(types: {
  [i in keyof L]: Type<L[i]>;
}): L & ValueType[] {
  return types.map((t) => t.kind) as L;
}

const valueTypeCodes: Record<NumberOrVectorType | "funcref" | "externref", number> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
  funcref: 0x70,
  externref: 0x6f,
};
const i32t = valueType("i32");
const i64t = valueType("i64");
const f32t = valueType("f32");
const f64t = valueType("f64");
const v128t = valueType("v128");
const funcref = valueType("funcref");
const externref = valueType("externref");

const codeToValueType = invertRecord(valueTypeCodes);

const valueTypeSet = new Set(Object.keys(valueTypeCodes) as ValueType[]);

/** Abstract heap types as negative s33 values, which encode as the single bytes of funcref and externref. */
const heapTypeCodes = { func: -0x10, extern: -0x11 } as const;

/** Heap types: an s33, negative for abstract heap types, a type index otherwise. */
const HeapType = Binable<HeapType>({
  toBytes(heap) {
    if (typeof heap === "object") throw Error("HeapType: function type has no index yet");
    return S33.toBytes(typeof heap === "number" ? heap : heapTypeCodes[heap]);
  },
  readBytes(bytes, offset) {
    let [code, end] = S33.readBytes(bytes, offset);
    if (code >= 0) return [code, end];
    if (code === heapTypeCodes.func) return ["func", end];
    if (code === heapTypeCodes.extern) return ["extern", end];
    throw Error(`heap type ${code} is not supported`);
  },
});

type ValueTypeObject = { kind: ValueType };
const ValueType = Binable<ValueType>({
  toBytes(type) {
    if (typeof type === "object")
      return [type.nullable ? 0x63 : 0x64, ...HeapType.toBytes(type.ref)];
    let code = valueTypeCodes[type];
    if (code === undefined) throw Error(`Invalid value type ${type}`);
    return [code];
  },
  readBytes(bytes, offset) {
    let code = Byte.readBytes(bytes, offset)[0];
    if (code === 0x63 || code === 0x64) {
      let [heap, end] = HeapType.readBytes(bytes, offset + 1);
      return [refType(heap, code === 0x63), end];
    }
    let type = codeToValueType.get(code);
    if (type === undefined) throw Error(`Invalid value type code ${code.toString(16)}.`);
    return [type, offset + 1];
  },
});

type RefTypeObject = { kind: RefType };
const RefType = Binable<RefType>({
  toBytes(t) {
    return ValueType.toBytes(t);
  },
  readBytes(bytes, offset) {
    let [type, end] = ValueType.readBytes(bytes, offset);
    if (!isRefType(type)) throw Error("invalid reftype");
    return [type, end];
  },
});

type GlobalType<T = ValueType> = { value: T; mutable: boolean };
const GlobalType = record<GlobalType>({ value: ValueType, mutable: Bool });

type AddressType = "i32" | "i64";
/** Limits of a memory or table. A 64-bit address type is recorded as `address: "i64"`, as in the JS API. */
type Limits = { min: U64; max?: U64; shared: boolean; address?: "i64" };
const Limits = Binable<Limits>({
  toBytes({ min, max, shared, address }) {
    let flags = (max === undefined ? 0 : 1) | (shared ? 2 : 0) | (address === "i64" ? 4 : 0);
    let Size = address === "i64" ? U64 : U32;
    return [flags, ...Size.toBytes(min), ...(max === undefined ? [] : Size.toBytes(max))];
  },
  readBytes(bytes, offset) {
    let flags: number, min: U64, max: U64 | undefined;
    [flags, offset] = Byte.readBytes(bytes, offset);
    if (flags > 7) throw Error("invalid limit type");
    let Size = flags & 4 ? U64 : U32;
    [min, offset] = Size.readBytes(bytes, offset);
    if (flags & 1) [max, offset] = Size.readBytes(bytes, offset);
    let limits: Limits = { min, max, shared: (flags & 2) !== 0 };
    if (flags & 4) limits.address = "i64";
    return [limits, offset];
  },
});

function addressType(limits: Limits): AddressType {
  return limits.address ?? "i32";
}

type MemoryType = { limits: Limits };
const MemoryType = record<MemoryType>({ limits: Limits });

type TableType = { type: RefType; limits: Limits };
const TableType = record<TableType>({ type: RefType, limits: Limits });

const ResultType = vec(ValueType);

type FunctionType = { args: ValueType[]; results: ValueType[] };
const FunctionType = withByteCode(
  0x60,
  record<FunctionType>({ args: ResultType, results: ResultType }),
);

type IndexSpace =
  "type" | "function" | "table" | "memory" | "global" | "elem" | "data" | "local" | "label";
/** Indices are u32 in binary. Each index space has its own immediate, which records the space. */
type Index = Binable<U32> & { space: IndexSpace };
function index(space: IndexSpace): Index {
  return { ...U32, space };
}

type TypeIndex = U32;
const TypeIndex = index("type");
type FunctionIndex = U32;
const FunctionIndex = index("function");
type TableIndex = U32;
const TableIndex = index("table");
type MemoryIndex = U32;
const MemoryIndex = index("memory");
type ElemIndex = U32;
const ElemIndex = index("elem");
type DataIndex = U32;
const DataIndex = index("data");
type GlobalIndex = U32;
const GlobalIndex = index("global");
type LocalIndex = U32;
const LocalIndex = index("local");
type LabelIndex = U32;
const LabelIndex = index("label");

function invertRecord<K extends string, V>(record: Record<K, V>): Map<V, K> {
  let map = new Map<V, K>();
  for (let key in record) {
    map.set(record[key], key);
  }
  return map;
}

function functionTypeEquals(
  { args: fArgs, results: fResults }: FunctionType,
  { args: gArgs, results: gResults }: FunctionType,
) {
  let nArgs = fArgs.length;
  let nResults = fResults.length;
  if (gArgs.length !== nArgs || gResults.length !== nResults) return false;
  for (let i = 0; i < nArgs; i++) {
    if (!typeEquals(fArgs[i], gArgs[i])) return false;
  }
  for (let i = 0; i < nResults; i++) {
    if (!typeEquals(fResults[i], gResults[i])) return false;
  }
  return true;
}

function printFunctionType({ args, results }: FunctionType) {
  return `[${args.map(printValueType)}] -> [${results.map(printValueType)}]`;
}

// infer JS values

type JSValue<T> = T extends "i32"
  ? number
  : T extends "f32"
    ? number
    : T extends "f64"
      ? number
      : T extends "i64"
        ? bigint
        : T extends "v128"
          ? never
          : T extends "funcref"
            ? Function | null
            : T extends "externref"
              ? unknown
              : T extends { ref: HeapType }
                ? unknown
                : never;
