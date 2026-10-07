/**
 * interfaces for declaring functions/globals/etc stand-alone (without reference to a module)
 * that keep track of their dependencies. Declaring them as the exports of a module
 * should enable to automatically include all dependencies in that module and determine
 * indices for them.
 */

import {
  type AddressType,
  FunctionType,
  GlobalType,
  MemoryType,
  RefType,
  TableType,
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
  type AnyFunc,
  type AnyGlobal,
  type AnyMemory,
  type AnyTable,
  type AnyImport,
  type ImportPath,
  type Offset,
  type Instruction,
  Const,
};
export { hasRefTo, hasMemory, dependencyKinds, kindToExportKind };

type anyDependency = { kind: string; deps: anyDependency[] };

type Export = AnyFunc | AnyGlobal | AnyMemory | AnyTable;

type t =
  | Type
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

type Type = { kind: "type"; type: FunctionType; deps: [] };
function type(type: FunctionType): Type {
  return { kind: "type", type, deps: [] };
}

type Func = {
  kind: "function";
  params: Parameters;
  name?: string;
  localNames?: Record<number, string>;
  type: FunctionType;
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
  init: Const.t<T>;
  deps: (AnyGlobal | AnyFunc)[];
};

/** Memories and tables record their address type, which types the addresses and sizes of their instructions. */
type Table<A extends AddressType = AddressType> = {
  kind: "table";
  type: TableType;
  address: A;
  deps: Elem[];
};
type Memory<A extends AddressType = AddressType> = {
  kind: "memory";
  type: MemoryType;
  address: A;
  deps: Data[];
};
type HasMemory = { kind: "hasMemory"; deps: [] };
const hasMemory: HasMemory = { kind: "hasMemory", deps: [] };

type Data = {
  kind: "data";
  init: Byte[];
  mode: "passive" | { memory: 0; offset: Offset };
  deps: (HasMemory | AnyGlobal | AnyMemory)[];
};

/** Segment offsets have the address type of their memory or table. */
type Offset = Const.i32 | Const.i64 | Const.globalGet<"i32"> | Const.globalGet<"i64">;

type Elem = {
  kind: "elem";
  type: RefType;
  init: (Const.refFunc | Const.refNull<RefType>)[];
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
  value: Function;
  deps: [];
};
type ImportGlobal<T = ValueType> = ImportPath & {
  kind: "importGlobal";
  type: GlobalType<T>;
  value: WebAssembly.Global;
  deps: [];
};
type ImportTable<A extends AddressType = AddressType> = ImportPath & {
  kind: "importTable";
  type: TableType;
  address: A;
  value: WebAssembly.Table;
  deps: Elem[];
};
type ImportMemory<A extends AddressType = AddressType> = ImportPath & {
  kind: "importMemory";
  type: MemoryType;
  address: A;
  value: WebAssembly.Memory;
  deps: Data[];
};

type AnyFunc = Func | ImportFunc;
type AnyGlobal<T extends ValueType = ValueType> = Global<T> | ImportGlobal<T>;
type AnyTable<A extends AddressType = AddressType> = Table<A> | ImportTable<A>;
type AnyMemory<A extends AddressType = AddressType> = Memory<A> | ImportMemory<A>;
type AnyImport = ImportFunc | ImportGlobal | ImportTable | ImportMemory;

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
] as const satisfies readonly t["kind"][];

const kindToExportKind: Record<
  (AnyFunc | AnyGlobal | AnyTable | AnyMemory)["kind"],
  (Func | Global | Table | Memory)["kind"]
> = {
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
};

// constant instructions

type ConstInstruction<T extends ValueType> = {
  string: string;
  type: { args: []; results: [T] };
  deps: t[];
  resolveArgs: any[];
};

namespace Const {
  export type i32 = ConstInstruction<"i32"> & { string: "i32.const" };
  export type i64 = ConstInstruction<"i64"> & { string: "i64.const" };
  export type f32 = ConstInstruction<"f32"> & { string: "f32.const" };
  export type f64 = ConstInstruction<"f64"> & { string: "f64.const" };
  export type v128 = ConstInstruction<"v128"> & { string: "v128.const" };
  export type refNull<T extends RefType> = ConstInstruction<T> & {
    string: "ref.null";
  };
  export type refFunc = ConstInstruction<"funcref"> & { string: "ref.func" };
  export type globalGet<T extends ValueType> = ConstInstruction<T> & {
    string: "global.get";
  };
  export type t_ = i32 | i64 | f32 | f64 | v128 | refNull<RefType> | refFunc | globalGet<ValueType>;
  export type t<T extends ValueType> = ConstInstruction<T> & {
    string: t_["string"];
  };
}

const Const = {
  i32(x: number | bigint): Const.i32 {
    return {
      string: "i32.const",
      type: { args: [], results: ["i32"] },
      deps: [],
      resolveArgs: [Number(x)],
    };
  },
  i64(x: number | bigint): Const.i64 {
    return {
      string: "i64.const",
      type: { args: [], results: ["i64"] },
      deps: [],
      resolveArgs: [BigInt(x)],
    };
  },
  f32(x: F32): Const.f32 {
    return {
      string: "f32.const",
      type: { args: [], results: ["f32"] },
      deps: [],
      resolveArgs: [x],
    };
  },
  f64(x: F64): Const.f64 {
    return {
      string: "f64.const",
      type: { args: [], results: ["f64"] },
      deps: [],
      resolveArgs: [x],
    };
  },
  v128<Shape extends VectorShape>(
    shape: Shape,
    value: TupleN<ShapeType[Shape], ShapeLength[Shape]>,
  ): Const.v128 {
    return {
      string: "v128.const",
      type: { args: [], results: ["v128"] },
      deps: [],
      resolveArgs: [toV128Bytes(...([shape, value] as V128))],
    };
  },
  refFuncNull: {
    string: "ref.null",
    type: { args: [], results: ["funcref"] },
    deps: [],
    resolveArgs: ["funcref"],
  } as Const.refNull<"funcref">,
  refExternNull: {
    string: "ref.null",
    type: { args: [], results: ["externref"] },
    deps: [],
    resolveArgs: ["externref"],
  } as Const.refNull<"externref">,
  refFunc(func: AnyFunc): Const.refFunc {
    return {
      string: "ref.func",
      type: { args: [], results: ["funcref"] },
      deps: [func],
      resolveArgs: [],
    };
  },
  globalGet<T extends ValueType>(global: AnyGlobal<T>): Const.globalGet<T> {
    if (global.type.mutable) throw Error("global in a const expression can not be mutable");
    return {
      string: "global.get",
      type: { args: [], results: [global.type.value] },
      deps: [global],
      resolveArgs: [],
    };
  },
};
