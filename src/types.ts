import { Binable, Bool, readByte, record, withByteCode, writeByte } from "./binable.ts";
import { S33, U32, U64, vec } from "./immediate.ts";
import type { Tuple } from "./util.ts";

export { i32t, i64t, f32t, f64t, v128t, funcref, externref, exnref };
export {
  anyref,
  eqref,
  i31ref,
  structref,
  arrayref,
  nullref,
  nullfuncref,
  nullexternref,
  nullexnref,
};
export { TypeIndex, FunctionIndex, MemoryIndex, TableIndex, ElemIndex, DataIndex };
export { GlobalIndex, LocalIndex, LabelIndex, TagIndex, type Index, type IndexSpace };
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
  TagType,
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
  type AbstractHeapType,
  type DefinedType,
  FieldType,
  CompositeType,
  type Shorthand,
  shorthands,
  compositeKind,
  isFunctionType,
  referencedTypes,
  typeKey,
  isHeapSubtype,
  StorageType,
  TypeDefinition,
  RecType,
};

/** Abstract heap types. Bottom types: none below any, nofunc below func, and so on. */
type AbstractHeapType =
  | "func"
  | "extern"
  | "exn"
  | "any"
  | "eq"
  | "i31"
  | "struct"
  | "array"
  | "none"
  | "nofunc"
  | "noextern"
  | "noexn";
/** A heap type: abstract, or a defined type, by index in modules and as an object in builders. */
type HeapType = AbstractHeapType | number | DefinedType;

/** Nullable references to abstract heap types have shorthand names. */
const shorthands = {
  funcref: "func",
  externref: "extern",
  exnref: "exn",
  anyref: "any",
  eqref: "eq",
  i31ref: "i31",
  structref: "struct",
  arrayref: "array",
  nullref: "none",
  nullfuncref: "nofunc",
  nullexternref: "noextern",
  nullexnref: "noexn",
} as const satisfies Record<string, AbstractHeapType>;
type Shorthand = keyof typeof shorthands;
const shorthandOf = invertRecord(shorthands);

/** References to a heap type. */
type RefType = Shorthand | { ref: HeapType; nullable: boolean };
type NumberOrVectorType = "i32" | "i64" | "f32" | "f64" | "v128";
type ValueType = NumberOrVectorType | RefType;

/** Struct fields and array elements may also be packed integers. */
type StorageType = ValueType | "i8" | "i16";
type FieldType = { type: StorageType; mutable: boolean };
type StructType = { struct: FieldType[] };
type ArrayType = { array: FieldType };
type CompositeType = FunctionType | StructType | ArrayType;
/**
 * A type definition. Types are final unless `final: false`, and may declare a supertype, by index in
 * modules and as an object in builders.
 */
type TypeDefinition = CompositeType & { final?: false; supertype?: number | DefinedType };

/**
 * A defined type in builders. Types of a recursion group share `group`; a type outside of one is a
 * group of its own. Modules refer to defined types by index.
 */
type DefinedType = {
  kind: "type";
  type: TypeDefinition;
  group?: DefinedType[];
  name?: string;
  fieldNames?: string[];
  deps: DefinedType[];
};

/** Defined types that a definition refers to, through its fields, signature or supertype. */
function referencedTypes(type: TypeDefinition): DefinedType[] {
  const storage =
    "struct" in type
      ? type.struct.map((f) => f.type)
      : "array" in type
        ? [type.array.type]
        : [...type.args, ...type.results];
  const heaps: HeapType[] = storage.flatMap((t) => (typeof t === "object" ? [t.ref] : []));
  if (type.supertype !== undefined) heaps.push(type.supertype);
  return heaps.filter((h): h is DefinedType => typeof h === "object");
}

function compositeKind(type: CompositeType): "func" | "struct" | "array" {
  return "struct" in type ? "struct" : "array" in type ? "array" : "func";
}

function isFunctionType(type: CompositeType): type is FunctionType {
  return compositeKind(type) === "func";
}

function refType(heap: HeapType, nullable: boolean): RefType {
  if (nullable && typeof heap === "string") return shorthandOf.get(heap)!;
  return { ref: heap, nullable };
}

function isRefType(type: ValueType): type is RefType {
  return typeof type === "object" || type in shorthands;
}

/** The heap type and nullability of a reference type, including shorthands. */
function referenced(type: RefType): { ref: HeapType; nullable: boolean } {
  if (typeof type === "string") return { ref: shorthands[type], nullable: true };
  return type;
}

