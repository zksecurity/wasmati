import { type Instruction_, baseInstruction } from "./base.ts";
import * as Dependency from "../dependency.ts";
import type { LocalContext } from "../local-context.ts";
import { U32, U8 } from "../immediate.ts";
import { type Binable, record, tuple } from "../binable.ts";
import {
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

const memoryOps = {
  size: baseInstruction("memory.size", MemoryIndex, {
    create(_: LocalContext) {
      return {
        in: [],
        out: ["i32"],
        deps: [Dependency.hasMemory],
        resolveArgs: [0],
      };
    },
  }),
  grow: baseInstruction("memory.grow", MemoryIndex, {
    create(_: LocalContext) {
      return {
        in: ["i32"],
        out: ["i32"],
        deps: [Dependency.hasMemory],
        resolveArgs: [0],
      };
    },
  }),
  init: baseInstruction("memory.init", tuple([DataIndex, MemoryIndex]), {
    create(_: LocalContext, data: Dependency.Data) {
      return {
        in: ["i32", "i32", "i32"],
        out: [],
        deps: [data, Dependency.hasMemory],
      };
    },
    resolve([dataIdx]: number[]): [number, number] {
      return [dataIdx, 0];
    },
  }),
  copy: baseInstruction("memory.copy", tuple([MemoryIndex, MemoryIndex]), {
    create(_: LocalContext) {
      return {
        in: ["i32", "i32", "i32"],
        out: [],
        deps: [Dependency.hasMemory],
        resolveArgs: [[0, 0]],
      };
    },
  }),
  fill: baseInstruction("memory.fill", MemoryIndex, {
    create(_: LocalContext) {
      return {
        in: ["i32", "i32", "i32"],
        out: [],
        deps: [Dependency.hasMemory],
        resolveArgs: [0],
      };
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

const tableOps = {
  get: baseInstruction("table.get", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return {
        in: ["i32"],
        out: [table.type.type],
        deps: [table],
      };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  set: baseInstruction("table.set", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return {
        in: ["i32", table.type.type],
        out: [],
        deps: [table],
      };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  init: baseInstruction("table.init", tuple([ElemIndex, TableIndex]), {
    create(_: LocalContext, table: Dependency.AnyTable, elem: Dependency.Elem) {
      return {
        in: ["i32", "i32", "i32"],
        out: [],
        deps: [elem, table],
      };
    },
    resolve: ([elemIdx, tableIdx]) => [elemIdx, tableIdx],
  }),
  copy: baseInstruction("table.copy", tuple([TableIndex, TableIndex]), {
    create(_: LocalContext, table1: Dependency.AnyTable, table2: Dependency.AnyTable) {
      return {
        in: ["i32", "i32", "i32"],
        out: [],
        deps: [table1, table2],
      };
    },
    resolve: ([tableIdx1, tableIdx2]) => [tableIdx1, tableIdx2],
  }),
  grow: baseInstruction("table.grow", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return {
        in: [table.type.type, "i32"],
        out: ["i32"],
        deps: [table],
      };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  size: baseInstruction("table.size", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return {
        in: [],
        out: ["i32"],
        deps: [table],
      };
    },
    resolve: ([tableIdx]) => tableIdx,
  }),
  fill: baseInstruction("table.fill", TableIndex, {
    create(_: LocalContext, table: Dependency.AnyTable) {
      return {
        in: ["i32", table.type.type, "i32"],
        out: [],
        deps: [table],
      };
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

type MemArg = { align: U32; offset: U32 };
const MemArg = record({ align: U32, offset: U32 });

/** A memory argument immediate that records the access's natural alignment exponent, the default. */
type MemArgImmediate<T> = Binable<T> & { naturalAlign: number };
function withNaturalAlign<T>(binable: Binable<T>, bits: number): MemArgImmediate<T> {
  return { ...binable, naturalAlign: Math.log2(bits / 8) };
}

function memoryInstruction<
  const Args extends Tuple<ValueType>,
  const Results extends Tuple<ValueType>,
>(
  name: InstructionName,
  bits: number,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): ((...args: [] | Args) => any) extends (...args: infer P) => any
  ? (
      ctx: LocalContext,
      memArg: { offset?: number; align?: number },
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => Instruction_<Args, Results>
  : never {
  let expectedArgs = valueTypeLiterals<Args>(args);
  let createInstr = baseInstruction<
    MemArg,
    [memArg: { offset?: number; align?: number }],
    [memArg: MemArg],
    Args,
    Results
  >(name, withNaturalAlign(MemArg, bits), {
    create(_, memArg) {
      return {
        in: expectedArgs,
        out: valueTypeLiterals<Results>(results),
        resolveArgs: [memArgFromInput(name, bits, memArg)],
        deps: [Dependency.hasMemory],
      };
    },
  });
  return function createInstr_(
    ctx: LocalContext,
    memArgs: { offset?: number; align?: number },
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    processStackArgs(ctx, name, expectedArgs, actualArgs);
    return createInstr(ctx, memArgs);
  };
}

type MemArgAndLane = { memArg: MemArg; lane: U8 };
const MemArgAndLane = record({ memArg: MemArg, lane: U8 });

function memoryLaneInstruction<Args extends Tuple<ValueType>, Results extends Tuple<ValueType>>(
  name: InstructionName,
  bits: number,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): ((...args: [] | Args) => any) extends (...args: infer P) => any
  ? (
      ctx: LocalContext,
      memArg: { offset?: number; align?: number },
      lane: number,
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => Instruction_<Args, Results>
  : never {
  let expectedArgs = valueTypeLiterals<Args>(args);
  let createInstr = baseInstruction<
    MemArgAndLane,
    [memArg: { offset?: number; align?: number }, lane: number],
    [memArgAndLane: MemArgAndLane],
    Args,
    Results
  >(name, withNaturalAlign(MemArgAndLane, bits), {
    create: (_, memArg, lane) => ({
      in: expectedArgs,
      out: valueTypeLiterals<Results>(results),
      resolveArgs: [{ memArg: memArgFromInput(name, bits, memArg), lane }],
      deps: [Dependency.hasMemory],
    }),
  });
  return function createInstr_(
    ctx: LocalContext,
    memArgs: { offset?: number; align?: number },
    lane: number,
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    processStackArgs(ctx, name, expectedArgs, actualArgs);
    return createInstr(ctx, memArgs, lane);
  };
}

function memArgFromInput(
  name: string,
  bits: number,
  { offset = 0, align = bits / 8 }: { offset?: number; align?: number },
) {
  let alignExponent = Math.log2(align);
  if (!Number.isInteger(alignExponent)) {
    throw Error(`${name}: \`align\` must be power of 2, got ${align}`);
  }
  return { offset, align: alignExponent };
}
