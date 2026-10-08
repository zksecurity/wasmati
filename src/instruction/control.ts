import { lazy, record, tuple, writeByte, writeByteArray, writeIndexed } from "../binable.ts";
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
  popOne,
  pushResult,
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
  type BaseInstruction,
  checkAllowed,
  define,
  emitInstruction,
  type FunctionTypeInput,
  type FunctionTypeReference,
  functionTypeOf,
  hasDefinedType,
  runBlock,
  typeFromInput,
  type Instruction_,
} from "./base.ts";
import { Block, BlockType, Catch, ELSE, END, IfBlock, TryTable } from "./binable.ts";
import { type Immediate, addHole } from "../code.ts";
import {
  fixed,
  type Input,
  namedInputs,
  pushResults,
  takeOperands,
  typedByImmediates,
  writeOpcode,
} from "./stack-args.ts";

export { control, bindControlOps, parametric, instructions };

// control instructions

const nop = fixed("nop", [], []);

const unreachableInstruction = define("unreachable");

function unreachable(ctx: LocalContext) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "unreachable");
  setUnreachable(ctx);
  writeOpcode(ctx.code, unreachableInstruction.opcodeBytes);
}

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
  let instruction = define(
    name,
    lazy(() => Block),
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

const block = blockInstruction("block");
const loop = blockInstruction("loop");

/** A branch hint: whether the branch is likely taken. */
type BranchHint = { likely?: boolean };
type IfOptions = BlockOptions & BranchHint;
type IfArgs = [then: Body, otherwise?: Body] | [options: IfOptions, then: Body, otherwise?: Body];

const ifInstruction = define(
  "if",
  lazy(() => IfBlock),
);
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

const brInstruction = define("br", LabelIndex);

/** Branch to a label, with the values it takes. */
function br(ctx: LocalContext, label: Label | number) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "br");
  let [i, frame] = getFrameFromLabel(ctx, label);
  popStack(ctx, labelTypes(frame));
  setUnreachable(ctx);
  writeIndexed(ctx.code, brInstruction.opcodeBytes[0], i);
}

const brIfInstruction = define("br_if", LabelIndex);

/** Branch to a label if the i32 on the stack is nonzero; the label's values stay otherwise. */
function br_if(ctx: LocalContext, label: Label | number, { likely }: BranchHint = {}) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "br_if");
  let [i, frame] = getFrameFromLabel(ctx, label);
  let types = labelTypes(frame);
  popOne(ctx, "i32", "br_if");
  if (types.length > 0) checkStack(ctx, types);
  let { code } = ctx;
  if (likely !== undefined) code.hints.push({ position: code.offset, likely });
  writeIndexed(code, brIfInstruction.opcodeBytes[0], i);
}

const LabelTable = record({ indices: vec(LabelIndex), defaultIndex: LabelIndex });
const brTableInstruction = define("br_table", LabelTable);

/** Branch to the label at the index on the stack, or to the default label beyond the labels. */
function br_table(ctx: LocalContext, labels: (Label | number)[], defaultLabel: Label | number) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "br_table");
  popStack(ctx, ["i32"]);
  let [defaultIndex, defaultFrame] = getFrameFromLabel(ctx, defaultLabel);
  let types = labelTypes(defaultFrame);
  let arity = types.length;
  let indices: number[] = [];
  for (let label of labels) {
    let [j, frame] = getFrameFromLabel(ctx, label);
    indices.push(j);
    let types = labelTypes(frame);
    if (types.length !== arity) throw Error("inconsistent length of block label types in br_table");
    checkStack(ctx, types);
  }
  popStack(ctx, types);
  setUnreachable(ctx);
  writeOpcode(ctx.code, brTableInstruction.opcodeBytes);
  LabelTable.writeBytes(ctx.code, { indices, defaultIndex });
}

const returnInstruction = define("return");

/** Return from the function, with its results. */
function return_(ctx: LocalContext) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "return");
  let type = ctx.return;
  if (type === null) throw Error("bug: called return outside a function");
  popStack(ctx, type);
  setUnreachable(ctx);
  writeOpcode(ctx.code, returnInstruction.opcodeBytes);
}

const callInstruction = define("call", FunctionIndex, ([index]: number[]) => index);

/** Call a function with its parameters, given by name, or from the stack. */
function call<F extends AnyFunc<any, any>>(
  ctx: LocalContext,
  func: F,
  args?: { [K in keyof F["params"]["values"]]: Input<F["params"]["values"][K]> },
): Instruction_<F["type"]["args"], F["type"]["results"]> {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "call");
  let operands = args === undefined ? noOperands : namedInputs(func.params.names, args);
  takeOperands(ctx, "call", func.type.args, operands);
  emitInstruction(ctx, callInstruction, [func], []);
  return pushResults(ctx, func.type.results) as Instruction_<
    F["type"]["args"],
    F["type"]["results"]
  >;
}
const noOperands: unknown[] = [];

const call_indirect = typedByImmediates(
  define("call_indirect", tuple([TypeIndex, TableIndex]), ([typeIdx, tableIdx]: number[]) => [
    typeIdx,
    tableIdx,
  ]),
  2,
  (table: Dependency.AnyTable, reference: FunctionTypeReference) => {
    let { type, defined } = functionTypeOf(reference);
    return {
      in: [...type.args, addressType(table.type.limits)],
      out: type.results,
      deps: [defined, table],
      args: [],
    };
  },
);

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