/**
 * The canonical form of a defined type: types are equal if they have the same position in recursion
 * groups of the same shape, where references within a group are relative.
 */
function typeKey(type: DefinedType): string {
  const group = type.group ?? [type];
  return `${groupKey(group)}[${group.indexOf(type)}]`;
}

const groupKeys = new WeakMap<DefinedType[], string>();
function groupKey(group: DefinedType[]): string {
  let key = groupKeys.get(group);
  if (key !== undefined) return key;
  const heap = (h: HeapType): string =>
    typeof h !== "object"
      ? String(h)
      : group.includes(h)
        ? `#${group.indexOf(h)}`
        : `{${typeKey(h)}}`;
  const value = (t: StorageType): string =>
    typeof t === "object" ? `(ref ${t.nullable ? "null " : ""}${heap(t.ref)})` : t;
  const field = ({ type, mutable }: FieldType) => `${mutable ? "mut " : ""}${value(type)}`;
  key = group
    .map(({ type }) => {
      const sub = `${type.final === false ? "sub " : ""}${type.supertype === undefined ? "" : `<${heap(type.supertype)}> `}`;
      if ("struct" in type) return `${sub}struct(${type.struct.map(field)})`;
      if ("array" in type) return `${sub}array(${field(type.array)})`;
      return `${sub}func(${type.args.map(value)})->(${type.results.map(value)})`;
    })
    .join(";");
  groupKeys.set(group, key);
  return key;
}

function heapTypeEquals(a: HeapType, b: HeapType): boolean {
  if (typeof a === "object" && typeof b === "object") return a === b || typeKey(a) === typeKey(b);
  return a === b;
}

function typeEquals(a: StorageType, b: StorageType): boolean {
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  return a.nullable === b.nullable && heapTypeEquals(a.ref, b.ref);
}

/** The abstract heap type of a defined type, by its composite kind. */
function abstractOf(heap: HeapType): AbstractHeapType {
  if (typeof heap === "string") return heap;
  // Without the module's types, an index is taken to refer to a function type.
  if (typeof heap === "number") return "func";
  return compositeKind(heap.type);
}

/** Abstract supertypes of each abstract heap type, other than itself. */
const abstractSupertypes: Record<AbstractHeapType, AbstractHeapType[]> = {
  any: [],
  eq: ["any"],
  i31: ["eq", "any"],
  struct: ["eq", "any"],
  array: ["eq", "any"],
  none: ["i31", "struct", "array", "eq", "any"],
  func: [],
  nofunc: ["func"],
  extern: [],
  noextern: ["extern"],
  exn: [],
  noexn: ["exn"],
};
const bottoms = new Set<HeapType>(["none", "nofunc", "noextern", "noexn"]);

function isHeapSubtype(a: HeapType, b: HeapType): boolean {
  if (heapTypeEquals(a, b)) return true;
  if (typeof b === "string")
    return abstractSupertypes[abstractOf(a)].includes(b) || abstractOf(a) === b;
  // b is a defined type: a is a subtype through declared supertypes, or a bottom type of its hierarchy.
  if (typeof a === "string") return bottoms.has(a) && abstractSupertypes[a].includes(abstractOf(b));
  if (typeof a === "number") return false;
  const supertype = a.type.supertype;
  return supertype !== undefined && isHeapSubtype(supertype, b);
}

/**
 * Whether a value of type `a` can be used as one of type `b`. Non-null references are subtypes of
 * nullable ones; heap types follow the abstract hierarchy and declared supertypes.
 */
function isSubtype(a: StorageType, b: StorageType): boolean {
  if (typeEquals(a, b)) return true;
  if (typeof a === "string" && !(a in shorthands)) return false;
  if (typeof b === "string" && !(b in shorthands)) return false;
  const [sub, sup] = [referenced(a as RefType), referenced(b as RefType)];
  if (sub.nullable && !sup.nullable) return false;
  return isHeapSubtype(sub.ref, sup.ref);
}

function printValueType(type: StorageType): string {
  if (typeof type !== "object") return type;
  const heap =
    typeof type.ref === "object"
      ? (type.ref.name ?? printComposite(type.ref.type))
      : String(type.ref);
  return `(ref ${type.nullable ? "null " : ""}${heap})`;
}

