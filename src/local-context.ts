import * as Dependency from "./dependency.js";
import { InstructionName } from "./instruction/opcodes.js";
import { ValueType } from "./types.js";

export {
  LocalContext,
  Label,
  RandomLabel,
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
};

type Unknown = "unknown";
const Unknown = "unknown";
type RandomLabel = `0.${string}`;
type Label = "top" | RandomLabel;

type ControlFrame = {
  label: Label; // unique id
  opcode: InstructionName | "function" | "else";
  startTypes: ValueType[];
  endTypes: ValueType[];
  unreachable: boolean;
  stack: ValueType[];
};

type LocalContext = {
  locals: ValueType[];
  deps: Dependency.t[];
  body: Dependency.Instruction[];
  stack: ValueType[]; // === frames[0].stack
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
  run: (ctx: LocalContext) => void
): LocalContext {
  let oldCtx = { ...ctx };
  Object.assign(ctx, override);
  if (ctx.frames.length === 0)
    throw Error("invariant violation: frames must not be empty");
  if (ctx.stack !== ctx.frames[0].stack)
    throw Error(
      "invariant violation: stack does not equal the stack on the current top frame"
    );
  let resultCtx: LocalContext;
  try {
    run(ctx);
    resultCtx = { ...ctx };
  } finally {
    Object.assign(ctx, oldCtx);
  }
  return resultCtx;
}

function pushInstruction(ctx: LocalContext, instr: Dependency.Instruction) {
  let { body, deps } = ctx;
  popStack(ctx, instr.type.args);
  pushStack(ctx, instr.type.results);
  body.push(instr);
  for (let dep of instr.deps) {
    if (!deps.includes(dep)) {
      deps.push(dep);
    }
  }
}

function popStack(
  { stack, frames }: LocalContext,
  values: ValueType[]
): ValueType[] {
  // TODO nicer errors, which display entire stack vs entire instruction signature
  let popped: ValueType[] = [];
  let reversed = [...values].reverse();
  for (let value of reversed) {
    let stackValue = stack.pop();
    if (stackValue === undefined && frames[0].unreachable) {
      // implicitly returning 'unknown'
      popped.unshift(value);
    } else if (stackValue === undefined || value !== stackValue) {
      throw Error(
        `expected ${value} on the stack, got ${stackValue ?? "nothing"}`
      );
    } else {
      popped.unshift(value);
    }
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
  return stackValue;
}

function pushStack({ stack }: LocalContext, values: ValueType[]) {
  stack.push(...values);
}

function setUnreachable(ctx: LocalContext) {
  ctx.stack.splice(0, ctx.stack.length);
  ctx.frames[0].unreachable = true;
}

function labelTypes(frame: ControlFrame) {
  return frame.opcode === "loop" ? frame.startTypes : frame.endTypes;
}

function getFrameFromLabel(
  ctx: LocalContext,
  label: Label | number
): [number, ControlFrame] {
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

function isNumberType(type: ValueType | Unknown) {
  return (
    type === "i32" ||
    type === "i64" ||
    type === "f32" ||
    type === "f64" ||
    type === Unknown
  );
}

function isVectorType(type: ValueType | Unknown) {
  return type === "v128" || type === Unknown;
}

function isSameType(t1: ValueType | Unknown, t2: ValueType | Unknown) {
  return t1 === t2 || t1 === Unknown || t2 === Unknown;
}
