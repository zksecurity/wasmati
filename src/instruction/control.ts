import { lazy, record, tuple, Undefined, writeByte, writeByteArray } from "../binable.ts";
import * as Dependency from "../dependency.ts";
import type { AnyFunc } from "../func-types.ts";
import { vec } from "../immediate.ts";
import {
  getFrameFromLabel,
  type Label,
  labelTypes,
  popStack,
  checkStack,
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
  TagIndex,
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
  type BaseInstruction,
  checkAllowed,
  emitSimple,
  type FunctionTypeInput,
  type FunctionTypeReference,
  functionTypeOf,
  hasDefinedType,
  baseInstructionWithImmediate,
  runBlock,
  typeFromInput,
  type Instruction_,
} from "./base.ts";
import { Block, BlockType, Catch, ELSE, END, IfBlock, TryTable } from "./binable.ts";
import { type Immediate, addHole } from "../code.ts";
import { type Input, namedInputs, processStackArgs } from "./stack-args.ts";

export { control, bindControlOps, parametric, instructions };

// control instructions

const nop = baseInstructionWithImmediate("nop", Undefined, [], []);

const unreachable = baseInstruction("unreachable", Undefined, {
  create(ctx) {
    setUnreachable(ctx);
    return { in: [], out: [] };
  },
  resolve: () => undefined,
});

/** The body of a block, which may branch to the block's label. */
type Body = (label: RandomLabel) => void;
/** Block types, by their parameters and results; a block without them takes and leaves nothing. */
type BlockOptions = Exclude<FunctionTypeInput, null>;
type BlockArgs = [body: Body] | [options: BlockOptions, body: Body];

/** Optional options come first, then the bodies. */
function withOptions<Options, Bodies extends unknown[]>(
  args: [Options, ...Bodies] | Bodies,
  bodies: number,
): [Options | Record<string, never>, ...Bodies] {
  return (args.length > bodies ? args : [{}, ...args]) as [Options, ...Bodies];
}

/**
 * A block type: empty or a single result where possible, otherwise the index of its function type,
 * which is then the block's dependency.
 */
function blockType(type: FunctionType): { deps: Dependency.t[]; abbreviated?: BlockType } {
  if (type.args.length === 0 && type.results.length <= 1)
    return { deps: [], abbreviated: type.results[0] ?? "empty" };
  return { deps: [Dependency.type(type)] };
}

/** A block type that refers to a type by index, or to a defined type in a reference type. */
const blockTypeImmediate: Immediate = {
  string: "blocktype",
  immediate: lazy(() => BlockType),
  resolve: (deps: number[], abbreviated: BlockType | undefined) => abbreviated ?? deps[0],
};

/** A block's header: its opcode and block type, and catch clauses for try_table. */
function writeHeader(ctx: LocalContext, instruction: BaseInstruction, type: FunctionType) {
  let { code } = ctx;
  checkAllowed(ctx, instruction.string);
  writeByteArray(code, instruction.opcodeBytes);
  let { deps, abbreviated } = blockType(type);
  if (abbreviated === undefined) {
    ctx.deps.add(deps[0]);
    addHole(code, blockTypeImmediate, deps, [undefined]);
  } else if (hasDefinedType(abbreviated)) addHole(code, blockTypeImmediate, [], [abbreviated]);
  else BlockType.writeBytes(code, abbreviated);
}

/** After a block's code: take its parameters from the stack, and push its results. */
function endBlock<Args, Results>(ctx: LocalContext, name: string, { args, results }: FunctionType) {
  writeByte(ctx.code, END);
  popStack(ctx, args, name);
  let pushed = pushStack(ctx, results);
  return (
    pushed.length === 0 ? undefined : pushed.length === 1 ? pushed[0] : pushed
  ) as Instruction_<Args, Results>;
}

