import { Binable, Undefined } from "../binable.js";
import { AnyGlobal } from "../dependency.js";
import { Dependency } from "../index.js";
import { formatStack, pushStack } from "../local-context.js";
import { popStack } from "../local-context.js";
import { emptyContext } from "../local-context.js";
import { LocalContext, StackVar, Unknown } from "../local-context.js";
import {
  Local,
  ValueType,
  valueTypeLiterals,
  ValueTypeObjects,
} from "../types.js";
import { Tuple } from "../util.js";
import { Instruction_, baseInstruction } from "./base.js";
import { f32Const, f64Const, i32Const, i64Const } from "./const.js";
import { InstructionName } from "./opcodes.js";
import { globalGet, localGet } from "./variable-get.js";

export {
  instruction,
  instructionWithArg,
  Input,
  Inputs,
  processStackArgs,
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
  | StackVar<T>
  | (T extends ValueType ? Local<T> | AnyGlobal<T> | JSNumberValue<T> : never);

function isLocal(x: Input<any>): x is Local<ValueType> {
  return typeof x === "object" && x !== null && x.kind === "local";
}
function isGlobal(x: Input<any>): x is AnyGlobal<ValueType> {
  return (
    typeof x === "object" &&
    x !== null &&
    (x.kind === "global" || x.kind === "importGlobal")
  );
}
function isStackVar(x: Input<any>): x is StackVar<ValueType | Unknown> {
  return typeof x === "object" && x !== null && x.kind === "stack-var";
}

type Inputs<P extends ValueType[]> = {
  [i in keyof P]: Input<P[i]>;
};

type InputsAsParameters<Args extends readonly ValueType[]> = ((
  ...args: [] | Args
) => any) extends (...args: infer P) => any
  ? (
      ...args: {
        [i in keyof P]: Input<P[i] extends ValueType ? P[i] : never>;
      }
    ) => any
  : never;

/**
 * instruction that is completely fixed
 */
function instruction<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>
>(
  name: InstructionName,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>
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
  let createInstr = baseInstruction<undefined, [], [], Args, Results>(
    name,
    Undefined,
    { create: () => instr }
  );
  return function createInstr_(
    ctx: LocalContext,
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    processStackArgs(ctx, name, instr.in, actualArgs);
    return createInstr(ctx);
  };
}

/**
 * instruction of constant type without dependencies,
 * but with an immediate argument
 */
function instructionWithArg<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>,
  Immediate extends any
>(
  name: InstructionName,
  immediate: Binable<Immediate>,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>
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
  return function createInstr_(
    ctx: LocalContext,
    immediate: Immediate,
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    processStackArgs(ctx, name, instr.in, actualArgs);
    return createInstr(ctx, immediate);
  };
}

function processStackArgs(
  ctx: LocalContext,
  string: string,
  expectedArgs: ValueType[],
  actualArgs: Input<ValueType | Unknown>[]
) {
  if (actualArgs.length === 0) return;
  let n = expectedArgs.length;
  if (actualArgs.length !== n) {
    throw Error(
      `${string}: Expected 0 or ${n} arguments, got ${actualArgs.length}.`
    );
  }

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
      if (x.type !== type)
        throw Error(
          `${string}: Expected type ${type}, got local of type ${x.type}.`
        );
      if (mustReorder) insertInstruction(ctx, i, localGet.create(ctx, x));
      else localGet(ctx, x);
    } else if (isGlobal(x)) {
      if (x.type.value !== type)
        throw Error(
          `${string}: Expected type ${type}, got global of type ${x.type.value}.`
        );
      if (mustReorder) insertInstruction(ctx, i, globalGet.create(ctx, x));
      else globalGet(ctx, x);
    } else if (isStackVar(x)) {
      if (x.type !== type && x.type !== Unknown)
        throw Error(
          `${string}: Expected argument of type ${type}, got ${x.type}.`
        );
    } else {
      // could be const
      let unsupported = `${string}: Unsupported input for type ${type}, got ${x}.`;
      switch (type) {
        case "i32":
          if (typeof x !== "number") throw Error(unsupported);
          if (mustReorder) insertInstruction(ctx, i, i32Const.create(ctx, x));
          else i32Const(ctx, x);
          break;
        case "i64":
          if (typeof x !== "bigint") throw Error(unsupported);
          if (mustReorder) insertInstruction(ctx, i, i64Const.create(ctx, x));
          else i64Const(ctx, x);
          break;
        case "f32":
          if (typeof x !== "number") throw Error(unsupported);
          if (mustReorder) insertInstruction(ctx, i, f32Const.create(ctx, x));
          else f32Const(ctx, x);
          break;
        case "f64":
          if (typeof x !== "number") throw Error(unsupported);
          if (mustReorder) insertInstruction(ctx, i, f64Const.create(ctx, x));
          else f64Const(ctx, x);
          break;
        case "v128":
        case "funcref":
        case "externref":
        default:
          throw Error(unsupported);
      }
    }
  }
}

