import { Code } from "./code.ts";
import type * as Dependency from "./dependency.ts";
import type { InstructionName } from "./instruction/opcodes.ts";
import { isSubtype, printValueType, typeEquals, ValueType } from "./types.ts";

export {
  type LocalContext,
  type StackType,
  StackVar,
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
  placeResults,
  emptyContext,
  withContext,
  isNumberType,
  isVectorType,
  isSameType,
  formatStack,
  placeOf,
  place,
  shiftPlaces,
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
  /** The start of the earliest value popped by the instruction being created, see `Placed`. */
  popsFrom?: number;
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

function emptyContext(): LocalContext {
  return {
    locals: [],
    code: new Code(64),
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
 * Values that an instruction pushed or passed through follow it, after it was written from `start`.
 * They are computed from where its earliest operand was.
 */
function placeResults(ctx: LocalContext, start: number) {
  let { stack, code } = ctx;
  let frame: ControlFrame | undefined = ctx.frames[0];
  let from = start;
  if (frame !== undefined) {
    if (frame.popsFrom !== undefined && frame.popsFrom < start) from = frame.popsFrom;
    frame.popsFrom = undefined;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    let value = placed(stack[i]);
    if (value.end >= 0) break;
    value.end = code.length;
    if (value.start < 0) value.start = from;
  }
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
    let stackValue = popValue(ctx);
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
 * Pop values of the given types, like `popStack`, without returning their types. Errors name the
 * instruction, if given.
 */
function popTypes(ctx: LocalContext, values: StackType[], instruction?: string) {
  let { stack } = ctx;
  let frame: ControlFrame | undefined = ctx.frames[0];
  for (let i = values.length - 1; i >= 0; i--) {
    let value = stack.pop() as Placed | undefined;
    let expected = values[i];
    if (value === undefined) {
      if (frame?.unreachable) continue;
      throw Error(
        `${instruction === undefined ? "" : `${instruction}: `}expected ${format(expected)} on the stack, got nothing`,
      );
    }
    let { type, start } = value;
    if (type !== expected && !isAssignable(type, expected))
      throw Error(
        `${instruction === undefined ? "" : `${instruction}: `}expected ${format(expected)} on the stack, got ${format(type)}`,
      );
    if (start >= 0 && frame !== undefined && !(frame.popsFrom! <= start)) frame.popsFrom = start;
  }
}

/**
 * Check that the stack has values of the given types, and leave them in place, as the same values. In
 * unreachable code, missing values become values of Unknown type.
 */
function checkStack(ctx: LocalContext, values: StackType[]) {
  let kept = ctx.stack.slice(Math.max(0, ctx.stack.length - values.length));
  let popped = popStack(ctx, values);
  pushStack(ctx, popped.slice(0, popped.length - kept.length));
  // The values pass through the instruction, so they follow it.
  kept.forEach((value) => (placed(value).end = -1));
  ctx.stack.push(...kept);
}

/** Pop a value, which the instruction being created computes from. */
function popValue(ctx: LocalContext): StackVar<StackType> | undefined {
  let value = ctx.stack.pop();
  let start = value && placed(value).start;
  let frame: ControlFrame | undefined = ctx.frames[0];
  if (start !== undefined && start >= 0 && frame !== undefined)
    frame.popsFrom = Math.min(frame.popsFrom ?? start, start);
  return value;
}

function popUnknown(ctx: LocalContext): ValueType | Unknown {
  let { frames } = ctx;
  let stackValue = popValue(ctx);
  if (stackValue === undefined && frames[0].unreachable) {
    return Unknown;
  }
  if (stackValue === undefined) {
    throw Error(`expected value on the stack, got nothing`);
  }
  return stackValue.type;
}

function pushStack({ stack }: LocalContext, values: StackType[]): StackVar<StackType>[] {
  let pushed: StackVar<StackType>[] = [];
  for (let type of values) {
    let value = StackVar(type);
    pushed.push(value);
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
class StackValue<T> {
  get kind() {
    return "stack-var" as const;
  }
  type: T;
  start: number;
  end: number;
  constructor(type: T, start = -1, end = -1) {
    this.type = type;
    this.start = start;
    this.end = end;
  }
}

/**
 * Push the result of an instruction that was written from `start` to the end of the code, after its
 * operands were popped, and before any other instruction.
 */
function pushResult<T extends StackType>(ctx: LocalContext, type: T, start: number): StackVar<T> {
  let frame: ControlFrame | undefined = ctx.frames[0];
  let from = start;
  if (frame !== undefined && frame.popsFrom !== undefined) {
    if (frame.popsFrom < start) from = frame.popsFrom;
    frame.popsFrom = undefined;
  }
  let value = new StackValue(type, from, ctx.code.length);
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

/** The parameters of a block, which are on its stack at the start of its body, at `position`. */
function stackVars(types: ValueType[], position: number) {
  let values = types.map(StackVar);
  values.forEach((value) => place(value, position, position));
  return values;
}

/**
 * Where each stack value is computed in the code of its function: from `start`, where the stack has
 * the values below it, to `end`, right after the instruction that pushed it or last passed it through.
 * Instructions inserted at `start` compute a value between the value and the ones below. Both are -1
 * until the instruction is written. They are properties of the values, but not of their type.
 */
type Placed = StackVar<StackType> & { start: number; end: number };

function placed(value: StackVar<StackType>): Placed {
  return value as Placed;
}

function placeOf(value: StackVar<StackType>): { start: number; end: number } {
  let { start, end } = placed(value);
  if (start < 0 || end < 0)
    throw Error("invariant violation: stack value without a place in the body");
  return { start, end };
}

/** Place a value, by default one computed by an instruction inserted at `start`. */
function place(value: StackVar<StackType>, start: number, end = start + 1) {
  Object.assign(placed(value), { start, end });
}

/** Values computed from `position` on move by `n` bytes, after code is inserted there. */
function shiftPlaces(ctx: LocalContext, position: number, n: number) {
  for (let value of ctx.stack) {
    let { start, end } = placeOf(value);
    if (start >= position) placed(value).start = start + n;
    if (end > position) placed(value).end = end + n;
  }
}

// helpers

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
