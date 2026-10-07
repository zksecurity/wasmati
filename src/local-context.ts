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
  let { body, deps } = ctx;
  popStack(ctx, instr.type.args, instr.string);
  let results = pushStack(ctx, instr.type.results);
  body.push(instr);
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
function popStack(
  { stack, frames }: LocalContext,
  values: StackType[],
  instruction?: string,
): StackType[] {
  let popped: StackType[] = [];
  for (let i = values.length - 1; i >= 0; i--) {
    let stackValue = stack.pop();
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

function popUnknown({ stack, frames }: LocalContext): ValueType | Unknown {
  let stackValue = stack.pop();
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

function stackVars(types: ValueType[]) {
  return types.map(StackVar);
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
