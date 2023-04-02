import { record, tuple, Undefined } from "../binable.js";
import * as Dependency from "../dependency.js";
import { U32, vec } from "../immediate.js";
import {
  getFrameFromLabel,
  Label,
  labelTypes,
  popStack,
  popUnknown,
  pushStack,
  RandomLabel,
  setUnreachable,
  isNumberType,
  isVectorType,
  isSameType,
  LocalContext,
} from "../local-context.js";
import { ValueType, valueTypeLiteral, ValueTypeObject } from "../types.js";
import {
  baseInstruction,
  createExpressionWithType,
  FunctionTypeInput,
  resolveExpression,
  instructionWithArg,
  typeFromInput,
} from "./base.js";
import { Block, IfBlock } from "./binable.js";

export { control, parametric };

// control instructions

const nop = instructionWithArg("nop", Undefined, [], []);

const unreachable = baseInstruction("unreachable", Undefined, {
  create(ctx) {
    setUnreachable(ctx);
    return { in: [], out: [] };
  },
  resolve: () => undefined,
});

const block = baseInstruction("block", Block, {
  create(ctx, t: FunctionTypeInput, run: (label: RandomLabel) => void) {
    let { type, body, deps } = createExpressionWithType("block", ctx, t, run);
    return {
      in: type.args,
      out: type.results,
      deps: [Dependency.type(type), ...deps],
      resolveArgs: [body],
    };
  },
  resolve([blockType, ...deps], body: Dependency.Instruction[]) {
    let instructions = resolveExpression(deps, body);
    return { blockType, instructions };
  },
});

const loop = baseInstruction("loop", Block, {
  create(ctx, t: FunctionTypeInput, run: (label: RandomLabel) => void) {
    let { type, body, deps } = createExpressionWithType("loop", ctx, t, run);
    return {
      in: type.args,
      out: type.results,
      deps: [Dependency.type(type), ...deps],
      resolveArgs: [body],
    };
  },
  resolve([blockType, ...deps], body: Dependency.Instruction[]) {
    let instructions = resolveExpression(deps, body);
    return { blockType, instructions };
  },
});

const if_ = baseInstruction("if", IfBlock, {
  create(
    ctx,
    t: FunctionTypeInput,
    runIf: (label: RandomLabel) => void,
    runElse?: (label: RandomLabel) => void
  ) {
    popStack(ctx, ["i32"]);
    let { type, body, deps } = createExpressionWithType("if", ctx, t, runIf);
    let ifArgs = [...type.args, "i32"] as [...ValueType[], "i32"];
    if (runElse === undefined) {
      pushStack(ctx, ["i32"]);
      return {
        in: ifArgs,
        out: type.results,
        deps: [Dependency.type(type), ...deps],
        resolveArgs: [body, undefined],
      };
    }
    let elseExpr = createExpressionWithType("else", ctx, t, runElse);
    pushStack(ctx, ["i32"]);
    return {
      in: ifArgs,
      out: type.results,
      deps: [Dependency.type(type), ...deps, ...elseExpr.deps],
      resolveArgs: [body, elseExpr.body],
    };
  },
  resolve(
    [blockType, ...deps],
    ifBody: Dependency.Instruction[],
    elseBody?: Dependency.Instruction[]
  ) {
    let ifDepsLength = ifBody.reduce((acc, i) => acc + i.deps.length, 0);
    let if_ = resolveExpression(deps.slice(0, ifDepsLength), ifBody);
    let else_ =
      elseBody && resolveExpression(deps.slice(ifDepsLength), elseBody);
    return { blockType, instructions: { if: if_, else: else_ } };
  },
});

const br = baseInstruction("br", U32, {
  create(ctx, label: Label | number) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    popStack(ctx, types);
    setUnreachable(ctx);
    return { in: [], out: [], resolveArgs: [i] };
  },
});

