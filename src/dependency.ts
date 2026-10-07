import type {} from "./js-api.ts";
/**
 * interfaces for declaring functions/globals/etc stand-alone (without reference to a module)
 * that keep track of their dependencies. Declaring them as the exports of a module
 * should enable to automatically include all dependencies in that module and determine
 * indices for them.
 */

import {
  type DefinedType,
  FunctionType,
  GlobalType,
  MemoryType,
  referenced,
  referencedTypes,
  refType,
  RefType,
  TableType,
  type TypeDefinition,
  ValueType,
} from "./types.ts";
import type { Parameters } from "./parameters.ts";
import { Byte } from "./binable.ts";
import type { F32, F64 } from "./immediate.ts";
import {
  toV128Bytes,
  type ShapeLength,
  type ShapeType,
  type V128,
  type VectorShape,
} from "./v128.ts";
import type { TupleN } from "./util.ts";

export {
  type t,
  type Export,
  type anyDependency,
  type Type,
  type,
  type Func,
  type HasRefTo,
  type Global,
  type Table,
  type Memory,
  type HasMemory,
  type Data,
  type Elem,
  type ImportFunc,
  type ImportGlobal,
  type ImportTable,
  type ImportMemory,
  type Tag,
  type ImportTag,
  type AnyTag,
  type AnyFunc,
  type AnyGlobal,
  type AnyMemory,
  type AnyTable,
  type AnyImport,
  type ImportPath,
  type Offset,
  type Instruction,
  type Constant,
};
export { hasRefTo, hasMemory, dependencyKinds, kindToExportKind, typeOf };

type anyDependency = { kind: string; deps: anyDependency[] };

type Export = AnyFunc | AnyGlobal | AnyMemory | AnyTable | AnyTag;

type t =
  | Type
  | Tag
  | ImportTag
  | Func
  | HasRefTo
  | Global
  | Table
  | Memory
  | HasMemory
  | Data
  | Elem
  | ImportFunc
  | ImportGlobal
  | ImportTable
  | ImportMemory;

/** A defined type. Function types that are only described by their signature form a group of their own. */
type Type = DefinedType;
function type(type: TypeDefinition): Type {
  return { kind: "type", type, deps: referencedTypes(type) };
}

/** The defined type of a function: declared explicitly, or given by its signature. */
function typeOf(func: AnyFunc | AnyTag): Type {
  return func.definedType ?? type(func.type);
}

type Func = {
  kind: "function";
  params: Parameters;
  name?: string;
  localNames?: Record<number, string>;
  type: FunctionType;
  /** An explicit type, such as a subtype or a type of a recursion group. */
  definedType?: DefinedType;
  locals: ValueType[];
  body: Instruction[];
  deps: t[];
  defined: boolean;
};
type HasRefTo = { kind: "hasRefTo"; value: AnyFunc; deps: [] };
function hasRefTo(value: AnyFunc): HasRefTo {
  return { kind: "hasRefTo", value, deps: [] };
}

type Global<T extends ValueType = ValueType> = {
  kind: "global";
  type: GlobalType<T>;
  init: Constant<T>;
  deps: (AnyGlobal | AnyFunc)[];
};

type Table = {
  kind: "table";
  type: TableType;
  /** Initial value of every element, null by default. */
  init?: Constant<RefType>;
  deps: (Elem | AnyFunc | AnyGlobal)[];
};
type Memory = {
  kind: "memory";
  type: MemoryType;
  deps: Data[];
};
type HasMemory = { kind: "hasMemory"; deps: [] };
const hasMemory: HasMemory = { kind: "hasMemory", deps: [] };

type Data = {
  kind: "data";
  init: Byte[];
  /** Active segments without a memory use the default memory. */
  mode: "passive" | { memory: AnyMemory | undefined; offset: Offset };
  deps: (HasMemory | AnyGlobal | AnyMemory)[];
};

/** Segment offsets have the address type of their memory or table. */
type Offset = Constant<"i32" | "i64">;

type Elem = {
  kind: "elem";
  type: RefType;
  init: Constant<RefType>[];
  mode:
    | "passive"
    | "declarative"
    | {
        table: AnyTable;
        offset: Offset;
      };
  deps: (AnyTable | AnyFunc | AnyGlobal)[];
};

/** Optional Wasm import path overrides; omitted paths use the generated module/field names. */
type ImportPath = { module?: string; field?: string };
type ImportFunc = ImportPath & {
  kind: "importFunction";
  name?: string;
  params: Parameters;
  type: FunctionType;
  /** An explicit type, such as a subtype or a type of a recursion group. */
  definedType?: DefinedType;
  value: Function;
  /** An async import, which suspends Wasm until its promise resolves (JSPI). */
  async?: true;
  deps: DefinedType[];
};
type ImportGlobal<T = ValueType> = ImportPath & {
  kind: "importGlobal";
  type: GlobalType<T>;
  value: WebAssembly.Global;
  deps: [];
};
type ImportTable = ImportPath & {
  kind: "importTable";
  type: TableType;
  value: WebAssembly.Table;
  deps: Elem[];
};
type ImportMemory = ImportPath & {
  kind: "importMemory";
  type: MemoryType;
  value: WebAssembly.Memory;
  deps: Data[];
};

/** An exception tag, whose type lists the values an exception carries. */
type Tag = { kind: "tag"; type: FunctionType; definedType?: DefinedType; deps: [] };
type ImportTag = ImportPath & {
  kind: "importTag";
  type: FunctionType;
  definedType?: DefinedType;
  value: WebAssembly.Tag;
  deps: [];
};
type AnyTag = Tag | ImportTag;

type AnyFunc = Func | ImportFunc;
type AnyGlobal<T extends ValueType = ValueType> = Global<T> | ImportGlobal<T>;
type AnyTable = Table | ImportTable;
type AnyMemory = Memory | ImportMemory;
type AnyImport = ImportFunc | ImportGlobal | ImportTable | ImportMemory | ImportTag;

const dependencyKinds = [
  "function",
  "type",
  "hasRefTo",
  "global",
  "table",
  "memory",
  "hasMemory",
  "data",
  "elem",
  "importFunction",
  "importGlobal",
  "importTable",
  "importMemory",
  "tag",
  "importTag",
] as const satisfies readonly t["kind"][];

const kindToExportKind: Record<
  (AnyFunc | AnyGlobal | AnyTable | AnyMemory | AnyTag)["kind"],
  (Func | Global | Table | Memory | Tag)["kind"]
> = {
  tag: "tag",
  importTag: "tag",
  function: "function",
  importFunction: "function",
  global: "global",
  importGlobal: "global",
  memory: "memory",
  importMemory: "memory",
  table: "table",
  importTable: "table",
};

// general instruction

type Instruction = {
  string: string;
  type: FunctionType;
  deps: t[];
  resolveArgs: any[];
  /** A branch hint, on `if` and `br_if`. */
  likely?: boolean;
};

/** A constant expression: instructions that produce one value, such as a global's initializer. */
type Constant<T extends ValueType = ValueType> = {
  kind: "constant";
  type: T;
  body: Instruction[];
  deps: t[];
};