function printComposite(type: CompositeType): string {
  if ("struct" in type) return `struct`;
  if ("array" in type) return `array`;
  return printFunctionType(type);
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

const valueTypeCodes: Record<NumberOrVectorType, number> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
};
const i32t = valueType("i32");
const i64t = valueType("i64");
const f32t = valueType("f32");
const f64t = valueType("f64");
const v128t = valueType("v128");
const funcref = valueType("funcref");
const externref = valueType("externref");
const exnref = valueType("exnref");
const anyref = valueType("anyref");
const eqref = valueType("eqref");
const i31ref = valueType("i31ref");
const structref = valueType("structref");
const arrayref = valueType("arrayref");
const nullref = valueType("nullref");
const nullfuncref = valueType("nullfuncref");
const nullexternref = valueType("nullexternref");
const nullexnref = valueType("nullexnref");

const codeToValueType = invertRecord(valueTypeCodes);

/**
 * Abstract heap types encode as negative s33 values. As single bytes, these are also the codes of the
 * shorthand reference types, such as 0x70 for funcref.
 */
const heapTypeCodes: Record<AbstractHeapType, number> = {
  func: -0x10,
  extern: -0x11,
  any: -0x12,
  eq: -0x13,
  i31: -0x14,
  struct: -0x15,
  array: -0x16,
  exn: -0x17,
  none: -0x0f,
  nofunc: -0x0d,
  noextern: -0x0e,
  noexn: -0x0c,
};
const codeToHeapType = invertRecord(heapTypeCodes);

/** Heap types: an s33, negative for abstract heap types, a type index otherwise. */
const HeapType = Binable<HeapType>({
  writeBytes(output, heap) {
    if (typeof heap === "object") throw Error("HeapType: defined type has no index yet");
    S33.writeBytes(output, typeof heap === "number" ? heap : heapTypeCodes[heap]);
  },
  readBytes(input) {
    let code = S33.readBytes(input);
    if (code >= 0) return code;
    let heap = codeToHeapType.get(code);
    if (heap === undefined) throw Error(`malformed heap type ${code}`);
    return heap;
  },
});

type ValueTypeObject = { kind: ValueType };
const ValueType = Binable<ValueType>({
  writeBytes(output, type) {
    if (typeof type === "object") {
      writeByte(output, type.nullable ? 0x63 : 0x64);
      HeapType.writeBytes(output, type.ref);
    } else if (type in shorthands)
      S33.writeBytes(output, heapTypeCodes[shorthands[type as Shorthand]]);
    else {
      let code = valueTypeCodes[type as NumberOrVectorType];
      if (code === undefined) throw Error(`Invalid value type ${type}`);
      writeByte(output, code);
    }
  },
  readBytes(input) {
    let code = readByte(input);
    if (code === 0x63 || code === 0x64) return refType(HeapType.readBytes(input), code === 0x63);
    let type = codeToValueType.get(code);
    if (type !== undefined) return type;
    let heap = codeToHeapType.get(code - 0x80);
    if (heap === undefined) throw Error(`Invalid value type code ${code.toString(16)}.`);
    return refType(heap, true);
  },
});

type RefTypeObject = { kind: RefType };
const RefType = Binable<RefType>({
  writeBytes(output, t) {
    ValueType.writeBytes(output, t);
  },
  readBytes(input) {
    let type = ValueType.readBytes(input);
    if (!isRefType(type)) throw Error("invalid reftype");
    return type;
  },
});

type GlobalType<T = ValueType> = { value: T; mutable: boolean };
const GlobalType = record<GlobalType>({ value: ValueType, mutable: Bool });

type AddressType = "i32" | "i64";
/** Limits of a memory or table. A 64-bit address type is recorded as `address: "i64"`, as in the JS API. */
type Limits = { min: U64; max?: U64; shared: boolean; address?: "i64" };
const Limits = Binable<Limits>({
  writeBytes(output, { min, max, shared, address }) {
    writeByte(output, (max === undefined ? 0 : 1) | (shared ? 2 : 0) | (address === "i64" ? 4 : 0));
    let Size = address === "i64" ? U64 : U32;
    Size.writeBytes(output, min);
    if (max !== undefined) Size.writeBytes(output, max);
  },
  readBytes(input) {
    let flags = readByte(input);
    if (flags > 7) throw Error("invalid limit type");
    let Size = flags & 4 ? U64 : U32;
    let min = Size.readBytes(input);
    let max = flags & 1 ? Size.readBytes(input) : undefined;
    let limits: Limits = { min, max, shared: (flags & 2) !== 0 };
    if (flags & 4) limits.address = "i64";
    return limits;
  },
});

function addressType(limits: Limits): AddressType {
  return limits.address ?? "i32";
}

