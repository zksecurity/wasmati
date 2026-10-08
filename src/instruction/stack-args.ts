import { Binable, reserve, writeByte, writeIndexed } from "../binable.ts";
import type { AnyGlobal } from "../dependency.ts";
import {
  isStackVar,
  type LocalContext,
  popOne,
  StackValue,
  StackVar,
  Unknown,
  missingLocal,
  pushStack,
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
  type BaseInstruction,
  type Instruction_,
  checkAllowed,
  define,
  writeInstruction,
} from "./base.ts";
import type { Code } from "../code.ts";
import { checkInt32, checkInt64, f32Const, f64Const, i32Const, i64Const } from "./const.ts";
import { F32, F64, I32, I64 } from "../immediate.ts";
import type { InstructionName } from "./opcodes.ts";
import { globalGet, localGet } from "./variable-get.ts";

export {
  fixed,
  fixedWithImmediate,
  takeOne,
  takeTwo,
  takeOperands,
  writeOpcode,
  pushResults,
  type Input,
  type Inputs,
  processStackArgs,
  writeOperand,
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
 * An instruction of fixed operand and result types, without an immediate, like `i32.add`. Its
 * function takes its operands, or takes them from the stack, writes the instruction, and pushes its
 * results.
 */
function fixed<Args extends Tuple<ValueType>, Results extends Tuple<ValueType>>(
  name: InstructionName,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
): FixedInstruction<Args, Results> {
  let instruction = define(name);
  let ins: ValueType[] = valueTypeLiterals<Args>(args);
  let outs: ValueType[] = valueTypeLiterals<Results>(results);
  let opcode = instruction.opcodeBytes;
  let emit;
  // A function for each number of operands, which takes them as parameters, without a rest array.
  if (ins.length === 0) {
    emit = function (ctx: LocalContext) {
      if (ctx.allowed !== undefined) checkAllowed(ctx, name);
      return finish(ctx, opcode, outs);
    };
  } else if (ins.length === 1) {
    let [t0] = ins;
    emit = function (ctx: LocalContext, a?: Input<ValueType>) {
      if (ctx.allowed !== undefined) checkAllowed(ctx, name);
      takeOne(ctx, name, t0, a);
      return finish(ctx, opcode, outs);
    };
  } else if (ins.length === 2) {
    let [t0, t1] = ins;
    emit = function (ctx: LocalContext, a?: Input<ValueType>, b?: Input<ValueType>) {
      if (ctx.allowed !== undefined) checkAllowed(ctx, name);
      takeTwo(ctx, name, t0, t1, a, b);
      return finish(ctx, opcode, outs);
    };
  } else {
    let operands: (Input<ValueType> | undefined)[] = [];
    emit = function (
      ctx: LocalContext,
      a?: Input<ValueType>,
      b?: Input<ValueType>,
      c?: Input<ValueType>,
      d?: Input<ValueType>,
    ) {
      if (ctx.allowed !== undefined) checkAllowed(ctx, name);
      operands[0] = a;
      operands[1] = b;
      operands[2] = c;
      operands[3] = d;
      takeOperands(ctx, name, ins, operands);
      return finish(ctx, opcode, outs);
    };
  }
  // The functions take their operands as separate parameters, without the array of a rest
  // parameter, so TypeScript can't relate them to the signature, which they implement.
  return Object.assign(emit, { instruction }) as FixedInstruction<Args, Results>;
}

/** An instruction of fixed operand and result types, as a function of its operands. */
type FixedInstruction<Args extends Tuple<ValueType>, Results extends Tuple<ValueType>> = (((
  ...args: [] | Args
) => any) extends (...args: infer P) => any
  ? (
      ctx: LocalContext,
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => Instruction_<Args, Results>
  : never) & { instruction: BaseInstruction };

/**
 * An instruction of fixed operand and result types with an immediate value, like `i32.const` or
 * `i8x16.extract_lane`, which its function takes before its operands. `validate` checks the value.
 */
function fixedWithImmediate<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>,
  Immediate,
>(
  name: InstructionName,
  immediate: Binable<Immediate>,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
  validate?: (value: Immediate) => void,
): FixedWithImmediate<Args, Results, Immediate> {
  let instruction = define(name, immediate);
  let ins: ValueType[] = valueTypeLiterals<Args>(args);
  let outs: ValueType[] = valueTypeLiterals<Results>(results);
  let opcode = instruction.opcodeBytes;
  let operands: (Input<ValueType> | undefined)[] = [];
  let emit = function (
    ctx: LocalContext,
    value: Immediate,
    a?: Input<ValueType>,
    b?: Input<ValueType>,
    c?: Input<ValueType>,
  ) {
    if (ctx.allowed !== undefined) checkAllowed(ctx, name);
    if (validate !== undefined) validate(value);
    if (ins.length > 0) {
      operands[0] = a;
      operands[1] = b;
      operands[2] = c;
      takeOperands(ctx, name, ins, operands);
    }
    writeOpcode(ctx.code, opcode);
    immediate.writeBytes(ctx.code, value);
    return pushResults(ctx, outs);
  };
  return Object.assign(emit, { instruction }) as FixedWithImmediate<Args, Results, Immediate>;
}

/** An instruction of fixed operand and result types, as a function of its immediate and operands. */
type FixedWithImmediate<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>,
  Immediate,
> = (((...args: [] | Args) => any) extends (...args: infer P) => any
  ? (
      ctx: LocalContext,
      immediate: Immediate,
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => Instruction_<Args, Results>
  : never) & { instruction: BaseInstruction };

/** One operand: a value to write, or an instruction result or `$` on the stack, or none. */
function takeOne(ctx: LocalContext, name: string, type: ValueType, a?: Input<ValueType>) {
  if (a !== undefined && !(a instanceof StackValue)) writeOperand(ctx, name, type, a);
  else {
    if (a !== undefined) checkLatest(ctx, name, a, 1);
    popOne(ctx, type, name);
  }
}

/** Two operands, as `takeOperands()` takes them, without its loops: most instructions have two. */
function takeTwo(
  ctx: LocalContext,
  name: string,
  t0: ValueType,
  t1: ValueType,
  a?: Input<ValueType>,
  b?: Input<ValueType>,
) {
  if (a === undefined) {
    popOne(ctx, t1, name);
    popOne(ctx, t0, name);
    return;
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
}

/**
 * The operands of the given types, or none, which takes them from the stack. Instruction results, and
 * `$`, are on the stack and come first; new values that follow them are written in place.
 */
function takeOperands(
  ctx: LocalContext,
  name: string,
  types: ValueType[],
  operands: (Input<ValueType> | undefined)[],
) {
  let n = types.length;
  if (operands[0] === undefined) {
    for (let i = n - 1; i >= 0; i--) popOne(ctx, types[i], name);
    return;
  }
  let count = 0;
  while (count < n && operands[count] instanceof StackValue) count++;
  // Instruction results are the latest values on the stack, in order.
  for (let i = 0; i < count; i++)
    checkLatest(ctx, name, operands[i] as StackVar<ValueType>, count - i);
  for (let i = count; i < n; i++) {
    let x = operands[i]!;
    if (x instanceof StackValue) newBeforeResult(name);
    writeOperand(ctx, name, types[i], x);
  }
  for (let i = count - 1; i >= 0; i--) popOne(ctx, types[i], name);
}

/** An operand that is an instruction result must be the value `depth` from the top of the stack. */
function checkLatest(ctx: LocalContext, name: string, operand: StackVar<any>, depth: number) {
  if (operand.type === Unknown || ctx.frames[0]?.unreachable) return;
  if (ctx.stack[ctx.stack.length - depth] !== operand) throw notLatest(name);
}

/** Instruction results are pushed when they are computed, so they must be operands in that order. */
function notLatest(name: string) {
  return Error(
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
  writeOpcode(ctx.code, opcode);
  return pushResults(ctx, results);
}

function writeOpcode(code: Code, opcode: number[]) {
  let n = opcode.length;
  reserve(code, n);
  let { bytes, offset } = code;
  for (let i = 0; i < n; i++) bytes[offset + i] = opcode[i];
  code.offset = offset + n;
}

/** Push results: none, one, which is returned, or several, which are returned as a list. */
function pushResults(ctx: LocalContext, results: ValueType[]) {
  // Pushed here rather than through pushResult(), which is measurably slower on this hottest path.
  if (results.length === 1) {
    let value = new StackValue(results[0]);
    ctx.stack.push(value);
    return value;
  }
  if (results.length === 0) return undefined;
  return pushStack(ctx, results);
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
    throw notLatest(string);
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

/** Write a local, global or number of the given type, as an operand that is not pushed. */
function writeOperand(ctx: LocalContext, string: string, type: ValueType, x: Input<any>) {
  let { code } = ctx;
  if (isLocal(x)) {
    // The type of the local in this function, which a local of another function needn't have
    let local = ctx.locals[x.index];
    if (local === undefined) throw missingLocal(ctx, x.index);
    if (local !== type && !isSubtype(local, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got local of type ${printValueType(local)}.`,
      );
    writeIndexed(code, 0x20, x.index);
  } else if (isGlobal(x)) {
    if (ctx.allowed !== undefined) checkAllowed(ctx, "global.get");
    if (!isSubtype(x.type.value, type))
      throw Error(
        `${string}: Expected type ${printValueType(type)}, got global of type ${printValueType(x.type.value)}.`,
      );
    writeInstruction(code, globalGet.instruction, [x], [x]);
    ctx.deps.add(x);
  } else if (type === "i32" && typeof x === "number") {
    checkInt32(x);
    writeByte(code, 0x41);
    I32.writeBytes(code, x);
  } else if (type === "i64" && typeof x === "bigint") {
    checkInt64(x);
    writeByte(code, 0x42);
    I64.writeBytes(code, x);
  } else if (type === "f32" && typeof x === "number") {
    writeByte(code, 0x43);
    F32.writeBytes(code, x);
  } else if (type === "f64" && typeof x === "number") {
    writeByte(code, 0x44);
    F64.writeBytes(code, x);
  } else throw Error(`${string}: Unsupported input for type ${type}, got ${x}.`);
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
    localGet(ctx, x);
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
