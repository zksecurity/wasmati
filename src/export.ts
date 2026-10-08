import type {} from "./js-api.ts";
import type { JSValues, ReturnValues } from "./func.ts";
import { Binable, byteEnum, record } from "./binable.ts";
import { Name, U32, type U64, vec } from "./immediate.ts";
import {
  type AddressType,
  type DefinedType,
  FunctionType,
  TagType,
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
  type ValueTypeObject,
} from "./types.ts";
import { explicitType, type JSFunction, type ToTypeTuple } from "./func.ts";
import type { Tuple } from "./util.ts";
import * as Dependency from "./dependency.ts";
import {
  createParameters,
  type ParameterInput,
  type ParameterSchema,
  type CheckedParameters,
} from "./parameters.ts";
import type { ImportFunc } from "./func-types.ts";
import { dataConstructor, jsLimits, limits } from "./memory.ts";

export {
  isCreated,
  asyncExport,
  type AsyncExport,
  Export,
  Import,
  Imports,
  type ExternType,
  importFunc,
  importGlobal,
  importMemory,
  importTable,
  importTag,
};

type ExternType =
  | { kind: "function"; value: FunctionType }
  | { kind: "table"; value: TableType }
  | { kind: "memory"; value: MemoryType }
  | { kind: "global"; value: GlobalType };

type ExportDescription = {
  kind: "function" | "table" | "memory" | "global" | "tag";
  value: U32;
};
const ExportDescription: Binable<ExportDescription> = byteEnum<{
  0x00: { kind: "function"; value: U32 };
  0x01: { kind: "table"; value: U32 };
  0x02: { kind: "memory"; value: U32 };
  0x03: { kind: "global"; value: U32 };
  0x04: { kind: "tag"; value: U32 };
}>({
  0x00: { kind: "function", value: U32 },
  0x01: { kind: "table", value: U32 },
  0x02: { kind: "memory", value: U32 },
  0x03: { kind: "global", value: U32 },
  0x04: { kind: "tag", value: U32 },
});

type Export = { name: string; description: ExportDescription };
const Export = record({ name: Name, description: ExportDescription });

type ImportDescription =
  | { kind: "function"; value: TypeIndex }
  | { kind: "table"; value: TableType }
  | { kind: "memory"; value: MemoryType }
  | { kind: "global"; value: GlobalType }
  | { kind: "tag"; value: TagType };
