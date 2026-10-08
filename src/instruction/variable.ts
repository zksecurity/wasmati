import { writeIndexed } from "../binable.ts";
import * as Dependency from "../dependency.ts";
import {
  checkAllowed,
  define,
  emitInstruction,
  type FunctionTypeInput,
  functionTypeOf,
} from "./base.ts";
import {
  type AbstractHeapType,
  type DefinedType,
  FunctionIndex,
  GlobalIndex,
  HeapType,
  isRefType,
  isSubtype,
  LocalIndex,
  type Local,
  printValueType,
  referenced,
  refType,
  type RefType,
  type Type,
  ValueType,
  valueTypeLiteral,
} from "../types.ts";
import {
  type LocalContext,
  popOne,
  StackValue,
  StackVar,
  type StackType,
  Unknown,
  missingLocal,
  pushResult,
} from "../local-context.ts";
import { globalGet, localGet } from "./variable-get.ts";
import { checkLatest, type Input, takeOne, writeOperand, writeOpcode } from "./stack-args.ts";

export { bindLocalOps, bindGlobalOps, globalConstructor, refTypeConstructor, refOps, instructions };

const localSetInstruction = define("local.set", LocalIndex);
const localTeeInstruction = define("local.tee", LocalIndex);

/**
 * Write local.set or local.tee, with its operand, or the value on the stack, and return the local's
 * type. Constant expressions have no locals.
 */
function writeLocal(
  ctx: LocalContext,
  name: "local.set" | "local.tee",
  opcode: number,
  x: Local,
  value: Input<any> | undefined,
) {
  let type = localType(ctx, x);
  if (value !== undefined && !(value instanceof StackValue)) writeOperand(ctx, name, type, value);
  else {
    if (value !== undefined) checkLatest(ctx, name, value, 1);
    popOne(ctx, type, name);
  }
  writeIndexed(ctx.code, opcode, x.index);
  return type;
}

function localType(ctx: LocalContext, x: Local) {
  let type = ctx.locals[x.index];
  if (type === undefined) throw missingLocal(ctx, x.index);
  return type;
}

function bindLocalOps(ctx: LocalContext) {
  return {
    get: function <T extends ValueType>(x: Local<T>) {
      return localGet(ctx, x) as StackVar<T>;
    },
    set: function <L extends Local>(x: L, value?: Input<L["type"]>) {
      writeLocal(ctx, "local.set", 0x21, x, value);
    },
    tee: function <L extends Local>(x: L, value?: Input<L["type"]>) {
      return pushResult(ctx, writeLocal(ctx, "local.tee", 0x22, x, value)) as StackVar<L["type"]>;
    },
  };
}

const globalSetInstruction = define("global.set", GlobalIndex, ([index]: number[]) => index);

/** Set a mutable global to its operand, or to the value on the stack. */
function globalSet(ctx: LocalContext, global: Dependency.AnyGlobal, value?: Input<ValueType>) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "global.set");
  if (!global.type.mutable) throw Error("global.set used on immutable global");
  takeOne(ctx, "global.set", global.type.value, value);
  emitInstruction(ctx, globalSetInstruction, [global], []);
}

function bindGlobalOps(ctx: LocalContext) {
  return {
    get: function <T extends ValueType>(x: Dependency.AnyGlobal<T>) {
      return globalGet(ctx, x) as StackVar<T>;
    },
    set: function <G extends Dependency.AnyGlobal>(x: G, value?: Input<G["type"]["value"]>) {
      globalSet(ctx, x, value);
    },
  };
}

/** A global with the type of its initializer, or a declared supertype of it. */
function globalConstructor<T extends ValueType>(
  init: Dependency.Constant<T>,
  { mutable = false, type }: { mutable?: boolean; type?: Type<T> } = {},
): Dependency.Global<T> {
  let deps = init.deps as Dependency.Global<T>["deps"];
  let value = type === undefined ? init.type : valueTypeLiteral(type);
  if (!isSubtype(init.type, value))
    throw Error(
      `global: initializer of type ${printValueType(init.type)} does not fit type ${printValueType(value)}`,
    );
  return { kind: "global", type: { value, mutable }, init, deps };
}

/**
 * The type of references to an abstract heap type, a defined type, or a function signature; non-null
 * unless `nullable` is set.
 */
function refTypeConstructor(
  heap: AbstractHeapType | DefinedType | FunctionTypeInput,
  { nullable = false } = {},
): Type<RefType> {
  if (typeof heap === "string") return { kind: refType(heap, nullable) };
  return { kind: refType(functionTypeOrDefined(heap), nullable) };
}

function functionTypeOrDefined(heap: DefinedType | FunctionTypeInput): DefinedType {
  return heap !== null && "kind" in heap ? heap : functionTypeOf(heap).defined;
}

/** The reference on top of the stack, or unknown in unreachable code. */
function topReference(stack: StackVar<StackType>[], name: string): RefType | Unknown {
  let type = stack.at(-1)?.type ?? Unknown;
  if (type !== Unknown && !isRefType(type))
    throw Error(`${name}: expected a reference on the stack, got ${printValueType(type)}`);
  return type;
}

const refNullInstruction = define("ref.null", HeapType);

/** The null reference of a reference type's heap type. */
function refNull(ctx: LocalContext, type: Type<RefType>) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "ref.null");
  let heap = referenced(valueTypeLiteral(type)).ref;
  // A defined heap type is a hole, which Module() fills in with its index.
  emitInstruction(ctx, refNullInstruction, [], [heap]);
  return pushResult(ctx, refType(heap, true));
}

const refIsNullInstruction = define("ref.is_null");

/** Whether the reference on the stack is null. */
function refIsNull(ctx: LocalContext) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "ref.is_null");
  popOne(ctx, topReference(ctx.stack, "ref.is_null"), "ref.is_null");
  writeOpcode(ctx.code, refIsNullInstruction.opcodeBytes);
  return pushResult(ctx, "i32");
}

const refAsNonNullInstruction = define("ref.as_non_null");

/** The reference on the stack, which traps if it is null, as non-null. */
function refAsNonNull(ctx: LocalContext) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "ref.as_non_null");
  let type = topReference(ctx.stack, "ref.as_non_null");
  popOne(ctx, type, "ref.as_non_null");
  writeOpcode(ctx.code, refAsNonNullInstruction.opcodeBytes);
  return pushResult(ctx, type === Unknown ? type : refType(referenced(type).ref, false));
}

const refFuncInstruction = define("ref.func", FunctionIndex, ([index]: number[]) => index);

/** A non-null reference to a function, typed by the function's type. */
function refFunc(ctx: LocalContext, func: Dependency.AnyFunc) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "ref.func");
  emitInstruction(ctx, refFuncInstruction, [func, Dependency.hasRefTo(func)], []);
  return pushResult(ctx, refType(Dependency.typeOf(func), false));
}

const refOps = { null: refNull, is_null: refIsNull, as_non_null: refAsNonNull, func: refFunc };

/** The instructions of the functions above, which lookups by name or opcode find. */
const instructions = [
  localSetInstruction,
  localTeeInstruction,
  globalSetInstruction,
  refNullInstruction,
  refIsNullInstruction,
  refAsNonNullInstruction,
  refFuncInstruction,
];
