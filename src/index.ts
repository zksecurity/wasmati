export { type Parameters } from "./parameters.ts";
export { localArray, type LocalArray } from "./locals.ts";
export { Module } from "./module.ts";
export { NameSection, type NameMap, type IndirectNameMap } from "./name-section.ts";
export type { CustomSection } from "./module-binable.ts";
export type { JSONValue } from "./json.ts";
import {
  globalConstructor,
  refOps,
  refTypeConstructor,
  bindLocalOps,
  bindGlobalOps,
} from "./instruction/variable.ts";
import { f32Ops, f64Ops, i32Ops, i64Ops } from "./instruction/numeric.ts";
import { memoryOps, dataOps, tableOps, elemOps } from "./instruction/memory.ts";
import { bindControlOps, control as controlOps, parametric } from "./instruction/control.ts";
import {
  anyOps,
  arrayOps,
  br_on_cast as brOnCast,
  br_on_cast_fail as brOnCastFail,
  externOps,
  gcRefOps,
  i31Ops,
  structOps,
} from "./instruction/gc.ts";
import { array as arrayType, struct as structType } from "./type-definitions.ts";
import { emptyContext, type LocalContext, type Label, StackVar, Unknown } from "./local-context.ts";
import type { Tuple } from "./util.ts";
import {
  valueType,
  funcref,
  externref,
  exnref,
  anyref,
  eqref,
  i31ref,
  structref,
  arrayref,
  nullref,
  nullfuncref,
  nullexternref,
  nullexnref,
  ValueType,
  type ValueTypeObject,
  RefType,
  type RefTypeObject,
  type Type,
  type JSValue,
} from "./types.ts";
import type { Func, ImportFunc, AnyFunc } from "./func-types.ts";
import {
  type JSFunction,
  type Local,
  func as originalFunc,
  declareFunc as originalDeclareFunc,
  type ToTypeTuple,
} from "./func.ts";
import type { Instruction, FunctionTypeInput, WithPublicSignature } from "./instruction/base.ts";
import {
  f32x4Ops,
  f64x2Ops,
  i16x8Ops,
  i32x4Ops,
  i64x2Ops,
  i8x16Ops,
  v128Ops,
} from "./instruction/vector.ts";
import {
  dataConstructor,
  elemConstructor,
  memoryConstructor,
  tableConstructor,
  tagConstructor,
} from "./memory.ts";
import * as Dependency from "./dependency.ts";
import type { Global, ImportGlobal, AnyGlobal, ImportMemory, AnyMemory } from "./dependency.ts";
import {
  asyncExport,
  importFunc,
  importGlobal,
  importMemory,
  importTable,
  importTag,
} from "./export.ts";
import { constant as constantExpression } from "./constant.ts";
import type { TupleN } from "./util.ts";
import type { ExportInput, ModuleExport, ModuleInstance, TypedInstance } from "./module.ts";
import type { AsyncExport } from "./export.ts";
import type { Input } from "./instruction/stack-args.ts";
import {
  atomicOps,
  i32AtomicOps,
  i32AtomicRmw16Ops,
  i32AtomicRmw8Ops,
  i32AtomicRmwOps,
  i64AtomicOps,
  i64AtomicRmw16Ops,
  i64AtomicRmw32Ops,
  i64AtomicRmw8Ops,
  i64AtomicRmwOps,
  memoryAtomicOps,
} from "./instruction/atomic.ts";

// instruction API
export {
  i32,
  i64,
  f32,
  f64,
  local,
  global,
  ref,
  control,
  drop,
  select,
  memory,
  data,
  table,
  elem,
  v128,
  i8x16,
  i16x8,
  i32x4,
  i64x2,
  f32x4,
  f64x2,
  atomic,
  struct,
  array,
  i31,
  any,
  extern,
};
export {
  nop,
  unreachable,
  block,
  loop,
  if_,
  br,
  br_if,
  br_table,
  br_on_null,
  br_on_non_null,
  throw_,
  throw_ref,
  try_table,
  br_on_cast,
  br_on_cast_fail,
  return_,
  call,
  call_indirect,
  call_ref,
  return_call,
  return_call_indirect,
  return_call_ref,
};

// other public API
export { isolatedWasmati, type Wasmati };
export { declareFunc, func, type Func, importFunc, type ImportFunc, type AnyFunc, constant };
export { asyncExport as async };
export { importTable, importTag, tagConstructor as tag };
export { funcType, rec, mut, i8, i16 } from "./type-definitions.ts";
export { importMemory, type ImportMemory, type AnyMemory };
export { type Global, importGlobal, type ImportGlobal, type AnyGlobal };
export {
  funcref,
  externref,
  exnref,
  anyref,
  eqref,
  i31ref,
  structref,
  arrayref,
  nullref,
  nullfuncref,
  nullexternref,
  nullexnref,
  refTypeConstructor as refType,
  type Local,
  $,
  StackVar,
  type Input,
  type Type,
  ValueType,
  type ValueTypeObject,
  RefType,
  type RefTypeObject,
};
export { Dependency };
export type {
  Memory,
  Table,
  ImportTable,
  AnyTable,
  Tag,
  ImportTag,
  AnyTag,
  Data,
  Elem,
  AnyImport,
  t as AnyDependency,
} from "./dependency.ts";
export type { I32, I64, F32, F64, V128 };
export type { AddressType, DefinedType } from "./types.ts";
export type { U64 } from "./immediate.ts";
export type { Code } from "./code.ts";
export type { NamedLocals } from "./locals.ts";
export type { LocalContext } from "./local-context.ts";
export type { StructType, ArrayType, FieldInput, FieldValue } from "./type-definitions.ts";
export type { Module as BinaryModule } from "./module-binable.ts";
export type {
  ToTypeTuple,
  FunctionTypeInput,
  Label,
  TupleN,
  Instruction,
  ModuleExport,
  ModuleInstance,
  TypedInstance,
  ExportInput,
  AsyncExport,
  JSFunction,
  JSValue,
};

