import { constantOf, constantOffset, type ConstantInput } from "./constant.ts";
import { explicitType } from "./func.ts";
import { uint64, type U64 } from "./immediate.ts";
import * as Dependency from "./dependency.ts";
import {
  type AddressType,
  type DefinedType,
  type Limits,
  RefType,
  type RefTypeObject,
  valueTypeLiteral,
  valueTypeLiterals,
  type ValueTypeObject,
} from "./types.ts";

export {
  tagConstructor,
  memoryConstructor,
  dataConstructor,
  tableConstructor,
  elemConstructor,
  limits,
  jsLimits,
};

function addressOf(limits: Limits | undefined): AddressType {
  return limits?.address ?? "i32";
}

/** An exception tag; exceptions with it carry values of the given types. */
function tagConstructor({
  in: args = [],
  type: definedType,
}: {
  in?: ValueTypeObject[];
  /** An explicit function type, such as a type of a recursion group; it must match the parameters. */
  type?: DefinedType;
}): Dependency.Tag {
  let type = { args: valueTypeLiterals(args), results: [] };
  return { kind: "tag", type, ...explicitType(definedType, type), deps: [] };
}

function memoryConstructor<A extends AddressType = "i32">(
  {
    min,
    max,
    shared = false,
    address = "i32" as A,
  }: {
    min: U64;
    max?: U64;
    shared?: boolean;
    address?: A;
  },
  ...content: (number[] | Uint8Array)[]
): Dependency.Memory<A> {
  let memory: Dependency.Memory<A> = {
    kind: "memory",
    type: { limits: limits(min, max, shared, address) },
    address,
    deps: [],
  };
  let offset = 0;
  for (let init of content) {
    dataConstructor({ memory, offset }, init);
    offset += init.length;
  }
  return memory;
}

/** Limits record a 64-bit address type only when present, as in decoded modules. */
function limits(min: U64, max: U64 | undefined, shared: boolean, address: AddressType): Limits {
  const size = (n: U64) => uint64(BigInt(n));
  const sizes = { min: size(min), max: max === undefined ? undefined : size(max), shared };
  return address === "i64" ? { ...sizes, address } : sizes;
}

/** The JS API descriptor of a memory, whose 64-bit sizes are bigints. */
function jsLimits({
  min,
  max,
  shared,
  address,
}: {
  min: U64;
  max?: U64;
  shared: boolean;
  address?: AddressType;
}) {
  const size = (n: U64 | undefined) =>
    n === undefined ? undefined : address === "i64" ? BigInt(n) : Number(n);
  return {
    initial: size(min),
    maximum: size(max),
    shared,
    ...(address === "i64" ? { address } : {}),
  } as WebAssembly.MemoryDescriptor;
}

/** A data segment: passive, or active at an offset, a constant or a number, in a memory. */
function dataConstructor(
  mode:
    | {
        memory?: Dependency.AnyMemory;
        offset: ConstantInput;
      }
    | "passive",
  bytes: number[] | Uint8Array,
): Dependency.Data {
  let init = Uint8Array.from(bytes);
  if (mode === "passive") {
    return { kind: "data", init, mode, deps: [] };
  }
  let { memory } = mode;
  let offset = constantOffset(mode.offset, addressOf(memory?.type.limits)) as Dependency.Offset;
  let deps = [...offset.deps] as Dependency.AnyGlobal[];
  let result: Dependency.Data = {
    kind: "data",
    init,
    mode: { memory, offset },
    deps,
  };
  if (memory !== undefined) {
    result.deps.push(memory);
    memory.deps.push(result);
  } else {
    result.deps.push(Dependency.hasMemory);
  }
  return result;
}

function tableConstructor<A extends AddressType = "i32">(
  {
    type,
    min,
    max,
    address = "i32" as A,
    init,
  }: {
    type: RefTypeObject;
    min: U64;
    max?: U64;
    address?: A;
    /** Initial value of every element, null by default: a constant, or a function. */
    init?: Dependency.Constant<RefType> | Dependency.AnyFunc;
  },
  content?: (Dependency.Constant<RefType> | Dependency.AnyFunc)[],
): Dependency.Table<A> {
  let initial = init === undefined ? undefined : (constantOf(init) as Dependency.Constant<RefType>);
  let table: Dependency.Table<A> = {
    kind: "table" as const,
    type: { type: valueTypeLiteral(type), limits: limits(min, max, false, address) },
    address,
    deps: [...((initial?.deps ?? []) as Dependency.Table["deps"])],
    ...(initial === undefined ? {} : { init: initial }),
  };
  if (content !== undefined) {
    elemConstructor({ type, mode: { table, offset: 0 } }, content);
  }
  return table;
}

function elemConstructor(
  {
    type,
    mode,
  }: {
    type: RefTypeObject;
    mode:
      | "passive"
      | "declarative"
      | {
          table: Dependency.AnyTable;
          offset: ConstantInput;
        };
  },
  items: (Dependency.Constant<RefType> | Dependency.AnyFunc)[],
): Dependency.Elem {
  let init = items.map((item) => constantOf(item) as Dependency.Constant<RefType>);
  let deps = init.flatMap((i) => i.deps as Dependency.Elem["deps"]);
  let mode_: Dependency.Elem["mode"] =
    typeof mode === "object"
      ? {
          table: mode.table,
          offset: constantOffset(
            mode.offset,
            addressOf(mode.table.type.limits),
          ) as Dependency.Offset,
        }
      : mode;
  let result: Dependency.Elem = {
    kind: "elem" as const,
    type: valueTypeLiteral(type),
    init,
    mode: mode_,
    deps,
  };
  if (typeof mode_ === "object") {
    mode_.table.deps.push(result);
    deps.push(mode_.table);
    deps.push(...(mode_.offset.deps as Dependency.Elem["deps"]));
  }
  return result;
}
