import { Const } from "./dependency.ts";
import * as Dependency from "./dependency.ts";
import {
  type AddressType,
  type Limits,
  RefType,
  type RefTypeObject,
  valueTypeLiteral,
} from "./types.ts";

export {
  memoryConstructor,
  dataConstructor,
  tableConstructor,
  elemConstructor,
  limits,
  jsLimits,
  constOffset,
};

function memoryConstructor(
  {
    min,
    max,
    shared = false,
    address = "i32",
  }: {
    min: number;
    max?: number;
    shared?: boolean;
    address?: AddressType;
  },
  ...content: (number[] | Uint8Array)[]
): Dependency.Memory {
  let memory: Dependency.Memory = {
    kind: "memory",
    type: { limits: limits(min, max, shared, address) },
    deps: [],
  };
  let offset = 0;
  for (let init of content) {
    dataConstructor({ memory, offset: constOffset(address, offset) }, init);
    offset += init.length;
  }
  return memory;
}

/** Limits record a 64-bit address type only when present, as in decoded modules. */
function limits(
  min: number,
  max: number | undefined,
  shared: boolean,
  address: AddressType,
): Limits {
  return address === "i64" ? { min, max, shared, address } : { min, max, shared };
}

/** The JS API descriptor of a memory, whose 64-bit sizes are bigints. */
function jsLimits({
  min,
  max,
  shared,
  address,
}: {
  min: number;
  max?: number;
  shared: boolean;
  address?: AddressType;
}) {
  const size = (n: number | undefined) =>
    n === undefined ? undefined : address === "i64" ? BigInt(n) : n;
  return {
    initial: size(min),
    maximum: size(max),
    shared,
    ...(address === "i64" ? { address } : {}),
  } as WebAssembly.MemoryDescriptor;
}

function constOffset(address: AddressType, offset: number): Dependency.Offset {
  return address === "i64" ? Const.i64(offset) : Const.i32(offset);
}

function dataConstructor(
  mode:
    | {
        memory?: Dependency.AnyMemory;
        offset: Dependency.Offset;
      }
    | "passive",
  [...init]: number[] | Uint8Array,
): Dependency.Data {
  if (mode === "passive") {
    return { kind: "data", init, mode, deps: [] };
  }
  let { memory, offset } = mode;
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

function tableConstructor(
  {
    type,
    min,
    max,
    address = "i32",
  }: {
    type: RefTypeObject;
    min: number;
    max?: number;
    address?: AddressType;
  },
  content?: (Const.refFunc | Const.refNull<RefType>)[],
): Dependency.Table {
  let table = {
    kind: "table" as const,
    type: { type: valueTypeLiteral(type), limits: limits(min, max, false, address) },
    deps: [],
  };
  if (content !== undefined) {
    elemConstructor({ type, mode: { table, offset: constOffset(address, 0) } }, content);
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
          offset: Dependency.Offset;
        };
  },
  init: (Const.refFunc | Const.refNull<RefType>)[],
): Dependency.Elem {
  let deps = init.flatMap((i) => i.deps as Dependency.Elem["deps"]);
  let result = {
    kind: "elem" as const,
    type: valueTypeLiteral(type),
    init,
    mode,
    deps,
  };
  if (typeof mode === "object") {
    mode.table.deps.push(result);
    deps.push(mode.table);
    deps.push(...(mode.offset.deps as Dependency.Elem["deps"]));
  }
  return result;
}
