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
  toBytes(imports) {
    return vec(Import).toBytes(imports);
  },
  readBytes(bytes, offset) {
    let imports: Import[] = [];
    let count: number;
    [count, offset] = U32.readBytes(bytes, offset);
    for (let i = 0; i < count; i++) {
      let module: string, name: string;
      [module, offset] = Name.readBytes(bytes, offset);
      [name, offset] = Name.readBytes(bytes, offset);
      let encoding = name === "" ? bytes[offset] : undefined;
      if (encoding === 0x7f) {
        let items: { name: string; description: ImportDescription }[];
        [items, offset] = vec(CompactItem).readBytes(bytes, offset + 1);
        imports.push(...items.map((item) => ({ module, ...item })));
      } else if (encoding === 0x7e) {
        let description: ImportDescription, names: string[];
        [description, offset] = ImportDescription.readBytes(bytes, offset + 1);
        [names, offset] = vec(Name).readBytes(bytes, offset);
        imports.push(...names.map((name) => ({ module, name, description })));
      } else {
        let description: ImportDescription;
        [description, offset] = ImportDescription.readBytes(bytes, offset);
        imports.push({ module, name, description });
      }
    }
    return [imports, offset];
  },
});
const CompactItem = record({ name: Name, description: ImportDescription });

/** Declare a typed native JS import. module/field optionally override its automatically assigned import path. */
function importFunc<
  const Args extends readonly ParameterInput[] = [],
  const Results extends Tuple<ValueType> = [],
  const Suspending extends boolean = false,
>(
  {
    name: inputName,
    in: entries,
    out: results_,
    type: definedType,
    suspending,
    module,
    field,
  }: {
    name?: string;
    in: CheckedParameters<Args>;
    out: ToTypeTuple<Results>;
    /** An explicit function type, such as a subtype; it must match the signature. */
    type?: DefinedType;
    /**
     * The function may return a promise, which suspends Wasm until it resolves (JSPI). Wasm must be
     * entered through a promising export.
     */
    suspending?: Suspending;
  } & Dependency.ImportPath,
  run: NoInfer<
    Suspending extends true
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
    value: suspending ? new WebAssembly.Suspending(run) : run,
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
  let value_ = new WebAssembly.Global({ value: valueType, mutable }, value);
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
  let tag = value ?? new WebAssembly.Tag({ parameters });
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
    dataConstructor({ memory: memory_, offset }, init);
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
