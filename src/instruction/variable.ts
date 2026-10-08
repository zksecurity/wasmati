import { Undefined } from "../binable.ts";
import * as Dependency from "../dependency.ts";
import { baseInstruction, type FunctionTypeInput, functionTypeOf } from "./base.ts";
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
import { checkLatest, type Input, processStackArgs, writeOperand } from "./stack-args.ts";

export {
  localOps,
  bindLocalOps,
  globalOps,
  bindGlobalOps,
  globalConstructor,
  refTypeConstructor,
  refOps,
};

const localOps = {
  get: localGet,
  set: baseInstruction("local.set", LocalIndex, {
    create(ctx, x: Local) {
      let local = ctx.locals[x.index];
      if (local === undefined) throw missingLocal(ctx, x.index);
      return { in: [local], out: [] };
    },
    resolve: (_, x: Local) => x.index,
  }),
  tee: baseInstruction("local.tee", LocalIndex, {
    create(ctx, x: Local) {
      let type = ctx.locals[x.index];
      if (type === undefined) throw missingLocal(ctx, x.index);
      return { in: [type], out: [type] };
    },
    resolve: (_, x: Local) => x.index,
  }),
};

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
  if (value !== undefined && !(value instanceof StackValue)) writeOperand(ctx, name, x.type, value);
  else {
    if (value !== undefined) checkLatest(ctx, name, value, 1);
    popOne(ctx, type, name);
  }
  ctx.code.indexed(opcode, x.index);
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
      return localOps.get(ctx, x) as StackVar<T>;
    },
    set: function <L extends Local>(x: L, value?: Input<L["type"]>) {
      writeLocal(ctx, "local.set", 0x21, x, value);
    },
    tee: function <L extends Local>(x: L, value?: Input<L["type"]>) {
      return pushResult(ctx, writeLocal(ctx, "local.tee", 0x22, x, value)) as StackVar<L["type"]>;
    },
  };
}

const globalOps = {
  get: globalGet,
  set: baseInstruction("global.set", GlobalIndex, {
    create(_, global: Dependency.AnyGlobal) {
      if (!global.type.mutable) {
        throw Error("global.set used on immutable global");
      }
      return {
        in: [global.type.value],
        out: [],
        deps: [global],
      };
    },
    resolve: ([globalIdx]) => globalIdx,
  }),
};

function bindGlobalOps(ctx: LocalContext) {
  return {
    get: function <T extends ValueType>(x: Dependency.AnyGlobal<T>) {
      return globalOps.get(ctx, x) as StackVar<T>;
    },
    set: function <G extends Dependency.AnyGlobal>(x: G, value?: Input<G["type"]["value"]>) {
      processStackArgs(ctx, "global.set", [x.type.value], value === undefined ? [] : [value]);
      return globalOps.set(ctx, x);
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

const refOps = {
  /** The null reference of a reference type's heap type. */
  null: baseInstruction("ref.null", HeapType, {
    create(_, type: Type<RefType>) {
      let heap = referenced(valueTypeLiteral(type)).ref;
      return { in: [], out: [refType(heap, true)], resolveArgs: [heap] };
    },
  }),
  is_null: baseInstruction("ref.is_null", Undefined, {
    create({ stack }: LocalContext) {
      return { in: [topReference(stack, "ref.is_null") as RefType], out: ["i32"] };
    },
    resolve: () => undefined,
  }),
  as_non_null: baseInstruction("ref.as_non_null", Undefined, {
    create({ stack }: LocalContext) {
      let type = topReference(stack, "ref.as_non_null");
      let result = type === Unknown ? type : refType(referenced(type).ref, false);
      return { in: [type as RefType], out: [result as RefType] };
    },
    resolve: () => undefined,
  }),
  /** A non-null reference to a function, typed by the function's type. */
  func: baseInstruction("ref.func", FunctionIndex, {
    create(_, func: Dependency.AnyFunc) {
      return {
        in: [],
        out: [refType(Dependency.typeOf(func), false)],
        deps: [func, Dependency.hasRefTo(func)],
      };
    },
    resolve: ([funcIdx]) => funcIdx,
  }),
};