const ImportDescription: Binable<ImportDescription> = byteEnum<{
  0x00: { kind: "function"; value: TypeIndex };
  0x01: { kind: "table"; value: TableType };
  0x02: { kind: "memory"; value: MemoryType };
  0x03: { kind: "global"; value: GlobalType };
  0x04: { kind: "tag"; value: TagType };
}>({
  0x00: { kind: "function", value: TypeIndex },
  0x01: { kind: "table", value: TableType },
  0x02: { kind: "memory", value: MemoryType },
  0x03: { kind: "global", value: GlobalType },
  0x04: { kind: "tag", value: TagType },
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

/**
 * The import section's imports. Besides single imports, the compact encodings share one module name
 * among several items (0x7F), or also one description (0x7E); they decode into single imports.
 */
const Imports = Binable<Import[]>({
  writeBytes(output, imports) {
    vec(Import).writeBytes(output, imports);
  },
  readBytes(input) {
    let imports: Import[] = [];
    let count = U32.readBytes(input);
    for (let i = 0; i < count; i++) {
      let module = Name.readBytes(input);
      let name = Name.readBytes(input);
      let encoding = name === "" ? input.bytes[input.offset] : undefined;
      if (encoding === 0x7f) {
        input.offset++;
        let items = vec(CompactItem).readBytes(input);
        imports.push(...items.map((item) => ({ module, ...item })));
      } else if (encoding === 0x7e) {
        input.offset++;
        let description = ImportDescription.readBytes(input);
        let names = vec(Name).readBytes(input);
        imports.push(...names.map((name) => ({ module, name, description })));
      } else {
        imports.push({ module, name, description: ImportDescription.readBytes(input) });
      }
    }
    return imports;
  },
});
const CompactItem = record({ name: Name, description: ImportDescription });

/**
 * An async export, `exports: { run: async(run) }`: JS calls it asynchronously (JSPI). Wasm it enters may
 * wait for async imports, while the export returns a promise of its results. Only Wasm entered through
 * async exports can call async imports.
 */
type AsyncExport<F extends Dependency.Func = Dependency.Func> = { kind: "asyncExport"; func: F };

function asyncExport<F extends Dependency.Func>(func: F): AsyncExport<F> {
  return { kind: "asyncExport", func };
}

/** Import values that wasmati created, rather than the user; `wasmati build` can recreate them. */
const createdValues = new WeakSet<object>();
function created<T extends object>(value: T): T {
  createdValues.add(value);
  return value;
}
function isCreated(value: object) {
  return createdValues.has(value);
}

/** Declare a typed native JS import. module/field optionally override its automatically assigned import path. */
function importFunc<
  const Args extends readonly ParameterInput[] = [],
  const Results extends Tuple<ValueType> = [],
  const Async extends boolean = false,
>(
  {
    name: inputName,
    in: entries,
    out: results_,
    type: definedType,
    async: isAsync,
    module,
    field,
  }: {
    name?: string;
    in: CheckedParameters<Args>;
    out: ToTypeTuple<Results>;
    /** An explicit function type, such as a subtype; it must match the signature. */
    type?: DefinedType;
    /**
     * The function may return a promise: Wasm waits for it, suspended until it resolves (JSPI). Wasm
     * that calls it must be entered through an async export.
     */
    async?: Async;
  } & Dependency.ImportPath,
  run: NoInfer<
    Async extends true
      ? AsyncJSFunction<ImportFunc<ParameterSchema<Args>, Results>>
      : JSFunction<ImportFunc<ParameterSchema<Args>, Results>>
  >,
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
    ...explicitType(definedType, type),
    deps: [],
    value: run,
    ...(isAsync ? { async: true as const } : {}),
    ...(name === undefined ? {} : { name }),
  };
}

/** A JS function that may return a promise of its results. */
type AsyncJSFunction<T extends Dependency.AnyFunc> = (
  ...args: JSValues<T["type"]["args"]>
) => ReturnValues<T["type"]["results"]> | Promise<ReturnValues<T["type"]["results"]>>;

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
  if (typeof kind === "object" || (isRefType(kind) && kind !== "funcref" && kind !== "externref"))
    throw new WebAssembly.LinkError(
      `importGlobal: a global of type ${printValueType(kind)} must be a WebAssembly.Global`,
    );
  let valueType = (kind === "funcref" ? "anyfunc" : kind) as WebAssembly.ValueType;
  let value_ = created(new WebAssembly.Global({ value: valueType, mutable }, value));
  return { kind: "importGlobal", module, field, type: globalType, deps: [], value: value_ };
}

/** Import an exception tag, by default a new WebAssembly.Tag with the given parameter types. */
function importTag(
  {
    in: args = [],
    type: definedType,
    module,
    field,
  }: { in?: ValueTypeObject[]; type?: DefinedType } & Dependency.ImportPath,
  value?: WebAssembly.Tag,
): Dependency.ImportTag {
  let type = { args: valueTypeLiterals(args), results: [] };
  let parameters = type.args.map((t) =>
    t === "funcref" ? "anyfunc" : t,
  ) as WebAssembly.ValueType[];
  let tag = value ?? created(new WebAssembly.Tag({ parameters }));
  return {
    kind: "importTag",
    module,
    field,
    type,
    ...explicitType(definedType, type),
    value: tag,
    deps: [],
  };
}

function importMemory<A extends AddressType = "i32">(
  {
    min,
    max,
    shared = false,
    address = "i32" as A,
    module,
    field,
  }: {
    min: U64;
    max?: U64;
    shared?: boolean;
    address?: A;
  } & Dependency.ImportPath,
  memory?: WebAssembly.Memory,
  ...content: (number[] | Uint8Array)[]
) {
  let type = { limits: limits(min, max, shared, address) };
  let value = memory ?? created(new WebAssembly.Memory(jsLimits({ min, max, shared, address })));
  let memory_: Dependency.ImportMemory<A> = {
    kind: "importMemory",
    module,
    field,
    type,
    address,
    deps: [],
    value,
  };
  let offset = 0;
  for (let init of content) {
    dataConstructor({ memory: memory_, offset }, init);
    offset += init.length;
  }
  return memory_;
}

/** Import an existing table, retaining its identity and element-segment dependencies. */
function importTable<A extends AddressType = "i32">(
  {
    type,
    min,
    max,
    address = "i32" as A,
    module,
    field,
  }: {
    type: Type<"funcref" | "externref">;
    min: U64;
    max?: U64;
    address?: A;
  } & Dependency.ImportPath,
  value: WebAssembly.Table,
): Dependency.ImportTable<A> {
  return {
    kind: "importTable",
    module,
    field,
    type: { type: type.kind, limits: limits(min, max, false, address) },
    address,
    value,
    deps: [],
  };
}
