export { Module } from "./module.js";
import {
  globalConstructor,
  refOps,
  bindLocalOps,
  bindGlobalOps,
} from "./instruction/variable.js";
import { f32Ops, f64Ops, i32Ops, i64Ops } from "./instruction/numeric.js";
import { memoryOps, dataOps, tableOps, elemOps } from "./instruction/memory.js";
import {
  bindControlOps,
  control as controlOps,
  parametric,
} from "./instruction/control.js";
import {
  emptyContext,
  LocalContext,
  Label,
  StackVar,
  Unknown,
} from "./local-context.js";
import { Tuple } from "./util.js";
import {
  f32t,
  f64t,
  i32t,
  i64t,
  v128t,
  funcref,
  externref,
  ValueType,
  ValueTypeObject,
  RefType,
  RefTypeObject,
  Type,
  JSValue,
} from "./types.js";
import { Func, ImportFunc, AnyFunc } from "./func-types.js";
import {
  JSFunction,
  Local,
  func as originalFunc,
  ToTypeTuple,
} from "./func.js";
import { Instruction, FunctionTypeInput } from "./instruction/base.js";
import {
  f32x4Ops,
  f64x2Ops,
  i16x8Ops,
  i32x4Ops,
  i64x2Ops,
  i8x16Ops,
  v128Ops,
  wrapConst,
} from "./instruction/vector.js";
import {
  dataConstructor,
  elemConstructor,
  memoryConstructor,
  tableConstructor,
} from "./memory.js";
import * as Dependency from "./dependency.js";
import { Global, ImportGlobal, AnyGlobal } from "./dependency.js";
import { Const } from "./dependency.js";
import { importFunc, importGlobal } from "./export.js";
import { TupleN } from "./util.js";
import { ModuleExport } from "./module.js";
import { Input } from "./instruction/stack-args.js";

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
  return_,
  call,
  call_indirect,
};

// other public API
export { defaultCtx };
export { func, Func, importFunc, ImportFunc, AnyFunc };
export { Global, importGlobal, ImportGlobal, AnyGlobal };
export {
  funcref,
  externref,
  Local,
  $,
  StackVar,
  Input,
  Type,
  ValueType,
  ValueTypeObject,
  RefType,
  RefTypeObject,
};
export { Const, Dependency };
export type {
  ToTypeTuple,
  FunctionTypeInput,
  Label,
  TupleN,
  Instruction,
  ModuleExport,
  JSFunction,
  JSValue,
};

type i32 = "i32";
type i64 = "i64";
type f32 = "f32";
type f64 = "f64";
type v128 = "v128";

const defaultCtx = emptyContext();

const {
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
} = createInstructions(defaultCtx);

let {
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
} = control;

const $: StackVar<any> = StackVar(Unknown);

function createInstructions(ctx: LocalContext) {
  const func = removeContext(ctx, originalFunc);
  const i32 = Object.assign(i32t, removeContexts(ctx, i32Ops));
  const i64 = Object.assign(i64t, removeContexts(ctx, i64Ops));
  const f32 = Object.assign(f32t, removeContexts(ctx, f32Ops));
  const f64 = Object.assign(f64t, removeContexts(ctx, f64Ops));
  const local = bindLocalOps(ctx);
  const global = Object.assign(globalConstructor, bindGlobalOps(ctx));
  const ref = removeContexts(ctx, refOps);

  const control1 = removeContexts(ctx, controlOps);
  const cpntrol2 = bindControlOps(ctx);
  const control = Object.assign(control1, cpntrol2);

  const { drop, select_poly, select_t } = removeContexts(ctx, parametric);

  const memory = Object.assign(
    memoryConstructor,
    removeContexts(ctx, memoryOps)
  );
  const data = Object.assign(dataConstructor, removeContexts(ctx, dataOps));
  const table = Object.assign(tableConstructor, removeContexts(ctx, tableOps));
  const elem = Object.assign(elemConstructor, removeContexts(ctx, elemOps));

  const v128_ = removeContexts(ctx, v128Ops);
  const v128 = Object.assign(v128t, {
    ...v128_,
    const: wrapConst(v128_.const),
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
  };
}

function removeContexts<
  T extends {
    [K in any]: (ctx: LocalContext, ...args: any) => any;
  }
>(
  ctx: LocalContext,
  instructions: T
): {
  [K in keyof T]: RemoveContext<T[K]>;
} {
  let result: {
    [K in keyof T]: RemoveContext<T[K]>;
  } = {} as any;
  for (let k in instructions) {
    result[k] = ((...args: any) => instructions[k](ctx, ...args)) as any;
  }
  return result;
}

type RemoveContext<F extends (ctx: LocalContext, ...args: any) => any> =
  F extends (ctx: LocalContext, ...args: infer CreateArgs) => infer Return
    ? (...args: CreateArgs) => Return
    : never;

function removeContext<Args extends Tuple<any>, Return extends any>(
  ctx: LocalContext,
  op: (ctx: LocalContext, ...args: Args) => Return
): (...args: Args) => Return {
  return (...args: Args) => op(ctx, ...args);
}
