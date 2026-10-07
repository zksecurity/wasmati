import { record, tuple, Undefined } from "../binable.ts";
import * as Dependency from "../dependency.ts";
import type { AnyFunc } from "../func-types.ts";
import { vec } from "../immediate.ts";
import {
  getFrameFromLabel,
  type Label,
  labelTypes,
  popStack,
  popUnknown,
  Unknown,
  pushStack,
  type RandomLabel,
  setUnreachable,
  isNumberType,
  isVectorType,
  isSameType,
  type LocalContext,
} from "../local-context.ts";
import {
  FunctionIndex,
  LabelIndex,
  TableIndex,
  TypeIndex,
  addressType,
  type FunctionType,
  isRefType,
  isSubtype,
  printValueType,
  referenced,
  refType,
  type RefType,
  ValueType,
  valueTypeLiteral,
  type ValueTypeObject,
} from "../types.ts";
import {
  baseInstruction,
  createExpressionWithType,
  type FunctionTypeInput,
  resolveExpression,
  baseInstructionWithImmediate,
  typeFromInput,
  type Instruction_,
} from "./base.ts";
import { Block, IfBlock } from "./binable.ts";
import { type Input, processStackArgs } from "./stack-args.ts";

export { control, bindControlOps, parametric };

// control instructions

const nop = baseInstructionWithImmediate("nop", Undefined, [], []);

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
    runElse?: (label: RandomLabel) => void,
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
    elseBody?: Dependency.Instruction[],
  ) {
    let ifDepsLength = ifBody.reduce((acc, i) => acc + i.deps.length, 0);
    let if_ = resolveExpression(deps.slice(0, ifDepsLength), ifBody);
    let else_ = elseBody && resolveExpression(deps.slice(ifDepsLength), elseBody);
    return { blockType, instructions: { if: if_, else: else_ } };
  },
});

const br = baseInstruction("br", LabelIndex, {
  create(ctx, label: Label | number) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    popStack(ctx, types);
    setUnreachable(ctx);
    return { in: [], out: [], resolveArgs: [i] };
  },
});

const br_if = baseInstruction("br_if", LabelIndex, {
  create(ctx, label: Label | number) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    return { in: [...types, "i32"], out: types, resolveArgs: [i] };
  },
});

const LabelTable = record({ indices: vec(LabelIndex), defaultIndex: LabelIndex });
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

const call = baseInstruction("call", FunctionIndex, {
  create(_, func: Dependency.AnyFunc) {
    return { in: func.type.args, out: func.type.results, deps: [func] };
  },
  resolve: ([funcIndex]) => funcIndex,
});

const call_indirect = baseInstruction("call_indirect", tuple([TypeIndex, TableIndex]), {
  create(_, table: Dependency.AnyTable, type: FunctionTypeInput) {
    let t = typeFromInput(type);
    return {
      in: [...t.args, addressType(table.type.limits)],
      out: t.results,
      deps: [Dependency.type(t), table],
    };
  },
  resolve: ([typeIdx, tableIdx]) => [typeIdx, tableIdx],
});

/** A tail call returns the callee's results from the current function, so they must fit its results. */
function tailCall(ctx: LocalContext, type: FunctionType, operands: ValueType[]) {
  if (ctx.return === null) throw Error("tail call outside a function");
  const fits =
    type.results.length === ctx.return.length &&
    type.results.every((result, i) => isSubtype(result, ctx.return![i]));
  if (!fits) throw Error("tail call: the callee's results must match the function's results");
  popStack(ctx, [...type.args, ...operands]);
  setUnreachable(ctx);
}

const return_call = baseInstruction("return_call", FunctionIndex, {
  create(ctx, func: Dependency.AnyFunc) {
    tailCall(ctx, func.type, []);
    return { in: [], out: [], deps: [func] };
  },
  resolve: ([funcIndex]) => funcIndex,
});

const return_call_indirect = baseInstruction(
  "return_call_indirect",
  tuple([TypeIndex, TableIndex]),
  {
    create(ctx, table: Dependency.AnyTable, type: FunctionTypeInput) {
      let t = typeFromInput(type);
      tailCall(ctx, t, [addressType(table.type.limits)]);
      return { in: [], out: [], deps: [Dependency.type(t), table] };
    },
    resolve: ([typeIdx, tableIdx]) => [typeIdx, tableIdx],
  },
);

