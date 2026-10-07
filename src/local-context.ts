import type * as Dependency from "./dependency.ts";
import type { InstructionName } from "./instruction/opcodes.ts";
import { isSubtype, printValueType, typeEquals, ValueType } from "./types.ts";

export {
  type LocalContext,
  type StackType,
  StackVar,
  type StackVars,
  stackVars,
  Unknown,
  type Label,
  type RandomLabel,
  popStack,
  popUnknown,
  checkStack,
  pushStack,
  setUnreachable,
  labelTypes,
  getFrameFromLabel,
  pushInstruction,
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
  id: number;
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
  /** The start of the earliest value popped by the instruction being created, see `starts`. */
  popsFrom?: number;
};

type LocalContext = {
  locals: ValueType[];
  deps: Dependency.t[];
  body: Dependency.Instruction[];
  stack: StackVar<StackType>[]; // === frames[0].stack
  frames: ControlFrame[];
  return: ValueType[] | null;
};

function emptyContext(): LocalContext {
  return {
    locals: [],
    body: [],
    deps: [],
    return: [],
    stack: [],
    frames: [],
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

/** Apply an instruction to the stack, and return its results, which are the new stack entries. */
function pushInstruction(ctx: LocalContext, instr: Dependency.Instruction): StackVar<StackType>[] {
  let { body, deps, stack } = ctx;
  popStack(ctx, instr.type.args, instr.string);
  let results = pushStack(ctx, instr.type.results);
  let frame: ControlFrame | undefined = ctx.frames[0];
  let start = Math.min(frame?.popsFrom ?? body.length, body.length);
  if (frame !== undefined) frame.popsFrom = undefined;
  body.push(instr);
  // Values that the instruction pushed or passed through follow it.
  for (let i = stack.length - 1; i >= 0 && !ends.has(stack[i]); i--) {
    ends.set(stack[i], body.length);
    if (!starts.has(stack[i])) starts.set(stack[i], start);
  }
  for (let dep of instr.deps) {
    if (!deps.includes(dep)) {
      deps.push(dep);
    }
  }
  return results;
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
 * Check that the stack has values of the given types, and leave them in place, as the same values. In
 * unreachable code, missing values become values of Unknown type.
 */
function checkStack(ctx: LocalContext, values: StackType[]) {
  let kept = ctx.stack.slice(Math.max(0, ctx.stack.length - values.length));
  let popped = popStack(ctx, values);
  pushStack(ctx, popped.slice(0, popped.length - kept.length));
  // The values pass through the instruction, so they follow it.
  kept.forEach((value) => ends.delete(value));
  ctx.stack.push(...kept);
}

/** Pop a value, which the instruction being created computes from. */
function popValue(ctx: LocalContext): StackVar<StackType> | undefined {
  let value = ctx.stack.pop();
  let start = value && starts.get(value);
  let frame: ControlFrame | undefined = ctx.frames[0];
  if (start !== undefined && frame !== undefined)
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
  let stackVars = values.map(StackVar);
  stack.push(...stackVars);
  return stackVars;
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

function StackVar<T extends ValueType | Unknown>(type: T): StackVar<T> {
  return { kind: "stack-var", id: id(), type };
}

type StackVars<Results extends readonly ValueType[]> = {
  [k in keyof Results]: StackVar<Results[k]>;
};

/** The parameters of a block, which are on its stack at the start of its body. */
function stackVars(types: ValueType[]) {
  let values = types.map(StackVar);
  values.forEach((value) => {
    starts.set(value, 0);
    ends.set(value, 0);
  });
  return values;
}

/**
 * Where each stack value is computed in the body of its block: from `start`, where the stack has the
 * values below it, to `end`, right after the instruction that pushed it or last passed it through.
 * Instructions inserted at `start` compute a value between the value and the ones below.
 */
const starts = new WeakMap<StackVar<StackType>, number>();
const ends = new WeakMap<StackVar<StackType>, number>();

function placeOf(value: StackVar<StackType>): { start: number; end: number } {
  let start = starts.get(value);
  let end = ends.get(value);
  if (start === undefined || end === undefined)
    throw Error("invariant violation: stack value without a place in the body");
  return { start, end };
}

/** Place a value that was computed by an instruction inserted at `start`. */
function place(value: StackVar<StackType>, start: number) {
  starts.set(value, start);
  ends.set(value, start + 1);
}

/** Values computed from `position` on move by one, after an instruction is inserted there. */
function shiftPlaces(ctx: LocalContext, position: number) {
  for (let value of ctx.stack) {
    let { start, end } = placeOf(value);
    if (start >= position) starts.set(value, start + 1);
    if (end > position) ends.set(value, end + 1);
  }
}

let i = 0;
function id() {
  return i++;
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
