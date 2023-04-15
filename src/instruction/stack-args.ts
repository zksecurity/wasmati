import { Undefined } from "../binable.js";
import { AnyGlobal } from "../dependency.js";
import { LocalContext, StackVar, Unknown } from "../local-context.js";
import {
  JSValue,
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

export { instruction, Input, processStackArgs };

type Input<T extends ValueType> =
  | StackVar<T>
  | Local<T>
  | AnyGlobal<T>
  | JSValue<T>;

function isLocal(x: any): x is Local<ValueType> {
  return typeof x === "object" && x !== null && "index" in x;
}
function isGlobal(x: any): x is AnyGlobal<ValueType> {
  return (
    typeof x === "object" &&
    x !== null &&
    (x.kind === "global" || x.kind === "importGlobal")
  );
}
function isStackVar(x: any): x is StackVar<ValueType | Unknown> {
  return typeof x === "object" && x !== null && x.kind === "stack-var";
}

/**
 * instruction that is completely fixed
 */
function instruction<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>
>(
  string: InstructionName,
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
  let instr = { in: valueTypeLiterals(args), out: valueTypeLiterals(results) };
  let createInstr = baseInstruction<undefined, [], [], Args, Results>(
    string,
    Undefined,
    { create: () => instr }
  );
  function createInstr_(
    ctx: LocalContext,
    ...actualArgs: Input<ValueType>[]
  ): Instruction_<Args, Results> {
    processStackArgs(ctx, string, instr.in, actualArgs);
    return createInstr(ctx);
  }
  return createInstr_ as any;
}

function processStackArgs(
  ctx: LocalContext,
  string: string,
  expectedArgs: ValueType[],
  actualArgs: Input<ValueType>[]
) {
  let n = expectedArgs.length;
  if (actualArgs.length !== 0 && actualArgs.length !== n) {
    throw Error(
      `${string}: Expected 0 or ${n} arguments, got ${actualArgs.length}.`
    );
  }
  if (actualArgs.length !== 0) {
    for (let i = 0; i < n; i++) {
      let x = actualArgs[i];
      let type = expectedArgs[i];
      if (isLocal(x)) {
        if (x.type !== type)
          throw Error(
            `${string}: Expected type ${type}, got local of type ${x.type}.`
          );
        localGet(ctx, x);
      } else if (isGlobal(x)) {
        if (x.type.value !== type)
          throw Error(
            `${string}: Expected type ${type}, got global of type ${x.type.value}.`
          );
        globalGet(ctx, x);
      } else if (isStackVar(x)) {
        if (x.type !== type && x.type !== Unknown)
          throw Error(
            `${string}: Expected argument of type ${type}, got ${x.type}.`
          );
      } else {
        // could be const
        let Unsupported = Error(
          `${string}: Unsupported input for type ${type}, got ${x}.`
        );
        switch (type) {
          case "i32":
            if (typeof x !== "number") throw Unsupported;
            i32Const(ctx, x);
            break;
          case "i64":
            if (typeof x !== "bigint") throw Unsupported;
            i64Const(ctx, x);
            break;
          case "f32":
            if (typeof x !== "number") throw Unsupported;
            f32Const(ctx, x);
            break;
          case "f64":
            if (typeof x !== "number") throw Unsupported;
            f64Const(ctx, x);
            break;
          case "v128":
          case "funcref":
          case "externref":
          default:
            throw Unsupported;
        }
      }
    }
  }
}