const br_if = baseInstruction("br_if", U32, {
  create(ctx, label: Label | number) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    return { in: [...types, "i32"], out: types, resolveArgs: [i] };
  },
});

const LabelTable = record({ indices: vec(U32), defaultIndex: U32 });
const br_table = baseInstruction("br_table", LabelTable, {
  create(ctx, labels: (Label | number)[], defaultLabel: Label | number) {
    popStack(ctx, ["i32"]);
    let [defaultIndex, defaultFrame] = getFrameFromLabel(ctx, defaultLabel);
    let types = labelTypes(defaultFrame);
    let arity = types.length;
    let indices: number[] = [];
    for (let label of labels) {
      let [j, frame] = getFrameFromLabel(ctx, label);
      indices.push(j);
      let types = labelTypes(frame);
      if (types.length !== arity)
        throw Error("inconsistent length of block label types in br_table");
      pushStack(ctx, popStack(ctx, types));
    }
    popStack(ctx, types);
    setUnreachable(ctx);
    pushStack(ctx, ["i32"]);
    return { in: ["i32"], out: [], resolveArgs: [{ indices, defaultIndex }] };
  },
});

const return_ = baseInstruction("return", Undefined, {
  create(ctx) {
    let type = ctx.return;
    // TODO: do we need this for const expressions?
    if (type === null) throw Error("bug: called return outside a function");
    popStack(ctx, type);
    setUnreachable(ctx);
    return { in: [], out: [] };
  },
  resolve: () => undefined,
});

const call = baseInstruction("call", U32, {
  create(_, func: Dependency.AnyFunc) {
    return { in: func.type.args, out: func.type.results, deps: [func] };
  },
  resolve: ([funcIndex]) => funcIndex,
});

const call_indirect = baseInstruction("call_indirect", tuple([U32, U32]), {
  create(_, table: Dependency.AnyTable, type: FunctionTypeInput) {
    let t = typeFromInput(type);
    return {
      in: [...t.args, "i32"],
      out: t.results,
      deps: [Dependency.type(t), table],
    };
  },
  resolve: ([typeIdx, tableIdx]) => [typeIdx, tableIdx],
});

const control = {
  nop,
  unreachable,
  block,
  loop,
  if: if_,
  br,
  br_if,
  br_table,
  return: return_,
  call,
  call_indirect,
};

// parametric instructions

const drop = baseInstruction("drop", Undefined, {
  create(ctx: LocalContext) {
    popUnknown(ctx);
    // TODO represent "unknown" in possible input types and remove this hack
    return { in: [] as any as [ValueType], out: [] };
  },
  resolve: () => undefined,
});

const select_poly = baseInstruction("select", Undefined, {
  create(ctx: LocalContext) {
    popStack(ctx, ["i32"]);
    let t1 = popUnknown(ctx);
    let t2 = popUnknown(ctx);
    if (
      !(
        (isNumberType(t1) && isNumberType(t2)) ||
        (isVectorType(t1) && isVectorType(t2))
      )
    ) {
      throw Error(
        `select: polymorphic select can only be applied to number or vector types, got ${t1} and ${t2}.`
      );
    }
    if (!isSameType(t1, t2)) {
      throw Error(`select: types must be equal, got ${t1} and ${t2}.`);
    }
    let t: ValueType;
    if (t1 !== "unknown") t = t1;
    else if (t2 !== "unknown") t = t2;
    else
      throw Error(
        "polymorphic select with two unknown types is not implemented."
      );
    // TODO represent "unknown" in possible input types and remove this hack
    return { in: [] as any as ["i32", ValueType], out: [t] };
  },
  resolve: () => undefined,
});
const select_t = baseInstruction("select_t", vec(ValueType), {
  create(_: LocalContext, t: ValueTypeObject) {
    let t_ = valueTypeLiteral(t);
    return { in: ["i32", t_, t_], out: [t_], resolveArgs: [[t_]] };
  },
});

const parametric = { drop, select_t, select_poly };