type i32 = "i32";
type i64 = "i64";
type f32 = "f32";
type f64 = "f64";
type v128 = "v128";

// The default instance of the builder API, which the package exports.
const wasmati = createWasmati(emptyContext());

// Value types that are also instruction namespaces have names, which inferred types use.
type Namespaces = ReturnType<typeof createNamespaces>;
type I32Namespace = Namespaces["i32"];
type I64Namespace = Namespaces["i64"];
type F32Namespace = Namespaces["f32"];
type F64Namespace = Namespaces["f64"];
type V128Namespace = Namespaces["v128"];
interface I32 extends I32Namespace {}
interface I64 extends I64Namespace {}
interface F32 extends F32Namespace {}
interface F64 extends F64Namespace {}
interface V128 extends V128Namespace {}

const {
  i32,
  i64,
  f32,
  f64,
  v128,
  func,
  declareFunc,
  constant,
  local,
  global,
  ref,
  control,
  drop,
  select,
  memory,
  data,
  table,
  elem,
  i8x16,
  i16x8,
  i32x4,
  i64x2,
  f32x4,
  f64x2,
  atomic,
  struct,
  array,
  i31,
  any,
  extern,
  nop,
  unreachable,
  block,
  loop,
  if_,
  br,
  br_if,
  br_table,
  return_,
  call,
  call_indirect,
  call_ref,
  return_call,
  return_call_indirect,
  return_call_ref,
  br_on_null,
  br_on_non_null,
  throw_,
  throw_ref,
  try_table,
  br_on_cast,
  br_on_cast_fail,
} = wasmati;

/**
 * An independent instance of the builder API: functions, constants and instructions with build state
 * of their own. Builds that use separate instances can't interfere, so that builds may run
 * concurrently, and helper libraries write into the instance they are handed. The package's exports
 * are the default instance, which is a `Wasmati` too. Declarations, types and `Module()` are shared.
 */
function isolatedWasmati(): Wasmati {
  return createWasmati(emptyContext());
}

type WasmatiMembers = ReturnType<typeof createWasmati>;
/** The builder API: functions, constants and instructions, bound to the state of one instance. */
interface Wasmati extends WasmatiMembers {}

function createWasmati(ctx: LocalContext) {
  const namespaces = createNamespaces(ctx);
  const { control } = namespaces;
  return {
    ...namespaces,
    i32: namespaces.i32 as I32,
    i64: namespaces.i64 as I64,
    f32: namespaces.f32 as F32,
    f64: namespaces.f64 as F64,
    v128: namespaces.v128 as V128,
    declareFunc: removeContext(ctx, originalDeclareFunc),
    constant: removeContext(ctx, constantExpression),
    nop: control.nop,
    unreachable: control.unreachable,
    block: control.block,
    loop: control.loop,
    if_: control.if,
    br: control.br,
    br_if: control.br_if,
    br_table: control.br_table,
    return_: control.return,
    call: control.call,
    call_indirect: control.call_indirect,
    call_ref: control.call_ref,
    return_call: control.return_call,
    return_call_indirect: control.return_call_indirect,
    return_call_ref: control.return_call_ref,
    br_on_null: control.br_on_null,
    br_on_non_null: control.br_on_non_null,
    throw_: control.throw,
    throw_ref: control.throw_ref,
    try_table: control.try_table,
    br_on_cast: control.br_on_cast,
    br_on_cast_fail: control.br_on_cast_fail,
  };
}

const $: StackVar<any> = StackVar(Unknown);

