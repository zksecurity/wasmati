import { type Code, createCode } from "./code.ts";
import type * as Dependency from "./dependency.ts";
import type { InstructionName } from "./instruction/opcodes.ts";
import { isSubtype, printValueType, typeEquals, ValueType } from "./types.ts";

export {
  type LocalContext,
  type StackType,
  StackVar,
  StackValue,
  popOne,
  isStackVar,
  pushResult,
  type StackVars,
  stackVars,
  Unknown,
  type Label,
  type RandomLabel,
  popStack,
  popTypes,
  popUnknown,
  checkStack,
  pushStack,
  setUnreachable,
  labelTypes,
  getFrameFromLabel,
  emptyContext,
  withContext,
  isNumberType,
  isVectorType,
  isSameType,
  formatStack,
  checkSynchronous,
  missingLocal,
};

/** The type of a value in unreachable code, which matches any type (the spec's "bottom"). */
type Unknown = "unknown";
const Unknown = "unknown";
type StackType = ValueType | Unknown;
type RandomLabel = `0.${string}`;
type Label = "top" | RandomLabel;

type StackVar<T> = {
  kind: "stack-var";
  type: T;
};

type ControlFrame = {
  label: Label; // unique id
  opcode: InstructionName | "function" | "else";
  startTypes: ValueType[];
  endTypes: ValueType[];
  unreachable: boolean;
  stack: StackVar<StackType>[];
};

type LocalContext = {
  locals: ValueType[];
  deps: Set<Dependency.t>;
  /** Functions that the code calls directly. */
  calls: Set<Dependency.AnyFunc>;
  code: Code;
  stack: StackVar<StackType>[]; // === frames[0].stack
  frames: ControlFrame[];
  return: ValueType[] | null;
  /** The instructions that the code may use, if not all, as in constant expressions. */
  allowed?: Set<string>;
};

const idle =
  "no function or constant is being built with this instance of the builder API. Call instructions in the body of func() or constant(), with the instance that builds it.";

/** The code of an instance that builds nothing, without room that instructions could write to. */
function idleCode(): Code {
  return { ...createCode(0), fixed: idle };
}

/** A local that is not among the function's locals, or used where no function is being built. */
function missingLocal(ctx: LocalContext, index: number) {
  return Error(ctx.frames.length === 0 ? idle : `local with index ${index} not available`);
}

function emptyContext(): LocalContext {
  return {
    locals: [],
    code: idleCode(),
    deps: new Set(),
    calls: new Set(),
    return: [],
    stack: [],
    frames: [],
    // Present, so that contexts that restrict instructions restore it.
    allowed: undefined,
  };
}

// this should be replaced with simpler withFunc / withBlock for the two use cases
function withContext(
  ctx: LocalContext,
  override: Partial<LocalContext>,
  run: (ctx: LocalContext) => void,
): LocalContext {
  let oldCtx = { ...ctx };
  Object.assign(ctx, override);
  if (ctx.frames.length === 0) throw Error("invariant violation: frames must not be empty");
  if (ctx.stack !== ctx.frames[0].stack)
    throw Error("invariant violation: stack does not equal the stack on the current top frame");
  let resultCtx: LocalContext;
  try {
    run(ctx);
    resultCtx = { ...ctx };
  } finally {
    Object.assign(ctx, oldCtx);
  }
  return resultCtx;
}

/**
 * Pop values of the given types and return the types actually popped. In unreachable code, popping
 * below the frame yields Unknown, and Unknown matches any type.
 */
/** Pop values of the given types; errors name the instruction, if given. */
function popStack(ctx: LocalContext, values: StackType[], instruction?: string): StackType[] {
  let { frames } = ctx;
  let popped: StackType[] = [];
  for (let i = values.length - 1; i >= 0; i--) {
    let stackValue = ctx.stack.pop();
    let value = values[i];
    if (
      (stackValue === undefined && !frames[0].unreachable) ||
      (stackValue !== undefined && !isAssignable(stackValue.type, value))
    ) {
      throw Error(
        `${instruction === undefined ? "" : `${instruction}: `}expected ${format(value)} on the stack, got ${stackValue === undefined ? "nothing" : format(stackValue.type)}`,
      );
    }
    popped.unshift(stackValue?.type ?? Unknown);
  }
  return popped;
}

/**
 * Pop values of the given types, like `popStack`, without returning their types, or of the first
 * `count` types. Errors name the instruction, if given.
 */
function popTypes(
  ctx: LocalContext,
  values: StackType[],
  instruction?: string,
  count = values.length,
) {
  let { stack } = ctx;
  let frame: ControlFrame | undefined = ctx.frames[0];
  for (let i = count - 1; i >= 0; i--) {
    let value = stack.pop();
    let expected = values[i];
    if (value === undefined) {
      if (frame?.unreachable) continue;
      throw Error(
        `${instruction === undefined ? "" : `${instruction}: `}expected ${format(expected)} on the stack, got nothing`,
      );
    }
    let { type } = value;
    if (type !== expected && !isAssignable(type, expected))
      throw Error(
        `${instruction === undefined ? "" : `${instruction}: `}expected ${format(expected)} on the stack, got ${format(type)}`,
      );
  }
}