const returnCallInstruction = define("return_call", FunctionIndex, ([index]: number[]) => index);

function return_call(ctx: LocalContext, func: Dependency.AnyFunc) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "return_call");
  tailCall(ctx, func.type, []);
  emitInstruction(ctx, returnCallInstruction, [func], []);
}

const returnCallIndirectInstruction = define(
  "return_call_indirect",
  tuple([TypeIndex, TableIndex]),
  ([typeIdx, tableIdx]: number[]) => [typeIdx, tableIdx],
);

function return_call_indirect(
  ctx: LocalContext,
  table: Dependency.AnyTable,
  reference: FunctionTypeReference,
) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "return_call_indirect");
  let { type, defined } = functionTypeOf(reference);
  tailCall(ctx, type, [addressType(table.type.limits)]);
  emitInstruction(ctx, returnCallIndirectInstruction, [defined, table], []);
}

/** Call a function reference of the given type. */
const call_ref = typedByImmediates(
  define("call_ref", TypeIndex, ([typeIdx]: number[]) => typeIdx),
  1,
  (reference: FunctionTypeReference) => {
    let { type, defined } = functionTypeOf(reference);
    return {
      in: [...type.args, refType(defined, true)],
      out: type.results,
      deps: [defined],
      args: [],
    };
  },
);

const returnCallRefInstruction = define(
  "return_call_ref",
  TypeIndex,
  ([typeIdx]: number[]) => typeIdx,
);

function return_call_ref(ctx: LocalContext, reference: FunctionTypeReference) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "return_call_ref");
  let { type, defined } = functionTypeOf(reference);
  tailCall(ctx, type, [refType(defined, true)]);
  emitInstruction(ctx, returnCallRefInstruction, [defined], []);
}

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

const brOnNullInstruction = define("br_on_null", LabelIndex);

/** Branch if the reference is null; otherwise continue with it as non-null. */
function br_on_null(ctx: LocalContext, label: Label | number) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "br_on_null");
  let [i, frame] = getFrameFromLabel(ctx, label);
  let reference = popReference(ctx);
  checkStack(ctx, labelTypes(frame));
  pushStack(ctx, [nonNull(reference)]);
  writeIndexed(ctx.code, brOnNullInstruction.opcodeBytes[0], i);
}

const brOnNonNullInstruction = define("br_on_non_null", LabelIndex);

/** Branch with the reference if it is not null; otherwise continue without it. */
function br_on_non_null(ctx: LocalContext, label: Label | number) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "br_on_non_null");
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
  writeIndexed(ctx.code, brOnNonNullInstruction.opcodeBytes[0], i);
}

const throwInstruction = define("throw", TagIndex, ([tagIdx]: number[]) => tagIdx);

/** Throw an exception with the tag's values from the stack. */
function throw_(ctx: LocalContext, tag: Dependency.AnyTag) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "throw");
  popStack(ctx, tag.type.args);
  setUnreachable(ctx);
  emitInstruction(ctx, throwInstruction, [tag], []);
}

const throwRefInstruction = define("throw_ref");

/** Rethrow a caught exception. */
function throw_ref(ctx: LocalContext) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "throw_ref");
  popStack(ctx, ["exnref"]);
  setUnreachable(ctx);
  writeOpcode(ctx.code, throwRefInstruction.opcodeBytes);
}

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

const tryTableInstruction = define(
  "try_table",
  lazy(() => TryTable),
);

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
    ) => call(ctx, func, args),
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

const dropInstruction = define("drop");

/** Drop the value on the stack, of any type. */
function drop(ctx: LocalContext) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "drop");
  popUnknown(ctx);
  writeOpcode(ctx.code, dropInstruction.opcodeBytes);
}

const selectInstruction = define("select");

/** One of two numbers or vectors of the same type: the first if the i32 on the stack is nonzero. */
function select_poly(ctx: LocalContext) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "select");
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
  writeOpcode(ctx.code, selectInstruction.opcodeBytes);
  // In unreachable code both operands may be unknown, and so is the result.
  return pushResult(ctx, (t1 !== Unknown ? t1 : t2) as ValueType);
}

const selectTInstruction = define("select_t", vec(ValueType));

/** Like polymorphic `select`, for values of the given type, which may be references. */
function select_t(ctx: LocalContext, t: ValueTypeObject) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "select_t");
  let type = valueTypeLiteral(t);
  popOne(ctx, "i32", "select");
  popOne(ctx, type, "select");
  popOne(ctx, type, "select");
  // Defined types in the immediate are a hole, which Module() fills in with their indices.
  emitInstruction(ctx, selectTInstruction, [], [[type]]);
  return pushResult(ctx, type);
}

const parametric = { drop, select_t, select_poly };

/** Instructions that the operations above write themselves, which lookups by name or opcode find. */
const instructions = [
  unreachableInstruction,
  block,
  loop,
  ifInstruction,
  brInstruction,
  brIfInstruction,
  brTableInstruction,
  returnInstruction,
  callInstruction,
  returnCallInstruction,
  returnCallIndirectInstruction,
  returnCallRefInstruction,
  brOnNullInstruction,
  brOnNonNullInstruction,
  throwInstruction,
  throwRefInstruction,
  tryTableInstruction,
  dropInstruction,
  selectInstruction,
  selectTInstruction,
];
