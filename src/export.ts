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

export { Export, Import, type ExternType, importFunc, importGlobal, importMemory };

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

/** Declare a native JS import with ordered named parameters and a return type checked against its Wasm results. */
function importFunc<
  const Args extends readonly ParameterEntry[] = [],
  const Results extends Tuple<ValueType> = [],
>(
  {
    name: inputName,
    in: args_,
    out: results_,
  }: {
    name?: string;
    in: Parameters<Args>;
    out: ToTypeTuple<Results>;
  },
  run: NoInfer<JSFunction<ImportFunc<Parameters<Args>, Results>>>,
): ImportFunc<Parameters<Args>, Results> {
  const type = { args: args_.types, results: valueTypeLiterals<Results>(results_) };
  const name = inputName ?? (run.name || undefined);
  return {
    kind: "importFunction",
    params: args_,
    type,
    deps: [],
    value: run,
    ...(name === undefined ? {} : { name }),
  };
}

function importGlobal<V extends ValueType>(
  type: Type<V>,
  value: JSValue<V>,
  { mutable = false } = {},
): Dependency.ImportGlobal<V> {
  let globalType = { value: valueTypeLiteral(type), mutable };
  let valueType: WebAssembly.ValueType = type.kind === "funcref" ? "anyfunc" : type.kind;
  let value_ = new WebAssembly.Global({ value: valueType, mutable }, value);
  return { kind: "importGlobal", type: globalType, deps: [], value: value_ };
}

function importMemory(
  {
    min,
    max,
    shared = false,
  }: {
    min: number;
    max?: number;
    shared?: boolean;
  },
  memory?: WebAssembly.Memory,
  ...content: (number[] | Uint8Array)[]
) {
  let type = { limits: { min, max, shared } };
  let value = memory ?? new WebAssembly.Memory({ initial: min, maximum: max, shared });
  let memory_: Dependency.ImportMemory = {
    kind: "importMemory",
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