function blockInstruction(name: "block" | "loop") {
  // The instruction's codec decodes and encodes blocks of modules that are not built here.
  let { instruction } = baseInstruction(
    name,
    lazy(() => Block),
    { create: notBuilt },
  );
  let block = function (ctx: LocalContext, ...args: BlockArgs) {
    let [options, run] = withOptions<BlockOptions, [Body]>(args, 1);
    let type = typeFromInput(options);
    writeHeader(ctx, instruction, type);
    runBlock(ctx, name, type, run);
    return endBlock(ctx, name, type);
  };
  return Object.assign(block, { instruction });
}

function notBuilt(): never {
  throw Error("bug: written by its own function, not through create()");
}

const block = blockInstruction("block");
const loop = blockInstruction("loop");

/** A branch hint: whether the branch is likely taken. */
type BranchHint = { likely?: boolean };
type IfOptions = BlockOptions & BranchHint;
type IfArgs = [then: Body, otherwise?: Body] | [options: IfOptions, then: Body, otherwise?: Body];

const ifInstruction = baseInstruction(
  "if",
  lazy(() => IfBlock),
  { create: notBuilt },
).instruction;
function if_(ctx: LocalContext, ...args: IfArgs) {
  let bodies = typeof args[0] === "function" ? args.length : args.length - 1;
  let [options, runIf, runElse] = withOptions<IfOptions, [Body, Body?]>(args, bodies);
  let { code } = ctx;
  popStack(ctx, ["i32"]);
  let type = typeFromInput(options);
  if (options.likely !== undefined)
    code.hints.push({ position: code.offset, likely: options.likely });
  writeHeader(ctx, ifInstruction, type);
  runBlock(ctx, "if", type, runIf);
  if (runElse !== undefined) {
    writeByte(code, ELSE);
    runBlock(ctx, "else", type, runElse);
  }
  // The condition was taken before the branches; the parameters are below it.
  pushStack(ctx, ["i32"]);
  return endBlock(ctx, "if", { args: [...type.args, "i32"], results: type.results });
}

const br = baseInstruction("br", LabelIndex, {
  create(ctx, label: Label | number) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    popStack(ctx, types);
    setUnreachable(ctx);
    return { in: [], out: [], resolveArgs: [i] };
  },
});

