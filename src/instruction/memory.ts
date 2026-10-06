import { type Instruction_, baseInstruction } from "./base.ts";
import * as Dependency from "../dependency.ts";
import type { LocalContext } from "../local-context.ts";
import { U32, U64, U8 } from "../immediate.ts";
import { type Binable, record, tuple, withValidation } from "../binable.ts";
import {
  type AddressType,
  addressType,
  DataIndex,
  ElemIndex,
  MemoryIndex,
  TableIndex,
  ValueType,
  valueTypeLiterals,
  type ValueTypeObjects,
} from "../types.ts";
import type { Tuple } from "../util.ts";
import type { InstructionName } from "./opcodes.ts";
import { type Input, processStackArgs } from "./stack-args.ts";

export { memoryOps, dataOps, tableOps, elemOps, memoryInstruction, memoryLaneInstruction };

/**
 * Memory instructions can name their memory; without one they use the default memory, which must then
 * have 32-bit addresses. Address operands and sizes have the memory's address type.
 */
function memoryUse(memory: Dependency.AnyMemory | undefined) {
  return memory === undefined
    ? { address: "i32" as const, deps: [Dependency.hasMemory] }
    : { address: addressType(memory.type.limits), deps: [memory] };
}

/** A length spanning two memories or tables is 64-bit only if both are. */
function minAddress(a: AddressType, b: AddressType): AddressType {
  return a === "i64" && b === "i64" ? "i64" : "i32";
}

const memoryOps = {
  size: baseInstruction("memory.size", MemoryIndex, {
    create(_: LocalContext, ...[memory]: [] | [memory: Dependency.AnyMemory]) {
      const { address, deps } = memoryUse(memory);
      return { in: [], out: [address], deps, resolveArgs: [0] };
    },
  }),
  grow: baseInstruction("memory.grow", MemoryIndex, {
    create(_: LocalContext, ...[memory]: [] | [memory: Dependency.AnyMemory]) {
      const { address, deps } = memoryUse(memory);
      return { in: [address], out: [address], deps, resolveArgs: [0] };
    },
  }),
  init: baseInstruction("memory.init", tuple([DataIndex, MemoryIndex]), {
    create(
      _: LocalContext,
      data: Dependency.Data,
      ...[memory]: [] | [memory: Dependency.AnyMemory]
    ) {
      const { address, deps } = memoryUse(memory);
      return { in: [address, "i32", "i32"], out: [], deps: [data, ...deps] };
    },
    resolve([dataIdx]: number[]): [number, number] {
      return [dataIdx, 0];
    },
  }),
  copy: baseInstruction("memory.copy", tuple([MemoryIndex, MemoryIndex]), {
    create(
      _: LocalContext,
      ...[destination, source = destination]:
        | []
        | [memory: Dependency.AnyMemory]
        | [destination: Dependency.AnyMemory, source: Dependency.AnyMemory]
    ) {
      const target = memoryUse(destination);
      const origin = memoryUse(source);
      const length = minAddress(target.address, origin.address);
      return {
        in: [target.address, origin.address, length],
        out: [],
        deps: [...target.deps, ...origin.deps],
        resolveArgs: [[0, 0]],
      };
    },
  }),
  fill: baseInstruction("memory.fill", MemoryIndex, {
    create(_: LocalContext, ...[memory]: [] | [memory: Dependency.AnyMemory]) {
      const { address, deps } = memoryUse(memory);
      return { in: [address, "i32", address], out: [], deps, resolveArgs: [0] };
    },
  }),
};

const dataOps = {
  drop: baseInstruction("data.drop", DataIndex, {
    create(_: LocalContext, data: Dependency.Data) {
      return {
        in: [],
        out: [],
        deps: [data],
      };
    },
    resolve: ([dataIdx]) => dataIdx,
  }),
};

const tableAddress = (table: Dependency.AnyTable) => addressType(table.type.limits);

