/**
 * interfaces for declaring functions stand-alone (without reference to a module)
 * that keep track of their dependencies. Declaring them as the exports of a module
 * should enable to automatically include all dependencies in that module and determine
 * indices for them.
 */

import {
  FunctionType,
  GlobalType,
  MemoryType,
  RefType,
  TableType,
  ValueType,
} from "./types.js";
import { Byte } from "./binable.js";

export {
  t,
  Export,
  anyDependency,
  Type,
  type,
  Func,
  HasRefTo,
  Global,
  Table,
  Memory,
  HasMemory,
  Data,
  Elem,
  ImportFunc,
  ImportGlobal,
  ImportTable,
  ImportMemory,
  AnyFunc,
  AnyGlobal,
  AnyMemory,
  AnyTable,
  AnyImport,
  Instruction,
  Const,
};
export { hasRefTo, hasMemory, dependencyKinds, kindToExportKind };

type anyDependency = { kind: string; deps: anyDependency[] };

type Export = AnyFunc | AnyGlobal<ValueType> | AnyMemory | AnyTable;

type t =
  | Type
  | Func
  | HasRefTo
  | Global<ValueType>
  | Table
  | Memory
  | HasMemory
  | Data
  | Elem
  | ImportFunc
  | ImportGlobal<ValueType>
  | ImportTable
  | ImportMemory;

type Type = { kind: "type"; type: FunctionType; deps: [] };
function type(type: FunctionType): Type {
  return { kind: "type", type, deps: [] };
}

type Func = {
  kind: "function";
  type: FunctionType;
  locals: ValueType[];
  body: Instruction[];
  deps: t[];
};
type HasRefTo = { kind: "hasRefTo"; value: AnyFunc; deps: [] };
function hasRefTo(value: AnyFunc): HasRefTo {
  return { kind: "hasRefTo", value, deps: [] };
}

type Global<T extends ValueType> = {
  kind: "global";
  type: GlobalType<T>;
  init: Const.t<T>;
  deps: (AnyGlobal<ValueType> | AnyFunc)[];
};

type Table = {
  kind: "table";
  type: TableType;
  deps: Elem[];
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
  mode: "passive" | { memory: 0; offset: Const.i32 | Const.globalGet<"i32"> };
  deps: (HasMemory | AnyGlobal<ValueType> | AnyMemory)[];
};

type Elem = {
  kind: "elem";
  type: RefType;
  init: (Const.refFunc | Const.refNull<RefType>)[];
  mode:
    | "passive"
    | "declarative"
    | {
        table: AnyTable;
        offset: Const.i32 | Const.globalGet<"i32">;
      };
  deps: (AnyTable | AnyFunc | AnyGlobal<ValueType>)[];
};

type ImportPath = { module?: string; string?: string };
type ImportFunc = ImportPath & {
  kind: "importFunction";
  type: FunctionType;
  value: Function;
  deps: [];
};
type ImportGlobal<T> = ImportPath & {
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

type AnyFunc = Func | ImportFunc;
type AnyGlobal<T extends ValueType> = Global<T> | ImportGlobal<T>;
type AnyTable = Table | ImportTable;
type AnyMemory = Memory | ImportMemory;
type AnyImport =
  | ImportFunc
  | ImportGlobal<ValueType>
  | ImportTable
  | ImportMemory;

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
  (AnyFunc | AnyGlobal<ValueType> | AnyTable | AnyMemory)["kind"],
  (Func | Global<ValueType> | Table | Memory)["kind"]
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
  export type refNull<T extends RefType> = ConstInstruction<T> & {
    string: "ref.null";
  };
  export type refFunc = ConstInstruction<"funcref"> & { string: "ref.func" };
  export type globalGet<T extends ValueType> = ConstInstruction<T> & {
    string: "global.get";
  };
  export type t_ =
    | i32
    | i64
    | f32
    | f64
    | refNull<RefType>
    | refFunc
    | globalGet<ValueType>;
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
  f32(x: number): Const.f32 {
    return {
      string: "f32.const",
      type: { args: [], results: ["f32"] },
      deps: [],
      resolveArgs: [x],
    };
  },
  f64(x: number): Const.f64 {
    return {
      string: "f64.const",
      type: { args: [], results: ["f64"] },
      deps: [],
      resolveArgs: [x],
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
  globalGet<T extends ValueType>(global: Global<T>): Const.globalGet<T> {
    if (global.type.mutable)
      throw Error("global in a const expression can not be mutable");
    return {
      string: "global.get",
      type: { args: [], results: [global.type.value] },
      deps: [global],
      resolveArgs: [],
    };
  },
};
