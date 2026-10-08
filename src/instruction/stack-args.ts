import { Binable, Undefined } from "../binable.ts";
import type { AnyGlobal } from "../dependency.ts";
import type * as Dependency from "../dependency.ts";
import { endOf, formatStack, place, pushStack, shiftPlaces, startOf } from "../local-context.ts";
import {
  isStackVar,
  type LocalContext,
  popOne,
  popTypes,
  StackValue,
  pushValue,
  StackVar,
  Unknown,
} from "../local-context.ts";
import {
  isSubtype,
  type Local,
  printValueType,
  ValueType,
  valueTypeLiterals,
  type ValueTypeObjects,
} from "../types.ts";
import type { Tuple } from "../util.ts";
import {
  type Description,
  type Instruction_,
  baseInstruction,
  emitResults,
  emitSimple,
  writeInstruction,
} from "./base.ts";
import { Code, type Write } from "../code.ts";
import { checkInt32, checkInt64, f32Const, f64Const, i32Const, i64Const } from "./const.ts";
import { F32, F64, I32, I64 } from "../immediate.ts";
import type { InstructionName } from "./opcodes.ts";
import { globalGet, localGet } from "./variable-get.ts";

export {
  instruction,
  instructionWithArg,
  type Input,
  type Inputs,
  processStackArgs,
  processStackArg,
  writeOperands,
  namedInputs,
  insertInstruction,
};

type JSNumberValue<T extends ValueType> = T extends "i32"
  ? number
  : T extends "i64"
    ? bigint
    : T extends "f32"
      ? number
      : T extends "f64"
        ? number
        : never;

type Input<T extends ValueType | Unknown> =
  StackVar<T> | (T extends ValueType ? Local<T> | AnyGlobal<T> | JSNumberValue<T> : never);

function isLocal(x: Input<any>): x is Local {
  return typeof x === "object" && x !== null && x.kind === "local";
}
function isGlobal(x: Input<any>): x is AnyGlobal {
  return typeof x === "object" && x !== null && (x.kind === "global" || x.kind === "importGlobal");
}

type Inputs<P extends ValueType[]> = {
  [i in keyof P]: Input<P[i]>;
};