const brIf = baseInstruction("br_if", LabelIndex, {
  create(ctx, label: Label | number, { likely }: BranchHint = {}) {
    let [i, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    return { in: [...types, "i32"], out: types, resolveArgs: [i], likely };
  },
});
const i32Operand: ValueType[] = ["i32"];

/** Branches to labels without values are simple instructions. */
function br_if(ctx: LocalContext, label: Label | number, hint: BranchHint = {}) {
  let [i, frame] = getFrameFromLabel(ctx, label);
  if (labelTypes(frame).length > 0) return brIf(ctx, label, hint);
  if (hint.likely !== undefined)
    ctx.code.hints.push({ position: ctx.code.offset, likely: hint.likely });
  emitSimple(ctx, brIf.instruction, i32Operand, undefined, i);
}

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
      checkStack(ctx, types);
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
  create(_, table: Dependency.AnyTable, reference: FunctionTypeReference) {
    let { type, defined } = functionTypeOf(reference);
    return {
      in: [...type.args, addressType(table.type.limits)],
      out: type.results,
      deps: [defined, table],
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
    create(ctx, table: Dependency.AnyTable, reference: FunctionTypeReference) {
      let { type, defined } = functionTypeOf(reference);
      tailCall(ctx, type, [addressType(table.type.limits)]);
      return { in: [], out: [], deps: [defined, table] };
    },
    resolve: ([typeIdx, tableIdx]) => [typeIdx, tableIdx],
  },
);

/** Call a function reference of the given type. */
const call_ref = baseInstruction("call_ref", TypeIndex, {
  create(_, reference: FunctionTypeReference) {
    let { type, defined } = functionTypeOf(reference);
    return {
      in: [...type.args, refType(defined, true)],
      out: type.results,
      deps: [defined],
    };
  },
  resolve: ([typeIdx]) => typeIdx,
});

const return_call_ref = baseInstruction("return_call_ref", TypeIndex, {
  create(ctx, reference: FunctionTypeReference) {
    let { type, defined } = functionTypeOf(reference);
    tailCall(ctx, type, [refType(defined, true)]);
    return { in: [], out: [], deps: [defined] };
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
    checkStack(ctx, labelTypes(frame));
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
    checkStack(ctx, types.slice(0, -1));
    return { in: [], out: [], resolveArgs: [i] };
  },
});

/** Throw an exception with the tag's values from the stack. */
const throw_ = baseInstruction("throw", TagIndex, {
  create(ctx, tag: Dependency.AnyTag) {
    popStack(ctx, tag.type.args);
    setUnreachable(ctx);
    return { in: [], out: [], deps: [tag] };
  },
  resolve: ([tagIdx]) => tagIdx,
});

/** Rethrow a caught exception. */
const throw_ref = baseInstruction("throw_ref", Undefined, {
  create(ctx) {
    popStack(ctx, ["exnref"]);
    setUnreachable(ctx);
    return { in: [], out: [] };
  },
  resolve: () => undefined,
});

/**
 * A catch clause: exceptions with the tag, or any exception without one, branch to the label with the
 * tag's values and, if `ref` is set, a reference to the exception.
 */
type CatchInput = { tag?: Dependency.AnyTag; ref?: boolean; label: Label | number };
type TryTableOptions = BlockOptions & { catches?: CatchInput[] };

/** Catch clauses whose tags are referred to by index. */
const catchesImmediate: Immediate = {
  string: "catches",
  immediate: lazy(() => vec(Catch)),
  resolve(tags: number[], clauses: { kind: Catch["kind"]; label: number; tagged: boolean }[]) {
    let next = 0;
    return clauses.map(({ kind, label, tagged }) =>
      tagged ? { kind, tag: tags[next++], label } : { kind, label },
    );
  },
};

const tryTableInstruction = baseInstruction(
  "try_table",
  lazy(() => TryTable),
  {
    create: notBuilt,
  },
).instruction;

/** A block whose exceptions are caught by its catch clauses, which branch to enclosing labels. */
function try_table(
  ctx: LocalContext,
  ...args: [body: Body] | [options: TryTableOptions, body: Body]
) {
  let [options, run] = withOptions<TryTableOptions, [Body]>(args, 1);
  // Catch clauses branch from outside the block.
  let clauses = (options.catches ?? []).map(({ tag, ref = false, label }) => {
    let [depth, frame] = getFrameFromLabel(ctx, label);
    let values = [...(tag?.type.args ?? []), ...(ref ? [refType("exn", false)] : [])];
    let types = labelTypes(frame);
    if (values.length !== types.length || values.some((v, i) => !isSubtype(v, types[i])))
      throw Error(
        `try_table: catch clause provides [${values.map(printValueType)}], label expects [${types.map(printValueType)}]`,
      );
    let kind = `${tag === undefined ? "catch_all" : "catch"}${ref ? "_ref" : ""}` as Catch["kind"];
    return { kind, tag, label: depth };
  });
  let type = typeFromInput(options);
  let { code } = ctx;
  writeHeader(ctx, tryTableInstruction, type);
  let tags = clauses.flatMap(({ tag }) => (tag === undefined ? [] : [tag]));
  let resolved = clauses.map(({ kind, label, tag }) => ({
    kind,
    label,
    tagged: tag !== undefined,
  }));
  for (let tag of tags) ctx.deps.add(tag);
  addHole(code, catchesImmediate, tags, [resolved]);
  runBlock(ctx, "try_table", type, run);
  return endBlock(ctx, "try_table", type);
}

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
          namedInputs(func.params.names, args) as Input<ValueType>[],
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
  throw: throw_,
  throw_ref,
  try_table,
};

// parametric instructions

const dropInstruction = baseInstruction("drop", Undefined, { create: notBuilt }).instruction;
const noOperands: ValueType[] = [];

/** Drop the value on the stack, of any type. */
function drop(ctx: LocalContext) {
  popUnknown(ctx);
  emitSimple(ctx, dropInstruction, noOperands, undefined);
}

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

/** Instructions that the operations above write themselves, which lookups by name or opcode find. */
const instructions = [block, loop, ifInstruction, brIf, call, dropInstruction, tryTableInstruction];