/** Instruction namespaces bound to a context. Namespaces that are also types or declarations are new objects. */
function createNamespaces(ctx: LocalContext) {
  const func = removeContext(ctx, originalFunc);

  const atomic = removeContexts(ctx, atomicOps);
  const memoryAtomic = removeContexts(ctx, memoryAtomicOps);

  const i32AtomicBase = removeContexts(ctx, i32AtomicOps);
  const i32AtomicRmw = removeContexts(ctx, i32AtomicRmwOps);
  const i32AtomicRmw8 = removeContexts(ctx, i32AtomicRmw8Ops);
  const i32AtomicRmw16 = removeContexts(ctx, i32AtomicRmw16Ops);
  const i32Atomic = Object.assign(i32AtomicBase, {
    rmw: i32AtomicRmw,
    rmw8: i32AtomicRmw8,
    rmw16: i32AtomicRmw16,
  });

  const i64AtomicBase = removeContexts(ctx, i64AtomicOps);
  const i64AtomicRmw = removeContexts(ctx, i64AtomicRmwOps);
  const i64AtomicRmw8 = removeContexts(ctx, i64AtomicRmw8Ops);
  const i64AtomicRmw16 = removeContexts(ctx, i64AtomicRmw16Ops);
  const i64AtomicRmw32 = removeContexts(ctx, i64AtomicRmw32Ops);
  const i64Atomic = Object.assign(i64AtomicBase, {
    rmw: i64AtomicRmw,
    rmw8: i64AtomicRmw8,
    rmw16: i64AtomicRmw16,
    rmw32: i64AtomicRmw32,
  });

  const i32 = Object.assign(valueType("i32"), removeContexts(ctx, i32Ops), {
    atomic: i32Atomic,
  });
  const i64 = Object.assign(valueType("i64"), removeContexts(ctx, i64Ops), {
    atomic: i64Atomic,
  });
  const f32 = Object.assign(valueType("f32"), removeContexts(ctx, f32Ops));
  const f64 = Object.assign(valueType("f64"), removeContexts(ctx, f64Ops));

  const local = bindLocalOps(ctx);
  const global = Object.assign(globalConstructor.bind(undefined), bindGlobalOps(ctx));
  const ref = removeContexts(ctx, { ...refOps, ...gcRefOps });

  const struct = Object.assign(structType.bind(undefined), removeContexts(ctx, structOps));
  const array = Object.assign(arrayType.bind(undefined), removeContexts(ctx, arrayOps));
  const i31 = removeContexts(ctx, i31Ops);
  const any = removeContexts(ctx, anyOps);
  const extern = removeContexts(ctx, externOps);

  const control1 = removeContexts(ctx, {
    ...controlOps,
    br_on_cast: brOnCast,
    br_on_cast_fail: brOnCastFail,
  });
  const control2 = bindControlOps(ctx);
  const control = Object.assign(control1, control2);

  const { drop, select_poly, select_t } = removeContexts(ctx, parametric);

  const memory = Object.assign(memoryConstructor.bind(undefined), removeContexts(ctx, memoryOps), {
    atomic: memoryAtomic,
  });
  const data = Object.assign(dataConstructor.bind(undefined), removeContexts(ctx, dataOps));
  const table = Object.assign(tableConstructor.bind(undefined), removeContexts(ctx, tableOps));
  const elem = Object.assign(elemConstructor.bind(undefined), removeContexts(ctx, elemOps));

  const v128_ = removeContexts(ctx, v128Ops);
  const v128 = Object.assign(valueType("v128"), {
    ...v128_,
  });

  const i8x16 = removeContexts(ctx, i8x16Ops);
  const i16x8 = removeContexts(ctx, i16x8Ops);
  const i32x4 = removeContexts(ctx, i32x4Ops);
  const i64x2 = removeContexts(ctx, i64x2Ops);
  const f32x4 = removeContexts(ctx, f32x4Ops);
  const f64x2 = removeContexts(ctx, f64x2Ops);

  // wrappers for instructions that take optional arguments
  function select(t?: ValueTypeObject) {
    return t === undefined ? select_poly() : select_t(t);
  }

  return {
    func,
    i32,
    i64,
    f32,
    f64,
    local,
    global,
    ref,
    control,
    drop,
    select,
    memory,
    data,
    table,
    elem,
    v128,
    i8x16,
    i16x8,
    i32x4,
    i64x2,
    f32x4,
    f64x2,
    atomic,
    struct,
    array,
    i31,
    any,
    extern,
  };
}

function removeContexts<
  T extends {
    [K in any]: (ctx: LocalContext, ...args: any) => any;
  },
>(
  ctx: LocalContext,
  instructions: T,
): {
  [K in keyof T]: RemoveContext<T[K]>;
} {
  let result: {
    [K in keyof T]: RemoveContext<T[K]>;
  } = {} as any;
  // Bound functions pass their arguments on without collecting them.
  for (let k in instructions) result[k] = instructions[k].bind(undefined, ctx) as any;
  return result;
}

/** An instruction without its context argument: its public signature, if it declares one. */
type RemoveContext<F extends (ctx: LocalContext, ...args: any) => any> =
  F extends WithPublicSignature<infer Signature>
    ? unknown extends Signature
      ? WithoutContext<F>
      : Signature
    : WithoutContext<F>;

type WithoutContext<F extends (ctx: LocalContext, ...args: any) => any> = F extends (
  ctx: LocalContext,
  ...args: infer CreateArgs
) => infer Return
  ? (...args: CreateArgs) => Return
  : never;

function removeContext<Args extends Tuple<any>, Return extends any>(
  ctx: LocalContext,
  op: (ctx: LocalContext, ...args: Args) => Return,
): (...args: Args) => Return {
  return op.bind(undefined, ctx) as (...args: Args) => Return;
}

export { decompile } from "./decompile.ts";

export { jsString, stringConstant } from "./js-string.ts";
