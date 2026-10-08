import { Binable, Undefined } from "../binable.ts";
import type { AnyGlobal } from "../dependency.ts";
import type * as Dependency from "../dependency.ts";
import {
  isStackVar,
  type LocalContext,
  popOne,
  popTypes,
  StackValue,
  pushResult,
  StackVar,
  type StackType,
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
  type Instruction_,
  baseInstruction,
  emitResults,
  emitSimple,
  writeInstruction,
} from "./base.ts";
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
  writeOperand,
  flatOperands,
  checkLatest,
  namedInputs,
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
    let popped = false;
    if (actualArgs.length > 0) {
      popped = writeOperands(ctx, name, instr.in, actualArgs);
      if (!popped) processStackArgs(ctx, name, instr.in, actualArgs);
    }
    if (simple)
      return emitSimple(ctx, instruction, instr.in, result, undefined, popped) as Instruction_<
        Args,
        Results
      >;
    return emitResults(ctx, instruction, instr.in, instr.out, popped) as Instruction_<
      Args,
      Results
    >;
  };
  return flat(name, instruction.opcodeBytes, instr.in, instr.out, general) as any;
}

type General = (ctx: LocalContext, ...operands: Input<ValueType>[]) => unknown;

/**
 * An instruction of up to four operands, flat: it checks and writes its operands, writes itself, and
 * pushes its results in one function, which matters most for code that runs for the first time.
 * Constant expressions take the general path.
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
      if (a !== undefined && !(a instanceof StackValue)) writeOperand(ctx, name, t0, a);
      else {
        if (a !== undefined) checkLatest(ctx, name, a, 1);
        popOne(ctx, t0, name);
      }
      return finish(ctx, opcode, results);
    };
  }
  if (args.length === 2) {
    let [t0, t1] = args;
    return function (ctx: LocalContext, a?: Input<ValueType>, b?: Input<ValueType>) {
      if (ctx.allowed !== undefined) return a === undefined ? general(ctx) : general(ctx, a, b!);
      if (a === undefined) {
        popOne(ctx, t1, name);
        popOne(ctx, t0, name);
        return finish(ctx, opcode, results);
      }
      let aResult = a instanceof StackValue;
      let bResult = b instanceof StackValue;
      if (bResult && !aResult) newBeforeResult(name);
      if (aResult) checkLatest(ctx, name, a as StackVar<ValueType>, bResult ? 2 : 1);
      if (bResult) checkLatest(ctx, name, b as StackVar<ValueType>, 1);
      if (!aResult) writeOperand(ctx, name, t0, a);
      if (!bResult) writeOperand(ctx, name, t1, b!);
      if (bResult) popOne(ctx, t1, name);
      if (aResult) popOne(ctx, t0, name);
      return finish(ctx, opcode, results);
    };
  }
  if (args.length === 3 || args.length === 4) {
    let n = args.length;
    return function (
      ctx: LocalContext,
      a?: Input<ValueType>,
      b?: Input<ValueType>,
      c?: Input<ValueType>,
      d?: Input<ValueType>,
    ) {
      if (ctx.allowed === undefined) {
        flatOperands(ctx, name, args, n, a, b, c, d);
        return finish(ctx, opcode, results);
      }
      if (a === undefined) return general(ctx);
      return n === 3 ? general(ctx, a, b!, c!) : general(ctx, a, b!, c!, d!);
    };
  }
  return general;
}

/**
 * Check and write up to four operands, or take them from the stack. Instruction results, and `$`, are
 * on the stack and come first; new values that follow them are written in place.
 */
function flatOperands(
  ctx: LocalContext,
  name: string,
  args: ValueType[],
  n: number,
  a?: Input<ValueType>,
  b?: Input<ValueType>,
  c?: Input<ValueType>,
  d?: Input<ValueType>,
) {
  if (a === undefined) {
    for (let i = n - 1; i >= 0; i--) popOne(ctx, args[i], name);
    return;
  }
  let count = 0;
  while (count < n && pick(count, a, b, c, d) instanceof StackValue) count++;
  // Instruction results are the latest values on the stack, in order.
  for (let i = 0; i < count; i++)
    checkLatest(ctx, name, pick(i, a, b, c, d) as StackVar<ValueType>, count - i);
  for (let i = count; i < n; i++) {
    let x = pick(i, a, b, c, d)!;
    if (x instanceof StackValue) newBeforeResult(name);
    writeOperand(ctx, name, args[i], x);
  }
  for (let i = count - 1; i >= 0; i--) popOne(ctx, args[i], name);
}

