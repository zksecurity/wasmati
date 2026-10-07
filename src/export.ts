import { Binable, byteEnum, record } from "./binable.ts";
import { Name, U32, type U64 } from "./immediate.ts";
import {
  type AddressType,
  FunctionType,
  isRefType,
  printValueType,
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
import {
  createParameters,
  type ParameterInput,
  type ParameterSchema,
  type CheckedParameters,
} from "./parameters.ts";
import type { ImportFunc } from "./func-types.ts";
import { constOffset, dataConstructor, jsLimits, limits } from "./memory.ts";

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
  const Args extends readonly ParameterInput[] = [],
  const Results extends Tuple<ValueType> = [],
>(
  {
    name: inputName,
    in: entries,
    out: results_,
    module,
    field,
  }: {
    name?: string;
    in: CheckedParameters<Args>;
    out: ToTypeTuple<Results>;
  } & Dependency.ImportPath,
  run: NoInfer<JSFunction<ImportFunc<ParameterSchema<Args>, Results>>>,
): ImportFunc<ParameterSchema<Args>, Results> {
  const args_ = createParameters<Args>(entries);
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
  let kind = type.kind;
  if (value instanceof WebAssembly.Global)
    return { kind: "importGlobal", module, field, type: globalType, deps: [], value };
  // Like instantiation, accept only globals or plain values: other objects cannot be numbers.
  let isObject = typeof value === "object" || typeof value === "function";
  if (!isRefType(kind) && isObject)
    throw new WebAssembly.LinkError(`importGlobal: expected a global or a number, got ${value}`);
  // The JS API creates globals of numbers, vectors, funcref and externref only.
  if (typeof kind === "object")
    throw new WebAssembly.LinkError(
      `importGlobal: a global of type ${printValueType(kind)} must be a WebAssembly.Global`,
    );
  let valueType: WebAssembly.ValueType = kind === "funcref" ? "anyfunc" : kind;
  let value_ = new WebAssembly.Global({ value: valueType, mutable }, value);
  return { kind: "importGlobal", module, field, type: globalType, deps: [], value: value_ };
}

function importMemory(
  {
    min,
    max,
    shared = false,
    address = "i32",
    module,
    field,
  }: {
    min: U64;
    max?: U64;
    shared?: boolean;
    address?: AddressType;
  } & Dependency.ImportPath,
  memory?: WebAssembly.Memory,
  ...content: (number[] | Uint8Array)[]
) {
  let type = { limits: limits(min, max, shared, address) };
  let value = memory ?? new WebAssembly.Memory(jsLimits({ min, max, shared, address }));
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
    dataConstructor({ memory: memory_, offset: constOffset(address, offset) }, init);
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
    address = "i32",
    module,
    field,
  }: {
    type: Type<"funcref" | "externref">;
    min: U64;
    max?: U64;
    address?: AddressType;
  } & Dependency.ImportPath,
  value: WebAssembly.Table,
): Dependency.ImportTable {
  return {
    kind: "importTable",
    module,
    field,
    type: { type: type.kind, limits: limits(min, max, false, address) },
    value,
    deps: [],
  };
}