/** Pop one value of the given type. */
function popOne(ctx: LocalContext, expected: StackType, instruction: string) {
  let value = ctx.stack.pop();
  if (value === undefined) {
    if (ctx.frames[0]?.unreachable) return;
    throw Error(`${instruction}: expected ${format(expected)} on the stack, got nothing`);
  }
  let { type } = value;
  if (type !== expected && !isAssignable(type, expected))
    throw Error(`${instruction}: expected ${format(expected)} on the stack, got ${format(type)}`);
}

/**
 * Check that the stack has values of the given types, and leave them in place, as the same values. In
 * unreachable code, missing values become values of Unknown type.
 */
function checkStack(ctx: LocalContext, values: StackType[]) {
  let kept = ctx.stack.slice(Math.max(0, ctx.stack.length - values.length));
  let popped = popStack(ctx, values);
  pushStack(ctx, popped.slice(0, popped.length - kept.length));
  ctx.stack.push(...kept);
}

function popUnknown(ctx: LocalContext): ValueType | Unknown {
  let { frames } = ctx;
  let stackValue = ctx.stack.pop();
  if (stackValue === undefined && frames[0].unreachable) {
    return Unknown;
  }
  if (stackValue === undefined) {
    throw Error(`expected value on the stack, got nothing`);
  }
  return stackValue.type;
}

function pushStack({ stack }: LocalContext, values: StackType[]): StackVar<StackType>[] {
  let pushed: StackVar<StackType>[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let value = StackVar(values[i]);
    pushed[i] = value;
    stack.push(value);
  }
  return pushed;
}

/** Called while creating the instruction that ends reachability, before it is in the body. */
function setUnreachable(ctx: LocalContext) {
  ctx.stack.splice(0, ctx.stack.length);
  ctx.frames[0].unreachable = true;
}

function labelTypes(frame: ControlFrame) {
  return frame.opcode === "loop" ? frame.startTypes : frame.endTypes;
}

function getFrameFromLabel(ctx: LocalContext, label: Label | number): [number, ControlFrame] {
  if (typeof label === "number") {
    let frame = ctx.frames[label];
    if (frame === undefined) throw Error(`no block found for label ${label}`);
    return [label, frame];
  } else {
    let i = ctx.frames.findIndex((f) => f.label === label);
    if (i === -1) throw Error(`no block found for label ${label}`);
    return [i, ctx.frames[i]];
  }
}

/** Stack values are instances of a class, which tells them apart from other operands quickly. */
class Value<T> {
  get kind() {
    return "stack-var" as const;
  }
  type: T;
  constructor(type: T) {
    this.type = type;
  }
}

/**
 * The class of stack values, which all copies of wasmati in a JS realm share through a global
 * symbol: values of one copy are operands of another, like `$` imported by a library that bundles its
 * own wasmati. The symbol's version changes where stack values change.
 */
const StackValue: typeof Value = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("wasmati.StackValue@2")
] ??= Value) as typeof Value;

/** Push the result of an instruction. */
function pushResult<T extends StackType>(ctx: LocalContext, type: T): StackVar<T> {
  let value = new StackValue(type);
  ctx.stack.push(value);
  return value;
}

function StackVar<T extends ValueType | Unknown>(type: T): StackVar<T> {
  return new StackValue(type);
}

function isStackVar(x: unknown): x is StackVar<StackType> {
  return x instanceof StackValue;
}

type StackVars<Results extends readonly ValueType[]> = {
  [k in keyof Results]: StackVar<Results[k]>;
};

/** The parameters of a block, which are on its stack at the start of its body. */
function stackVars(types: ValueType[]) {
  return types.map(StackVar);
}

// helpers

/**
 * Bodies of functions, blocks and constants run synchronously, in the context of what they build.
 * Instructions after an `await` would go into whatever is being built at that time.
 */
function checkSynchronous(result: unknown, what: string) {
  if (result instanceof Promise)
    throw Error(
      `${what}: the body returned a promise. Bodies must be synchronous; instructions after an \`await\` would go into whatever is being built at that time.`,
    );
}

function isNumberType(type: ValueType | Unknown) {
  return type === "i32" || type === "i64" || type === "f32" || type === "f64" || type === Unknown;
}

function isVectorType(type: ValueType | Unknown) {
  return type === "v128" || type === Unknown;
}

function isSameType(t1: ValueType | Unknown, t2: ValueType | Unknown) {
  return t1 === Unknown || t2 === Unknown || typeEquals(t1, t2);
}

/** Whether a value of type `actual` can be used where `expected` is required. */
function isAssignable(actual: StackType, expected: StackType) {
  return actual === Unknown || expected === Unknown || isSubtype(actual, expected);
}

function formatStack(stack: StackVar<StackType>[]): string {
  return `[${stack.map((v) => (v.type === Unknown ? v.type : printValueType(v.type))).join(",")}]`;
}

function format(type: StackType): string {
  return type === Unknown ? type : printValueType(type);
}
