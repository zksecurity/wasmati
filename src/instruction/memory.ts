import {
  type BaseInstruction,
  type Instruction_,
  checkAllowed,
  define,
  withPublicSignature,
  type WithPublicSignature,
} from "./base.ts";
import * as Dependency from "../dependency.ts";
import type { LocalContext, StackVar } from "../local-context.ts";
import { U32, U64, U8, uint64 } from "../immediate.ts";
import { Binable, record, tuple, writeUnsignedLEB } from "../binable.ts";
import {
  type AddressType,
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
import {
  type Input,
  pushResults,
  takeOne,
  takeOperands,
  takeTwo,
  typedByImmediates,
  writeOpcode,
} from "./stack-args.ts";
import { addHole } from "../code.ts";

export { memoryOps, dataOps, tableOps, elemOps, memoryInstruction, memoryLaneInstruction };

/**
 * Memory instructions can name their memory; without one they use the default memory, which must then
 * have 32-bit addresses. Address operands and sizes have the memory's address type.
 */
function memoryUse(memory: Dependency.AnyMemory | undefined) {
  return memory === undefined
    ? { address: "i32" as const, deps: [Dependency.hasMemory] }
    : { address: memory.address, deps: [memory] };
}

/** A length spanning two memories or tables is 64-bit only if both are. */
function minAddress(a: AddressType, b: AddressType): AddressType {
  return a === "i64" && b === "i64" ? "i64" : "i32";
}

/** Sizes have the memory's address type, i32 for the default memory. */
type SizeSignature = <A extends AddressType = "i32">(
  ...memory: [] | [memory: Dependency.AnyMemory<A>]
) => StackVar<A>;

const resolveIndex = ([index]: number[]) => index;
const resolveIndices = ([first, second]: number[]) => [first, second];

const memorySize = withPublicSignature<SizeSignature>()(
  typedByImmediates(
    define("memory.size", MemoryIndex, resolveIndex),
    1,
    (memory?: Dependency.AnyMemory) => {
      const { address, deps } = memoryUse(memory);
      return { in: [], out: [address], deps, args: [] };
    },
  ),
);
const memoryGrow = withPublicSignature<SizeSignature>()(
  typedByImmediates(
    define("memory.grow", MemoryIndex, resolveIndex),
    1,
    (memory?: Dependency.AnyMemory) => {
      const { address, deps } = memoryUse(memory);
      return { in: [address], out: [address], deps, args: [] };
    },
  ),
);

const memoryOps = {
  size: memorySize,
  grow: memoryGrow,
  init: typedByImmediates(
    define("memory.init", tuple([DataIndex, MemoryIndex]), resolveIndices),
    2,
    (data: Dependency.Data, memory?: Dependency.AnyMemory) => {
      const { address, deps } = memoryUse(memory);
      return { in: [address, "i32", "i32"], out: [], deps: [data, ...deps], args: [] };
    },
  ),
  copy: typedByImmediates(
    define("memory.copy", tuple([MemoryIndex, MemoryIndex]), resolveIndices),
    2,
    (
      destination?: Dependency.AnyMemory,
      source: Dependency.AnyMemory | undefined = destination,
    ) => {
      const target = memoryUse(destination);
      const origin = memoryUse(source);
      const length = minAddress(target.address, origin.address);
      return {
        in: [target.address, origin.address, length],
        out: [],
        deps: [...target.deps, ...origin.deps],
        args: [],
      };
    },
  ),
  fill: typedByImmediates(
    define("memory.fill", MemoryIndex, resolveIndex),
    1,
    (memory?: Dependency.AnyMemory) => {
      const { address, deps } = memoryUse(memory);
      return { in: [address, "i32", address], out: [], deps, args: [] };
    },
  ),
};

const dataOps = {
  drop: typedByImmediates(
    define("data.drop", DataIndex, resolveIndex),
    1,
    (data: Dependency.Data) => ({ in: [], out: [], deps: [data], args: [] }),
  ),
};

const tableAddress = (table: Dependency.AnyTable) => table.address;

/** Sizes have the table's address type. */
type TableSizeSignature = <A extends AddressType>(table: Dependency.AnyTable<A>) => StackVar<A>;

const tableGrow = withPublicSignature<TableSizeSignature>()(
  typedByImmediates(
    define("table.grow", TableIndex, resolveIndex),
    1,
    (table: Dependency.AnyTable) => {
      const address = tableAddress(table);
      return { in: [table.type.type, address], out: [address], deps: [table], args: [] };
    },
  ),
);
const tableSize = withPublicSignature<TableSizeSignature>()(
  typedByImmediates(
    define("table.size", TableIndex, resolveIndex),
    1,
    (table: Dependency.AnyTable) => ({
      in: [],
      out: [tableAddress(table)],
      deps: [table],
      args: [],
    }),
  ),
);

const tableOps = {
  size: tableSize,
  grow: tableGrow,
  get: typedByImmediates(
    define("table.get", TableIndex, resolveIndex),
    1,
    (table: Dependency.AnyTable) => ({
      in: [tableAddress(table)],
      out: [table.type.type],
      deps: [table],
      args: [],
    }),
  ),
  set: typedByImmediates(
    define("table.set", TableIndex, resolveIndex),
    1,
    (table: Dependency.AnyTable) => ({
      in: [tableAddress(table), table.type.type],
      out: [],
      deps: [table],
      args: [],
    }),
  ),
  init: typedByImmediates(
    define("table.init", tuple([ElemIndex, TableIndex]), resolveIndices),
    2,
    (table: Dependency.AnyTable, elem: Dependency.Elem) => ({
      in: [tableAddress(table), "i32", "i32"],
      out: [],
      deps: [elem, table],
      args: [],
    }),
  ),
  copy: typedByImmediates(
    define("table.copy", tuple([TableIndex, TableIndex]), resolveIndices),
    2,
    (table1: Dependency.AnyTable, table2: Dependency.AnyTable) => {
      const [a1, a2] = [tableAddress(table1), tableAddress(table2)];
      return { in: [a1, a2, minAddress(a1, a2)], out: [], deps: [table1, table2], args: [] };
    },
  ),
  fill: typedByImmediates(
    define("table.fill", TableIndex, resolveIndex),
    1,
    (table: Dependency.AnyTable) => {
      const address = tableAddress(table);
      return { in: [address, table.type.type, address], out: [], deps: [table], args: [] };
    },
  ),
};

const elemOps = {
  drop: typedByImmediates(
    define("elem.drop", ElemIndex, resolveIndex),
    1,
    (elem: Dependency.Elem) => ({ in: [], out: [], deps: [elem], args: [] }),
  ),
};

/** Alignment exponent, offset, and a memory index unless the access is to memory 0. */
type MemArg = { align: U32; offset: U64; memory?: number };
// Flags from 64 announce a memory index, which precedes the offset; flags from 128 are malformed.
const MemArg = Binable<MemArg>({
  writeBytes(output, { align, offset, memory }) {
    if (memory === undefined || memory === 0) U32.writeBytes(output, align);
    else {
      U32.writeBytes(output, align | 64);
      U32.writeBytes(output, memory);
    }
    U64.writeBytes(output, offset);
  },
  readBytes(input) {
    let flags = U32.readBytes(input);
    if (flags >= 128) throw Error(`malformed memory alignment flags ${flags}`);
    let memory = flags & 64 ? U32.readBytes(input) : 0;
    const memArg: MemArg = { align: flags & 63, offset: U64.readBytes(input) };
    if (memory !== 0) memArg.memory = memory;
    return memArg;
  },
});

/** Record the memory of an access in its memory argument, omitting memory 0. */
function withMemory(memArg: MemArg, memory: number): MemArg {
  return memory === 0 ? memArg : { ...memArg, memory };
}

/** A memory argument immediate that records the access's natural alignment exponent, the default. */
type MemArgImmediate<T> = Binable<T> & { naturalAlign: number };
function withNaturalAlign<T>(binable: Binable<T>, bits: number): MemArgImmediate<T> {
  return { ...binable, naturalAlign: Math.log2(bits / 8) };
}

/** The memory argument of an access: alignment in bytes, offset, and optionally the memory. */
type MemArgInput<A extends AddressType = AddressType> = {
  offset?: U64;
  align?: number;
  memory?: Dependency.AnyMemory<A>;
};

/** Operand types of a memory access whose first operand, the address, has the memory's address type. */
type AccessArgs<Args extends readonly ValueType[], A extends AddressType = AddressType> = {
  [i in keyof Args]: Input<i extends "0" ? A : Args[i]>;
};

/** A memory access: addresses have the address type of the memory, i32 for the default memory. */
type AccessSignature<Args extends readonly ValueType[], Results> = <A extends AddressType = "i32">(
  memArg: MemArgInput<A>,
  ...args: AccessArgs<Args, NoInfer<A>> | []
) => Instruction_<Args, Results>;
type LaneAccessSignature<Args extends readonly ValueType[], Results> = <
  A extends AddressType = "i32",
>(
  memArg: MemArgInput<A>,
  lane: number,
  ...args: AccessArgs<Args, NoInfer<A>> | []
) => Instruction_<Args, Results>;

/**
 * Memory accesses, like `i32.load` and `i64.store`. The first operand is the address, of the memory's
 * address type. The default memory has index 0, which the memory argument leaves out; the index of a
 * named memory is a hole, which Module() fills in.
 */
function memoryInstruction<
  const Args extends Tuple<ValueType>,
  const Results extends Tuple<ValueType>,
>(
  name: InstructionName,
  bits: number,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): MemoryInstruction<Args, Results> {
  let instruction = define(
    name,
    withNaturalAlign(MemArg, bits),
    ([memoryIdx]: number[], memArg: MemArg) => withMemory(memArg, memoryIdx),
  );
  let { ins32, ins64 } = addressed(valueTypeLiterals<Args>(args));
  let outs: ValueType[] = valueTypeLiterals<Results>(results);
  let natural = Math.log2(bits / 8);
  let operands: (Input<ValueType> | undefined)[] = [];
  let emit = function (
    ctx: LocalContext,
    memArg: MemArgInput,
    a?: Input<ValueType>,
    b?: Input<ValueType>,
    c?: Input<ValueType>,
  ) {
    if (ctx.allowed !== undefined) checkAllowed(ctx, name);
    let { memory } = memArg;
    let ins = memory?.address === "i64" ? ins64 : ins32;
    if (ins.length === 1) takeOne(ctx, name, ins[0], a);
    else if (ins.length === 2) takeTwo(ctx, name, ins[0], ins[1], a, b);
    else {
      operands[0] = a;
      operands[1] = b;
      operands[2] = c;
      takeOperands(ctx, name, ins, operands);
    }
    let { code } = ctx;
    writeOpcode(code, instruction.opcodeBytes);
    if (memory === undefined) {
      ctx.deps.add(Dependency.hasMemory);
      let { offset = 0, align } = memArg;
      writeUnsignedLEB(code, align === undefined ? natural : alignExponent(name, align));
      U64.writeBytes(code, memoryOffset(offset));
    } else {
      ctx.deps.add(memory);
      addHole(code, instruction, [memory], [memArgFromInput(name, bits, memArg)]);
    }
    return pushResults(ctx, outs);
  };
  // The function takes its operands as separate parameters, without the array of a rest parameter,
  // so TypeScript can't relate it to the signature, which it implements.
  return Object.assign(emit, { instruction }) as MemoryInstruction<Args, Results>;
}

/** Operand types with a 32-bit address, and with a 64-bit address. */
function addressed(args: ValueType[]) {
  let rest = args.slice(1);
  return { ins32: ["i32", ...rest] as ValueType[], ins64: ["i64", ...rest] as ValueType[] };
}

/** A memory access, as a function of its memory argument and operands. */
type MemoryInstruction<Args extends Tuple<ValueType>, Results extends Tuple<ValueType>> = ((
  ctx: LocalContext,
  memArg: MemArgInput,
  ...args: AccessArgs<Args> | []
) => Instruction_<Args, Results>) &
  WithPublicSignature<AccessSignature<Args, Results>> & { instruction: BaseInstruction };

type MemArgAndLane = { memArg: MemArg; lane: U8 };
const MemArgAndLane = record({ memArg: MemArg, lane: U8 });

/** Memory accesses to a lane of a vector, like `v128.load8_lane`, whose lane follows the memory argument. */
function memoryLaneInstruction<Args extends Tuple<ValueType>, Results extends Tuple<ValueType>>(
  name: InstructionName,
  bits: number,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): ((
  ctx: LocalContext,
  memArg: MemArgInput,
  lane: number,
  ...args: AccessArgs<Args> | []
) => Instruction_<Args, Results>) &
  WithPublicSignature<LaneAccessSignature<Args, Results>> & { instruction: BaseInstruction } {
  let instruction = define(
    name,
    withNaturalAlign(MemArgAndLane, bits),
    ([memoryIdx]: number[], { memArg, lane }: MemArgAndLane) => ({
      memArg: withMemory(memArg, memoryIdx),
      lane,
    }),
  );
  let { ins32, ins64 } = addressed(valueTypeLiterals<Args>(args));
  let outs: ValueType[] = valueTypeLiterals<Results>(results);
  let emit = function (
    ctx: LocalContext,
    memArg: MemArgInput,
    lane: number,
    a?: Input<ValueType>,
    b?: Input<ValueType>,
  ) {
    if (ctx.allowed !== undefined) checkAllowed(ctx, name);
    let { memory } = memArg;
    let ins = memory?.address === "i64" ? ins64 : ins32;
    takeTwo(ctx, name, ins[0], ins[1], a, b);
    let { code } = ctx;
    writeOpcode(code, instruction.opcodeBytes);
    let value = { memArg: memArgFromInput(name, bits, memArg), lane };
    if (memory === undefined) {
      ctx.deps.add(Dependency.hasMemory);
      MemArgAndLane.writeBytes(code, value);
    } else {
      ctx.deps.add(memory);
      addHole(code, instruction, [memory], [value]);
    }
    return pushResults(ctx, outs);
  };
  return Object.assign(emit, { instruction }) as ReturnType<
    typeof memoryLaneInstruction<Args, Results>
  >;
}

function memArgFromInput(
  name: string,
  bits: number,
  { offset = 0, align = bits / 8 }: MemArgInput,
): MemArg {
  return { offset: memoryOffset(offset), align: alignExponent(name, align) };
}

/** Offsets are numbers where exact, bigints beyond 2^53. */
function memoryOffset(offset: U64): U64 {
  return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
    ? offset
    : uint64(BigInt(offset));
}

function alignExponent(name: string, align: number) {
  let exponent = Math.log2(align);
  if (!Number.isInteger(exponent))
    throw Error(`${name}: \`align\` must be power of 2, got ${align}`);
  return exponent;
}