/** A tag's type is the index of a function type without results; the attribute 0 marks exceptions. */
type TagType = TypeIndex;
const TagType = withByteCode(0x00, U32);

type MemoryType = { limits: Limits };
const MemoryType = record<MemoryType>({ limits: Limits });

type TableType = { type: RefType; limits: Limits };
const TableType = record<TableType>({ type: RefType, limits: Limits });

const ResultType = vec(ValueType);

/** Storage types add the packed integers i8 and i16 to value types. */
const StorageType = Binable<StorageType>({
  writeBytes(output, type) {
    if (type === "i8") writeByte(output, 0x78);
    else if (type === "i16") writeByte(output, 0x77);
    else ValueType.writeBytes(output, type);
  },
  readBytes(input) {
    let code = input.bytes[input.offset];
    if (code === 0x78 || code === 0x77) {
      input.offset++;
      return code === 0x78 ? "i8" : "i16";
    }
    return ValueType.readBytes(input);
  },
});

const FieldType = Binable<FieldType>({
  writeBytes(output, { type, mutable }) {
    StorageType.writeBytes(output, type);
    writeByte(output, mutable ? 1 : 0);
  },
  readBytes(input) {
    let type = StorageType.readBytes(input);
    let mutability = readByte(input);
    if (mutability > 1) throw Error("malformed mutability");
    return { type, mutable: mutability === 1 };
  },
});

const StructFields = vec(FieldType);

/** Composite types: functions (0x60), structs (0x5f) and arrays (0x5e). */
const CompositeType = Binable<CompositeType>({
  writeBytes(output, type) {
    if ("struct" in type) {
      writeByte(output, 0x5f);
      StructFields.writeBytes(output, type.struct);
    } else if ("array" in type) {
      writeByte(output, 0x5e);
      FieldType.writeBytes(output, type.array);
    } else FunctionType.writeBytes(output, { args: type.args, results: type.results });
  },
  readBytes(input) {
    let code = input.bytes[input.offset];
    if (code === 0x5f || code === 0x5e) input.offset++;
    if (code === 0x5f) return { struct: StructFields.readBytes(input) };
    if (code === 0x5e) return { array: FieldType.readBytes(input) };
    if (code !== 0x60) throw Error(`malformed composite type ${code?.toString(16)}`);
    return FunctionType.readBytes(input);
  },
});

const Supertypes = vec(U32);

/**
 * Type definitions: a composite type, which is final, or a subtype (0x50, non-final; 0x4f, final)
 * with its supertypes. wasmati supports at most one supertype, as validation requires.
 */
const TypeDefinition = Binable<TypeDefinition>({
  writeBytes(output, type) {
    let { final, supertype, ...composite } = type;
    if (final === false || supertype !== undefined) {
      if (typeof supertype === "object") throw Error("TypeDefinition: supertype has no index yet");
      writeByte(output, final === false ? 0x50 : 0x4f);
      Supertypes.writeBytes(output, supertype === undefined ? [] : [supertype]);
    }
    CompositeType.writeBytes(output, composite);
  },
  readBytes(input) {
    let code = input.bytes[input.offset];
    if (code !== 0x50 && code !== 0x4f) return CompositeType.readBytes(input);
    input.offset++;
    let supertypes = Supertypes.readBytes(input);
    if (supertypes.length > 1) throw Error("multiple supertypes are not supported");
    let type: TypeDefinition = { ...CompositeType.readBytes(input) };
    if (code === 0x50) type.final = false;
    if (supertypes.length === 1) type.supertype = supertypes[0];
    return type;
  },
});

const RecGroup = vec(TypeDefinition);

/** A recursion group (0x4e), or a single type definition, which forms a group of its own. */
const RecType = Binable<TypeDefinition[]>({
  writeBytes(output, group) {
    if (group.length === 1) return TypeDefinition.writeBytes(output, group[0]);
    writeByte(output, 0x4e);
    RecGroup.writeBytes(output, group);
  },
  readBytes(input) {
    if (input.bytes[input.offset] !== 0x4e) return [TypeDefinition.readBytes(input)];
    input.offset++;
    return RecGroup.readBytes(input);
  },
});

type FunctionType = { args: ValueType[]; results: ValueType[] };
const FunctionType = withByteCode(
  0x60,
  record<FunctionType>({ args: ResultType, results: ResultType }),
);

type IndexSpace =
  "type" | "function" | "table" | "memory" | "global" | "elem" | "data" | "local" | "label" | "tag";
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
type TagIndex = U32;
const TagIndex = index("tag");

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
