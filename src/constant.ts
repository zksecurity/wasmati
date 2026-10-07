import { Code } from "./code.ts";
import type * as Dependency from "./dependency.ts";
import {
  emptyContext,
  formatStack,
  type LocalContext,
  type StackType,
  StackVar,
  Unknown,
  withContext,
} from "./local-context.ts";
import { refOps } from "./instruction/variable.ts";
import { i32Const, i64Const } from "./instruction/const.ts";
import type { AddressType, ValueType } from "./types.ts";

export { constant, constantOffset, constantOf, functionReference, type ConstantInput };

/** Instructions allowed in constant expressions. */
const constantInstructions = new Set([
  "i32.const",
  "i64.const",
  "f32.const",
  "f64.const",
  "v128.const",
  "ref.null",
  "ref.func",
  "ref.i31",
  "global.get",
  "struct.new",
  "struct.new_default",
  "array.new",
  "array.new_default",
  "array.new_fixed",
  "any.convert_extern",
  "extern.convert_any",
  "i32.add",
  "i32.sub",
  "i32.mul",
  "i64.add",
  "i64.sub",
  "i64.mul",
]);

/**
 * A constant expression, such as a global's initializer: run constant instructions of the normal
 * instruction API, leaving one value on the stack. Returning the last value types the constant.
 */
function constant<T extends ValueType = ValueType>(
  ctx: LocalContext,
  run: () => StackVar<T> | void,
): Dependency.Constant<T> {
  let stack: StackVar<StackType>[] = [];
  let type: StackType | undefined;
  let code = new Code(16);
  let deps = new Set<Dependency.t>();
  withContext(
    ctx,
    {
      locals: [],
      code,
      deps,
      calls: new Set(),
      allowed: constantInstructions,
      stack,
      return: null,
      frames: [
        {
          label: "top",
          opcode: "function",
          stack,
          startTypes: [],
          endTypes: [],
          unreachable: false,
        },
      ],
    },
    () => {
      run();
      if (ctx.stack.length !== 1 || ctx.stack[0].type === Unknown)
        throw Error(`constant: expected one value on the stack, got ${formatStack(ctx.stack)}`);
      type = ctx.stack[0].type;
    },
  );
  return { kind: "constant", type: type as T, code, deps: [...deps] };
}

/** Where constants are expected, numbers and functions stand for simple constants. */
type ConstantInput = Dependency.Constant | number | bigint | Dependency.AnyFunc;

/** A segment offset: a constant, or a number of the memory's or table's address type. */
function constantOffset(input: ConstantInput, address: AddressType = "i32"): Dependency.Constant {
  if (typeof input !== "number" && typeof input !== "bigint") return constantOf(input);
  let ctx = emptyContext();
  return constant(ctx, () =>
    address === "i64" ? i64Const(ctx, BigInt(input)) : i32Const(ctx, Number(input)),
  );
}

/** A reference to a function, as a constant. */
function functionReference(func: Dependency.AnyFunc): Dependency.Constant {
  let ctx = emptyContext();
  return constant(ctx, () => refOps.func(ctx, func));
}

/** A constant, or a function as a reference to it. */
function constantOf(input: Dependency.Constant | Dependency.AnyFunc): Dependency.Constant {
  return input.kind === "constant" ? input : functionReference(input);
}
