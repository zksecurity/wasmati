import { Binable, Undefined } from "../binable.ts";
import type { AnyGlobal } from "../dependency.ts";
import type * as Dependency from "../dependency.ts";
import { formatStack, place, placeOf, pushStack, shiftPlaces } from "../local-context.ts";
import { isStackVar, type LocalContext, StackVar, Unknown } from "../local-context.ts";
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
import { f32Const, f64Const, i32Const, i64Const } from "./const.ts";
import type { InstructionName } from "./opcodes.ts";
import { globalGet, localGet } from "./variable-get.ts";

export {
  instruction,
  instructionWithArg,
  type Input,
  type Inputs,
  processStackArgs,
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
  return function createInstr_(
    ctx: LocalContext,
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    if (actualArgs.length > 0) processStackArgs(ctx, name, instr.in, actualArgs);
    if (simple)
      return emitSimple(ctx, instruction, instr.in, result) as Instruction_<Args, Results>;
    return emitResults(ctx, instruction, instr.in, instr.out) as Instruction_<Args, Results>;
  };
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
function checkStackOperands(ctx: LocalContext, string: string, operands: Input<any>[]) {
  if (ctx.frames[0]?.unreachable) return;
  let { stack } = ctx;
  let count = 0;
  for (let operand of operands) if (isStackVar(operand)) count++;
  let i = stack.length - count;
  for (let operand of operands) {
    if (!isStackVar(operand)) continue;
    let value = stack[i++];
    if (operand.type === Unknown || operand.id === value?.id) continue;
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
  checkStackOperands(ctx, string, actualArgs);

  let mustReorder = false;
  let hadNewInstr = false;
  for (let x of actualArgs) {
    if (!isStackVar(x)) hadNewInstr = true;
    else if (hadNewInstr) mustReorder = true;
  }

  for (let i = 0; i < n; i++) {
    // if reordering, process inputs from last to first
    let x = mustReorder ? actualArgs[n - 1 - i] : actualArgs[i];
    let type = mustReorder ? expectedArgs[n - 1 - i] : expectedArgs[i];
    if (isLocal(x)) {
      if (x.type !== type && !isSubtype(x.type, type))
        throw Error(
          `${string}: Expected type ${printValueType(type)}, got local of type ${printValueType(x.type)}.`,
        );
      if (mustReorder) insertInstruction(ctx, i, localGet.create(ctx, x));
      else localGet(ctx, x);
    } else if (isGlobal(x)) {
      if (!isSubtype(x.type.value, type))
        throw Error(
          `${string}: Expected type ${printValueType(type)}, got global of type ${printValueType(x.type.value)}.`,
        );
      if (mustReorder) insertInstruction(ctx, i, globalGet.create(ctx, x));
      else globalGet(ctx, x);
    } else if (isStackVar(x)) {
      if (x.type !== Unknown && x.type !== type && !isSubtype(x.type, type))
        throw Error(
          `${string}: Expected argument of type ${printValueType(type)}, got ${printValueType(x.type)}.`,
        );
    } else {
      // could be const
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
      if (mustReorder) insertInstruction(ctx, i, constant.create(ctx, x as never));
      else constant(ctx, x as never);
    }
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
  let position = below < stack.length ? placeOf(stack[below]).start : code.length;
  if (below > 0 && position < placeOf(stack[below - 1]).end)
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
  let [result] = pushStack(ctx, type.results);
  stack.splice(stack.length - 1, 1);
  stack.splice(below, 0, result);
  place(result, position, position + inserted.length);
  for (let dep of deps) ctx.deps.add(dep);
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