const tableOps = {
  get: baseInstruction("table.get", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return { in: [tableAddress(table)], out: [table.type.type], deps: [table] };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  set: baseInstruction("table.set", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return { in: [tableAddress(table), table.type.type], out: [], deps: [table] };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  init: baseInstruction("table.init", tuple([ElemIndex, TableIndex]), {
    create(_: LocalContext, table: Dependency.AnyTable, elem: Dependency.Elem) {
      return { in: [tableAddress(table), "i32", "i32"], out: [], deps: [elem, table] };
    },
    resolve: ([elemIdx, tableIdx]) => [elemIdx, tableIdx],
  }),
  copy: baseInstruction("table.copy", tuple([TableIndex, TableIndex]), {
    create(_: LocalContext, table1: Dependency.AnyTable, table2: Dependency.AnyTable) {
      const [a1, a2] = [tableAddress(table1), tableAddress(table2)];
      return { in: [a1, a2, minAddress(a1, a2)], out: [], deps: [table1, table2] };
    },
    resolve: ([tableIdx1, tableIdx2]) => [tableIdx1, tableIdx2],
  }),
  grow: baseInstruction("table.grow", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      const address = tableAddress(table);
      return { in: [table.type.type, address], out: [address], deps: [table] };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  size: baseInstruction("table.size", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return { in: [], out: [tableAddress(table)], deps: [table] };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  fill: baseInstruction("table.fill", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      const address = tableAddress(table);
      return { in: [address, table.type.type, address], out: [], deps: [table] };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
};

const elemOps = {
  drop: baseInstruction("elem.drop", ElemIndex, {
    create(_: LocalContext, elem: Dependency.Elem) {
      return {
        in: [],
        out: [],
        deps: [elem],
      };
    },
    resolve: ([elemIdx]) => elemIdx,
  }),
};

type MemArg = { align: U32; offset: number };
// Alignment flags from 64 select a memory index, which wasmati does not support; from 128 they are malformed.
const MemArg = withValidation(record({ align: U32, offset: U64 }), ({ align }) => {
  if (align >= 64) throw Error(`unsupported memory alignment flags ${align}`);
});

/** A memory argument immediate that records the access's natural alignment exponent, the default. */
type MemArgImmediate<T> = Binable<T> & { naturalAlign: number };
function withNaturalAlign<T>(binable: Binable<T>, bits: number): MemArgImmediate<T> {
  return { ...binable, naturalAlign: Math.log2(bits / 8) };
}

/** The memory argument of an access: alignment in bytes, offset, and optionally the memory. */
type MemArgInput = { offset?: number; align?: number; memory?: Dependency.AnyMemory };

/** Operand types of a memory access whose first operand, the address, depends on the memory. */
type AccessArgs<Args extends readonly ValueType[]> = {
  [i in keyof Args]: Input<i extends "0" ? AddressType : Args[i]>;
};

function memoryInstruction<
  const Args extends Tuple<ValueType>,
  const Results extends Tuple<ValueType>,
>(
  name: InstructionName,
  bits: number,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): (
  ctx: LocalContext,
  memArg: MemArgInput,
  ...args: AccessArgs<Args> | []
) => Instruction_<Args, Results> {
  let expectedArgs = valueTypeLiterals<Args>(args);
  let createInstr = baseInstruction<MemArg, [memArg: MemArgInput], [memArg: MemArg], Args, Results>(
    name,
    withNaturalAlign(MemArg, bits),
    {
      create(_, memArg) {
        const { address, deps } = memoryUse(memArg.memory);
        return {
          in: [address, ...expectedArgs.slice(1)] as ValueType[] as Args,
          out: valueTypeLiterals<Results>(results),
          resolveArgs: [memArgFromInput(name, bits, memArg)],
          deps,
        };
      },
    },
  );
  return function createInstr_(ctx, memArg, ...actualArgs) {
    const { address } = memoryUse(memArg.memory);
    processStackArgs(ctx, name, [address, ...expectedArgs.slice(1)], actualArgs);
    return createInstr(ctx, memArg);
  };
}

type MemArgAndLane = { memArg: MemArg; lane: U8 };
const MemArgAndLane = record({ memArg: MemArg, lane: U8 });

function memoryLaneInstruction<Args extends Tuple<ValueType>, Results extends Tuple<ValueType>>(
  name: InstructionName,
  bits: number,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): (
  ctx: LocalContext,
  memArg: MemArgInput,
  lane: number,
  ...args: AccessArgs<Args> | []
) => Instruction_<Args, Results> {
  let expectedArgs = valueTypeLiterals<Args>(args);
  let createInstr = baseInstruction<
    MemArgAndLane,
    [memArg: MemArgInput, lane: number],
    [memArgAndLane: MemArgAndLane],
    Args,
    Results
  >(name, withNaturalAlign(MemArgAndLane, bits), {
    create(_, memArg, lane) {
      const { address, deps } = memoryUse(memArg.memory);
      return {
        in: [address, ...expectedArgs.slice(1)] as ValueType[] as Args,
        out: valueTypeLiterals<Results>(results),
        resolveArgs: [{ memArg: memArgFromInput(name, bits, memArg), lane }],
        deps,
      };
    },
  });
  return function createInstr_(ctx, memArg, lane, ...actualArgs) {
    const { address } = memoryUse(memArg.memory);
    processStackArgs(ctx, name, [address, ...expectedArgs.slice(1)], actualArgs);
    return createInstr(ctx, memArg, lane);
  };
}

function memArgFromInput(
  name: string,
  bits: number,
  { offset = 0, align = bits / 8 }: MemArgInput,
) {
  let alignExponent = Math.log2(align);
  if (!Number.isInteger(alignExponent)) {
    throw Error(`${name}: \`align\` must be power of 2, got ${align}`);
  }
  return { offset, align: alignExponent };
}