/**
 * travel back in time and insert instruction so that its result occupies
 * position i in the stack, where i is counted from the top
 * (so i=0 means apply the instruction as usual, i=1 means your output should be put below the current top variable, etc)
 */
function insertInstruction(
  ctx: LocalContext,
  i: number,
  instr: Dependency.Instruction
) {
  if (ctx.frames[0].unreachable)
    throw Error("Can't insert instruction from unreachable code");
  if (ctx.stack.length < i)
    throw Error(
      `insertInstruction: trying to insert instruction at position ${i} > stack length ${ctx.stack.length}`
    );
  let stack = [...ctx.stack];
  let pseudoCtx: LocalContext = {
    ...emptyContext(),
    stack,
    frames: [{ ...dummyFrame, stack }],
  };
  let toReapply: Dependency.Instruction[] = [];
  if (stack.length === i) {
    for (let instruction of [...ctx.body].reverse()) {
      if (stack.length === 0) break;
      unapply(pseudoCtx, instruction);
      toReapply.unshift(instruction);
    }
    if (stack.length !== 0)
      throw Error(
        `Cannot insert constant instruction into stack ${formatStack(
          stack
        )} at position ${i}`
      );
  } else {
    let variable = stack[stack.length - i - 1];
    for (let instruction of [...ctx.body].reverse()) {
      if (stack[stack.length - 1].id === variable.id) break;
      unapply(pseudoCtx, instruction);
      toReapply.unshift(instruction);
      if (!stack.find((v) => v.id === variable.id))
        throw Error(
          `Cannot insert constant instruction into stack ${formatStack(
            stack
          )} at position ${i}`
        );
    }
  }
  // we successfully unapplied instructions up to a state where `instr` can be inserted
  let nInstructions = toReapply.length;
  apply(pseudoCtx, instr);
  toReapply.forEach((i) => apply(pseudoCtx, i));
  // now `stack` matches what we want, so swap out the current stack with it and insert instruction into body
  ctx.stack.splice(0, ctx.stack.length, ...stack);
  ctx.body.splice(ctx.body.length - nInstructions, 0, instr);
}

const dummyFrame = {
  label: "0.1" as const,
  opcode: "block" as const,
  unreachable: false,
  endTypes: [],
  startTypes: [],
};

function apply(ctx: LocalContext, instruction: Dependency.Instruction) {
  // console.log(
  //   `applying ${printFunctionType(instruction.type)} to stack ${formatStack(
  //     ctx.stack
  //   )}`
  // );
  popStack(ctx, instruction.type.args);
  pushStack(ctx, instruction.type.results);
}
function unapply(ctx: LocalContext, instruction: Dependency.Instruction) {
  // console.log(
  //   `unapplying ${printFunctionType(instruction.type)} to stack ${formatStack(
  //     ctx.stack
  //   )}`
  // );
  popStack(ctx, instruction.type.results);
  pushStack(ctx, instruction.type.args);
}
