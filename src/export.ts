import { Binable, byteEnum, record } from "./binable.ts";
import { Name, U32 } from "./immediate.ts";
import {
  FunctionType,
  type Type,
  GlobalType,
  type JSValue,
  MemoryType,
  TableType,
  TypeIndex,
  ValueType,
  valueTypeLiteral,
  valueTypeLiterals,
} from "./types.ts";
import type { JSFunction, ToTypeTuple } from "./func.ts";
import type { Tuple } from "./util.ts";
import * as Dependency from "./dependency.ts";
import type { Parameters, ParameterEntry } from "./parameters.ts";
import type { ImportFunc } from "./func-types.ts";
import { dataConstructor } from "./memory.ts";

export { Export, Import, type ExternType, importFunc, importGlobal, importMemory, importTable };

type ExternType =
  | { kind: "function"; value: FunctionType }
  | { kind: "table"; value: TableType }
  | { kind: "memory"; value: MemoryType }
  | { kind: "global"; value: GlobalType };

type ExportDescription = {
  kind: "function" | "table" | "memory" | "global";
  value: U32;
};
const ExportDescription: Binable<ExportDescription> = byteEnum<{
  0x00: { kind: "function"; value: U32 };
  0x01: { kind: "table"; value: U32 };
  0x02: { kind: "memory"; value: U32 };
  0x03: { kind: "global"; value: U32 };
}>({
  0x00: { kind: "function", value: U32 },
  0x01: { kind: "table", value: U32 },
  0x02: { kind: "memory", value: U32 },
  0x03: { kind: "global", value: U32 },
});

type Export = { name: string; description: ExportDescription };
const Export = record({ name: Name, description: ExportDescription });

type ImportDescription =
  | { kind: "function"; value: TypeIndex }
  | { kind: "table"; value: TableType }
  | { kind: "memory"; value: MemoryType }
  | { kind: "global"; value: GlobalType };
const ImportDescription: Binable<ImportDescription> = byteEnum<{
  0x00: { kind: "function"; value: TypeIndex };
  0x01: { kind: "table"; value: TableType };
  0x02: { kind: "memory"; value: MemoryType };
  0x03: { kind: "global"; value: GlobalType };
}>({
  0x00: { kind: "function", value: TypeIndex },
  0x01: { kind: "table", value: TableType },
  0x02: { kind: "memory", value: MemoryType },
  0x03: { kind: "global", value: GlobalType },
});

type Import = {
  module: string;
  name: string;
  description: ImportDescription;
};
const Import = record<Import>({
  module: Name,
  name: Name,
  description: ImportDescription,
});

/** Declare a typed native JS import. module/field optionally override its automatically assigned import path. */
function importFunc<
  const Args extends readonly ParameterEntry[] = [],
  const Results extends Tuple<ValueType> = [],
>(
  {
    name: inputName,
    in: args_,
    out: results_,
    module,
    field,
  }: {
    name?: string;
    in: Parameters<Args>;
    out: ToTypeTuple<Results>;
  } & Dependency.ImportPath,
  run: NoInfer<JSFunction<ImportFunc<Parameters<Args>, Results>>>,
): ImportFunc<Parameters<Args>, Results> {
  const type = { args: args_.types, results: valueTypeLiterals<Results>(results_) };
  const name = inputName ?? (run.name || undefined);
  return {
    kind: "importFunction",
    module,
    field,
    params: args_,
    type,
    deps: [],
    value: run,
    ...(name === undefined ? {} : { name }),
  };
}

function importGlobal<V extends ValueType>(
  type: Type<V>,
  value: JSValue<V> | WebAssembly.Global,
  { mutable = false, module, field }: { mutable?: boolean } & Dependency.ImportPath = {},
): Dependency.ImportGlobal<V> {
  let globalType = { value: valueTypeLiteral(type), mutable };
  let valueType: WebAssembly.ValueType = type.kind === "funcref" ? "anyfunc" : type.kind;
  let value_ =
    value instanceof WebAssembly.Global
      ? value
      : new WebAssembly.Global({ value: valueType, mutable }, value);
  return { kind: "importGlobal", module, field, type: globalType, deps: [], value: value_ };
}

function importMemory(
  {
    min,
    max,
    shared = false,
    module,
    field,
  }: {
    min: number;
    max?: number;
    shared?: boolean;
  } & Dependency.ImportPath,
  memory?: WebAssembly.Memory,
  ...content: (number[] | Uint8Array)[]
) {
  let type = { limits: { min, max, shared } };
  let value = memory ?? new WebAssembly.Memory({ initial: min, maximum: max, shared });
  let memory_: Dependency.ImportMemory = {
    kind: "importMemory",
    module,
    field,
    type,
    deps: [],
    value,
  };
  let offset = 0;
  for (let init of content) {
    dataConstructor({ memory: memory_, offset: Dependency.Const.i32(offset) }, init);
    offset += init.length;
  }
  return memory_;
}

/** Import an existing table, retaining its identity and element-segment dependencies. */
function importTable(
  {
    type,
    min,
    max,
    module,
    field,
  }: { type: Type<"funcref" | "externref">; min: number; max?: number } & Dependency.ImportPath,
  value: WebAssembly.Table,
): Dependency.ImportTable {
  return {
    kind: "importTable",
    module,
    field,
    type: { type: type.kind, limits: { min, max, shared: false } },
    value,
    deps: [],
  };
}