/** The i-th of up to four operands, without a closure, which would be allocated per instruction. */
function pick<T>(i: number, a: T, b: T, c: T, d: T): T {
  return i === 0 ? a : i === 1 ? b : i === 2 ? c : d;
}

/** An operand that is an instruction result must be the value `depth` from the top of the stack. */
function checkLatest(ctx: LocalContext, name: string, operand: StackVar<any>, depth: number) {
  if (operand.type === Unknown || ctx.frames[0]?.unreachable) return;
  if (ctx.stack[ctx.stack.length - depth] !== operand)
    throw Error(
      `${name}: operands that are instruction results must be the latest values on the stack, in order. Compute them in the order they are passed, and use each once.`,
    );
}

/** Operands are written where they are passed, so new values can't go below instruction results. */
function newBeforeResult(name: string): never {
  throw Error(
    `${name}: a local, global or number operand comes before an instruction result. Operands are computed in the order they are passed: push the value first with an instruction, like local.get(x) or i32.const(1).`,
  );
}

/** Write an instruction's opcode, and push its results. */
function finish(ctx: LocalContext, opcode: number[], results: ValueType[]) {
  let { code, stack } = ctx;
  let n = opcode.length;
  code.reserve(n);
  let { buffer } = code;
  let length = code.length;
  for (let i = 0; i < n; i++) buffer[length + i] = opcode[i];
  code.length = length + n;
  if (results.length === 1) {
    let value = new StackValue(results[0]);
    stack.push(value);
    return value;
  }
  if (results.length === 0) return undefined;
  let pushed: StackVar<ValueType>[] = [];
  for (let i = 0; i < results.length; i++) {
    let value = new StackValue(results[i]);
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

/**
 * Operands of the general path: instruction results, and `$`, are on the stack already and come first;
 * new values that follow them are pushed.
 */
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
  let results = 0;
  while (results < n && isStackVar(actualArgs[results])) results++;
  for (let i = results; i < n; i++) if (isStackVar(actualArgs[i])) newBeforeResult(string);
  if (results > 0) checkStackOperands(ctx, string, actualArgs, results);
  for (let i = 0; i < n; i++) operand(ctx, string, expectedArgs[i], actualArgs[i]);
}

/**
 * Operands that are new values are written in place without going through the stack, and instruction
 * results are popped. Returns false where `processStackArgs` takes the operands instead: in constant
 * expressions, and where they are not in order.
 */
function writeOperands(
  ctx: LocalContext,
  string: string,
  expectedArgs: ValueType[],
  actualArgs: Input<ValueType | Unknown>[],
): boolean {
  let n = expectedArgs.length;
  if (actualArgs.length !== n || ctx.allowed !== undefined) return false;
  let results = 0;
  while (results < n && isStackVar(actualArgs[results])) results++;
  for (let i = results; i < n; i++) if (isStackVar(actualArgs[i])) return false;
  if (results > 0) {
    checkStackOperands(ctx, string, actualArgs, results);
    for (let i = 0; i < results; i++) operand(ctx, string, expectedArgs[i], actualArgs[i]);
  }
  for (let i = results; i < n; i++) writeOperand(ctx, string, expectedArgs[i], actualArgs[i]);
  if (results > 0) popTypes(ctx, expectedArgs, string, results);
  return true;
}

/** Write a local, global or number of the given type, as an operand that is not pushed. */
function writeOperand(ctx: LocalContext, string: string, type: ValueType, x: Input<any>) {
  let { code } = ctx;
  if (isLocal(x)) {
    if (x.type !== type && !isSubtype(x.type, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got local of type ${printValueType(x.type)}.`,
      );
    if (ctx.locals[x.index] === undefined) throw Error(`local with index ${x.index} not available`);
    code.indexed(0x20, x.index);
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
 * An operand of the given type: a local, global or number is pushed; an instruction result is on the
 * stack already.
 */
function operand(
  ctx: LocalContext,
  string: string,
  type: ValueType,
  x: Input<ValueType | Unknown>,
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
    // local.get, written here, which is faster than through the instruction
    let local = ctx.locals[x.index];
    if (local === undefined || ctx.allowed !== undefined) return void localGet(ctx, x);
    ctx.code.indexed(0x20, x.index);
    pushResult(ctx, local);
  } else if (isGlobal(x)) {
    if (!isSubtype(x.type.value, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got global of type ${printValueType(x.type.value)}.`,
      );
    globalGet(ctx, x);
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
    constant(ctx, x as never);
  }
}