type InputsAsParameters<Args extends readonly ValueType[]> = ((...args: [] | Args) => any) extends (
  ...args: infer P
) => any
  ? (
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => any
  : never;

/**
 * instruction that is completely fixed
 */
function instruction<Args extends Tuple<ValueType>, Results extends Tuple<ValueType>>(
  name: InstructionName,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): ((...args: [] | Args) => any) extends (...args: infer P) => any
  ? (
      ctx: LocalContext,
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => Instruction_<Args, Results>
  : never {
  let instr = {
    in: valueTypeLiterals<Args>(args),
    out: valueTypeLiterals<Results>(results),
  };
  let createInstr = baseInstruction<undefined, [], [], Args, Results>(name, Undefined, {
    create: () => instr,
  });
  let { instruction } = createInstr;
  let [result] = instr.out;
  let simple = instr.out.length <= 1;
  let general = function createInstr_(
    ctx: LocalContext,
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    let operands: number | undefined;
    if (actualArgs.length > 0) {
      operands = writeOperands(ctx, name, instr.in, actualArgs);
      if (operands === undefined) processStackArgs(ctx, name, instr.in, actualArgs);
    }
    if (simple)
      return emitSimple(ctx, instruction, instr.in, result, undefined, operands) as Instruction_<
        Args,
        Results
      >;
    return emitResults(ctx, instruction, instr.in, instr.out, operands) as Instruction_<
      Args,
      Results
    >;
  };
  return flat(name, instruction.opcodeBytes, instr.in, instr.out, general) as any;
}

type General = (ctx: LocalContext, ...operands: Input<ValueType>[]) => unknown;

/**
 * An instruction of one or two operands, flat: it checks and writes its operands, writes itself, and
 * pushes its results in one function, which matters most for code that runs for the first time. New
 * operands that come before instruction results, which are inserted, and constant expressions take
 * the general path.
 */
function flat(
  name: string,
  opcode: number[],
  args: ValueType[],
  results: ValueType[],
  general: General,
): General {
  if (args.length === 1) {
    let [t0] = args;
    return function (ctx: LocalContext, a?: Input<ValueType>) {
      if (ctx.allowed !== undefined) return a === undefined ? general(ctx) : general(ctx, a);
      let from = ctx.code.length;
      if (a !== undefined && !(a instanceof StackValue)) writeOperand(ctx, name, t0, a);
      else {
        if (a !== undefined) checkLatest(ctx, name, a, 1);
        from = popOne(ctx, t0, name, from);
      }
      return finish(ctx, opcode, from, results);
    };
  }
  if (args.length === 2) {
    let [t0, t1] = args;
    return function (ctx: LocalContext, a?: Input<ValueType>, b?: Input<ValueType>) {
      if (ctx.allowed !== undefined) return a === undefined ? general(ctx) : general(ctx, a, b!);
      let from = ctx.code.length;
      if (a === undefined) {
        from = popOne(ctx, t1, name, from);
        from = popOne(ctx, t0, name, from);
        return finish(ctx, opcode, from, results);
      }
      let aResult = a instanceof StackValue;
      let bResult = b instanceof StackValue;
      if (bResult && !aResult) {
        // A new value before a result goes below the result, where the result's computation starts.
        checkLatest(ctx, name, b as StackVar<ValueType>, 1);
        if ((b as StackVar<ValueType | Unknown>).type === Unknown || ctx.frames[0]?.unreachable)
          return general(ctx, a, b!);
        let start = insertOperand(ctx, name, t0, a);
        popOne(ctx, t1, name, from);
        return finish(ctx, opcode, start, results);
      }
      if (aResult) checkLatest(ctx, name, a as StackVar<ValueType>, bResult ? 2 : 1);
      if (bResult) checkLatest(ctx, name, b as StackVar<ValueType>, 1);
      if (!aResult) writeOperand(ctx, name, t0, a);
      if (!bResult) writeOperand(ctx, name, t1, b!);
      if (bResult) from = popOne(ctx, t1, name, from);
      if (aResult) from = popOne(ctx, t0, name, from);
      return finish(ctx, opcode, from, results);
    };
  }
  return general;
}

/** An operand that is an instruction result must be the value `depth` from the top of the stack. */
function checkLatest(ctx: LocalContext, name: string, operand: StackVar<any>, depth: number) {
  if (operand.type === Unknown || ctx.frames[0]?.unreachable) return;
  if (ctx.stack[ctx.stack.length - depth] !== operand)
    throw Error(
      `${name}: operands that are instruction results must be the latest values on the stack, in order. Compute them in the order they are passed, and use each once.`,
    );
}

/** Write an instruction's opcode, and push its results, which are computed from `from`. */
function finish(ctx: LocalContext, opcode: number[], from: number, results: ValueType[]) {
  let { code, stack } = ctx;
  let n = opcode.length;
  code.reserve(n);
  let { buffer } = code;
  let length = code.length;
  for (let i = 0; i < n; i++) buffer[length + i] = opcode[i];
  length += n;
  code.length = length;
  if (results.length === 1) {
    let value = new StackValue(results[0], from, length);
    stack.push(value);
    return value;
  }
  if (results.length === 0) return undefined;
  let pushed: StackVar<ValueType>[] = [];
  for (let i = 0; i < results.length; i++) {
    let value = new StackValue(results[i], from, length);
    stack.push(value);
    pushed.push(value);
  }
  return pushed;
}

/**
 * instruction of constant type without dependencies,
 * but with an immediate argument
 */
function instructionWithArg<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>,
  Immediate extends any,
>(
  name: InstructionName,
  immediate: Binable<Immediate>,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): ((...args: [] | Args) => any) extends (...args: infer P) => any
  ? (
      ctx: LocalContext,
      immediate: Immediate,
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => Instruction_<Args, Results>
  : never {
  let instr = {
    in: valueTypeLiterals<Args>(args),
    out: valueTypeLiterals<Results>(results),
  };
  let createInstr = baseInstruction<
    Immediate,
    [immediate: Immediate],
    [immediate: Immediate],
    Args,
    Results
  >(name, immediate, { create: () => instr });
  let { instruction } = createInstr;
  let [result] = instr.out;
  let simple = instr.out.length <= 1;
  return function createInstr_(
    ctx: LocalContext,
    immediate: Immediate,
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    if (actualArgs.length > 0) processStackArgs(ctx, name, instr.in, actualArgs);
    if (simple)
      return emitSimple(ctx, instruction, instr.in, result, immediate) as Instruction_<
        Args,
        Results
      >;
    return createInstr(ctx, immediate);
  };
}

/** Named operands, in parameter order. */
function namedInputs(names: string[], values: Record<string, Input<any>>): Input<any>[] {
  return names.map((name) => values[name]);
}

/**
 * Operands that are instruction results are on the stack already, where they were pushed. They must
 * be the latest values on the stack, in the order of the operands, or the instruction would take
 * other values. `$` stands for whatever value is there. Unreachable code accepts any stack.
 */
function checkStackOperands(
  ctx: LocalContext,
  string: string,
  operands: Input<any>[],
  count: number,
) {
  if (ctx.frames[0]?.unreachable) return;
  let { stack } = ctx;
  let i = stack.length - count;
  // Indexed loops, which unoptimized code runs without allocating iterators.
  for (let k = 0; k < operands.length; k++) {
    let operand = operands[k];
    if (!isStackVar(operand)) continue;
    let value = stack[i++];
    if (operand.type === Unknown || operand === value) continue;
    throw Error(
      `${string}: operands that are instruction results must be the latest values on the stack, in order. Compute them in the order they are passed, and use each once.`,
    );
  }
}

function processStackArgs(
  ctx: LocalContext,
  string: string,
  expectedArgs: ValueType[],
  actualArgs: Input<ValueType | Unknown>[],
) {
  if (actualArgs.length === 0) return;
  let n = expectedArgs.length;
  if (actualArgs.length !== n) {
    throw Error(`${string}: Expected 0 or ${n} arguments, got ${actualArgs.length}.`);
  }
  // Operands that are new values, before instruction results, are inserted below those.
  let results = 0;
  let mustReorder = false;
  for (let i = 0; i < n; i++) {
    if (!isStackVar(actualArgs[i])) continue;
    if (results < i) mustReorder = true;
    results++;
  }
  if (results > 0) checkStackOperands(ctx, string, actualArgs, results);

  for (let i = 0; i < n; i++) {
    // if reordering, process inputs from last to first
    if (mustReorder) operand(ctx, string, expectedArgs[n - 1 - i], actualArgs[n - 1 - i], i);
    else operand(ctx, string, expectedArgs[i], actualArgs[i]);
  }
}

/**
 * Operands that are new values, and come after any instruction results among the operands, are
 * written in place without going through the stack; the results are popped. Returns where the
 * operands start, or undefined where they need `processStackArgs`: when new values come before
 * results, which they are then inserted below, and in constant expressions.
 */
function writeOperands(
  ctx: LocalContext,
  string: string,
  expectedArgs: ValueType[],
  actualArgs: Input<ValueType | Unknown>[],
): number | undefined {
  let n = expectedArgs.length;
  if (actualArgs.length !== n || ctx.allowed !== undefined) return undefined;
  let results = 0;
  while (results < n && isStackVar(actualArgs[results])) results++;
  for (let i = results; i < n; i++) if (isStackVar(actualArgs[i])) return undefined;
  if (results > 0) {
    checkStackOperands(ctx, string, actualArgs, results);
    for (let i = 0; i < results; i++) operand(ctx, string, expectedArgs[i], actualArgs[i]);
  }
  let start = ctx.code.length;
  for (let i = results; i < n; i++) writeOperand(ctx, string, expectedArgs[i], actualArgs[i]);
  if (results > 0) popTypes(ctx, expectedArgs, string, results);
  return start;
}

/** Write a local, global or number of the given type, as an operand that is not pushed. */
function writeOperand(
  ctx: LocalContext,
  string: string,
  type: ValueType,
  x: Input<any>,
  code = ctx.code,
) {
  if (isLocal(x)) {
    if (x.type !== type && !isSubtype(x.type, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got local of type ${printValueType(x.type)}.`,
      );
    if (ctx.locals[x.index] === undefined) throw Error(`local with index ${x.index} not available`);
    code.byte(0x20);
    code.unsigned(x.index);
  } else if (isGlobal(x)) {
    if (!isSubtype(x.type.value, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got global of type ${printValueType(x.type.value)}.`,
      );
    writeInstruction(code, globalGet.instruction, [x], [x]);
    ctx.deps.add(x);
  } else if (type === "i32" && typeof x === "number") {
    checkInt32(x);
    code.byte(0x41);
    I32.write(code, x);
  } else if (type === "i64" && typeof x === "bigint") {
    checkInt64(x);
    code.byte(0x42);
    I64.write(code, x);
  } else if (type === "f32" && typeof x === "number") {
    code.byte(0x43);
    F32.write(code, x);
  } else if (type === "f64" && typeof x === "number") {
    code.byte(0x44);
    F64.write(code, x);
  } else throw Error(`${string}: Unsupported input for type ${type}, got ${x}.`);
}

/** The single operand of an instruction, like that of `local.set`, without arrays of operands. */
function processStackArg(ctx: LocalContext, string: string, type: ValueType, x: Input<any>) {
  if (isStackVar(x) && x.type !== Unknown && !ctx.frames[0]?.unreachable) {
    let top = ctx.stack[ctx.stack.length - 1];
    if (x !== top)
      throw Error(
        `${string}: operands that are instruction results must be the latest values on the stack, in order. Compute them in the order they are passed, and use each once.`,
      );
  }
  operand(ctx, string, type, x);
}

/**
 * An operand of the given type: a local, global or number is pushed, or inserted below the top `below`
 * values; an instruction result is on the stack already.
 */
function operand(
  ctx: LocalContext,
  string: string,
  type: ValueType,
  x: Input<ValueType | Unknown>,
  below?: number,
) {
  if (isStackVar(x)) {
    if (x.type !== Unknown && x.type !== type && !isSubtype(x.type, type))
      throw Error(
        `${string}: Expected argument of type ${printValueType(type)}, got ${printValueType(x.type)}.`,
      );
  } else if (isLocal(x)) {
    if (x.type !== type && !isSubtype(x.type, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got local of type ${printValueType(x.type)}.`,
      );
    if (below !== undefined) insertInstruction(ctx, below, localGet.create(ctx, x));
    else {
      // local.get, written here, which is faster than through the instruction
      let local = ctx.locals[x.index];
      if (local === undefined || ctx.allowed !== undefined) return void localGet(ctx, x);
      let { code } = ctx;
      let start = code.length;
      code.byte(0x20);
      code.unsigned(x.index);
      pushValue(ctx, local, start);
    }
  } else if (isGlobal(x)) {
    if (!isSubtype(x.type.value, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got global of type ${printValueType(x.type.value)}.`,
      );
    if (below !== undefined) insertInstruction(ctx, below, globalGet.create(ctx, x));
    else globalGet(ctx, x);
  } else {
    let constant =
      type === "i32" && typeof x === "number"
        ? i32Const
        : type === "i64" && typeof x === "bigint"
          ? i64Const
          : type === "f32" && typeof x === "number"
            ? f32Const
            : type === "f64" && typeof x === "number"
              ? f64Const
              : undefined;
    if (constant === undefined)
      throw Error(`${string}: Unsupported input for type ${type}, got ${x}.`);
    if (below !== undefined) insertInstruction(ctx, below, constant.create(ctx, x as never));
    else constant(ctx, x as never);
  }
}

/**
 * Insert an instruction that pushes one value, so that the value goes below the top `i` values of the
 * stack: right after the value below it was computed. Reads of locals and globals must not move above
 * writes to them.
 */
function insertInstruction(ctx: LocalContext, i: number, description: Description) {
  let { stack, code } = ctx;
  let { string, instruction, deps, resolveArgs, type } = description;
  if (stack.length < i && !ctx.frames[0].unreachable)
    throw Error(`${string}: can't insert below ${i} values, the stack has ${stack.length}`);
  // In unreachable code, values that are missing from the stack are below the inserted one.
  let below = Math.max(0, stack.length - i);
  let position = below < stack.length ? startOf(stack[below]) : code.length;
  if (below > 0 && position < endOf(stack[below - 1]))
    throw Error(
      `${string}: can't insert an operand between values that one instruction pushes or passes through, in stack ${formatStack(stack)}`,
    );
  // Insertions are near the end of the code, after most writes.
  let written: Write | undefined;
  for (let k = code.writes.length - 1; k >= 0 && code.writes[k].position >= position; k--)
    if (writes(code.writes[k], description)) written = code.writes[k];
  if (written !== undefined)
    throw Error(
      `${string}: an operand would be read before ${written.name}, which comes after earlier operands that are instruction results and changes it. Compute the operands in the order they are passed.`,
    );
  let inserted = scratch;
  inserted.clear();
  writeInstruction(inserted, instruction, deps, resolveArgs);
  code.insert(position, inserted);
  shiftPlaces(ctx, position, inserted.length);
  let result = StackVar(type.results[0]);
  place(result, position, position + inserted.length);
  stack.splice(below, 0, result);
  for (let k = 0; k < deps.length; k++) ctx.deps.add(deps[k]);
}

/**
 * Insert a local, global or number below the value on top of the stack, where that value's computation
 * starts, and return that position. It must not be read before a later write to it.
 */
function insertOperand(ctx: LocalContext, name: string, type: ValueType, x: Input<any>) {
  let { stack, code } = ctx;
  let top = stack[stack.length - 1];
  let position = startOf(top);
  let below = stack[stack.length - 2];
  if (below !== undefined && position < endOf(below))
    throw Error(
      `${name}: can't insert an operand between values that one instruction pushes or passes through, in stack ${formatStack(stack)}`,
    );
  let local = isLocal(x) ? x.index : undefined;
  let global = isGlobal(x) && x.type.mutable ? x : undefined;
  if (local !== undefined || global !== undefined) {
    for (let k = code.writes.length - 1; k >= 0 && code.writes[k].position >= position; k--) {
      let write = code.writes[k];
      if (local !== undefined ? write.local === local : write.global === global || write.call)
        throw Error(
          `${local !== undefined ? "local.get" : "global.get"}: an operand would be read before ${write.name}, which comes after earlier operands that are instruction results and changes it. Compute the operands in the order they are passed.`,
        );
    }
  }
  scratch.clear();
  writeOperand(ctx, name, type, x, scratch);
  code.insert(position, scratch);
  shiftPlaces(ctx, position, scratch.length);
  return position;
}

/** Code of an instruction to insert. */
const scratch = new Code(16);

/** Whether a write changes what a local.get or global.get reads. */
function writes(write: Write, { string, resolveArgs, deps }: Description): boolean {
  if (string === "local.get") return write.local === (resolveArgs[0] as Local).index;
  if (string === "global.get") {
    let global = deps[0] as AnyGlobal;
    return global.type.mutable && (write.global === global || write.call === true);
  }
  return false;
}