/** Call a function reference of the given type. */
const call_ref = baseInstruction("call_ref", TypeIndex, {
  create(_, type: FunctionTypeInput) {
    let t = typeFromInput(type);
    return {
      in: [...t.args, refType(t, true)],
      out: t.results,
      deps: [Dependency.type(t)],
    };
  },
  resolve: ([typeIdx]) => typeIdx,
});

const return_call_ref = baseInstruction("return_call_ref", TypeIndex, {
  create(ctx, type: FunctionTypeInput) {
    let t = typeFromInput(type);
    tailCall(ctx, t, [refType(t, true)]);
    return { in: [], out: [], deps: [Dependency.type(t)] };
  },
  resolve: ([typeIdx]) => typeIdx,
});

/** Pop a reference, which may be unknown in unreachable code. */
function popReference(ctx: LocalContext): RefType | Unknown {
  let type = popUnknown(ctx);
  if (type !== Unknown && !isRefType(type))
    throw Error(`expected a reference on the stack, got ${printValueType(type)}`);
  return type;
}

function nonNull(type: RefType | Unknown): ValueType | Unknown {
  return type === Unknown ? Unknown : refType(referenced(type).ref, false);
}

/** Branch if the reference is null; otherwise continue with it as non-null. */
const br_on_null = baseInstruction("br_on_null", LabelIndex, {
  create(ctx, label: Label | number) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let reference = popReference(ctx);
    pushStack(ctx, popStack(ctx, labelTypes(frame)));
    pushStack(ctx, [nonNull(reference)]);
    return { in: [], out: [], resolveArgs: [i] };
  },
});

/** Branch with the reference if it is not null; otherwise continue without it. */
const br_on_non_null = baseInstruction("br_on_non_null", LabelIndex, {
  create(ctx, label: Label | number) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    let target = types.at(-1);
    if (target === undefined || !isRefType(target))
      throw Error("br_on_non_null: the label's last type must be a reference");
    let reference = nonNull(popReference(ctx));
    if (reference !== Unknown && !isSubtype(reference, target))
      throw Error(
        `br_on_non_null: expected ${printValueType(target)}, got ${printValueType(reference)}`,
      );
    pushStack(ctx, popStack(ctx, types.slice(0, -1)));
    return { in: [], out: [], resolveArgs: [i] };
  },
});

function bindControlOps(ctx: LocalContext) {
  return {
    call: <F extends AnyFunc<any, any>>(
      func: F,
      args?: { [K in keyof F["params"]["values"]]: Input<F["params"]["values"][K]> },
    ): Instruction_<F["type"]["args"], F["type"]["results"]> => {
      if (args !== undefined) {
        processStackArgs(
          ctx,
          "call",
          func.type.args,
          func.params.names.map((name: string) => args[name]) as Input<ValueType>[],
        );
      }
      return call(ctx, func) as any;
    },
  };
}

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
  // call,
  call_indirect,
  call_ref,
  return_call,
  return_call_indirect,
  return_call_ref,
  br_on_null,
  br_on_non_null,
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
    if (!((isNumberType(t1) && isNumberType(t2)) || (isVectorType(t1) && isVectorType(t2)))) {
      throw Error(
        `select: polymorphic select can only be applied to number or vector types, got ${t1} and ${t2}.`,
      );
    }
    if (!isSameType(t1, t2)) {
      throw Error(`select: types must be equal, got ${t1} and ${t2}.`);
    }
    // In unreachable code both operands may be unknown, and so is the result.
    let t = t1 !== Unknown ? t1 : t2;
    // The operands were popped above.
    return { in: [] as any as ["i32", ValueType], out: [t as ValueType] };
  },
  resolve: () => undefined,
});
const select_t = baseInstruction("select_t", vec(ValueType), {
  create(_: LocalContext, t: ValueTypeObject) {
    let t_ = valueTypeLiteral(t);
    return { in: [t_, t_, "i32"], out: [t_], resolveArgs: [[t_]] };
  },
});

const parametric = { drop, select_t, select_poly };
