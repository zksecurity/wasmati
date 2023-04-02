export { Module } from "./module.js";
import {
  localOps,
  globalOps,
  globalConstructor,
  refOps,
} from "./instruction/variable.js";
import { f32Ops, f64Ops, i32Ops, i64Ops } from "./instruction/numeric.js";
import { memoryOps, dataOps, tableOps, elemOps } from "./instruction/memory.js";
import { control as controlOps, parametric } from "./instruction/control.js";
import { emptyContext, LocalContext } from "./local-context.js";
import { Tuple } from "./util.js";
import { f32t, f64t, i32t, i64t, v128t, ValueTypeObject } from "./types.js";
import { func as originalFunc } from "./func.js";
import { Instruction } from "./instruction/base.js";
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
export { func, defaultCtx };
export { funcref, externref, Type } from "./types.js";
export { importFunc, importGlobal } from "./export.js";
export {
  memoryConstructor,
  dataConstructor,
  tableConstructor,
  elemConstructor,
} from "./memory.js";
export { Const } from "./dependency.js";

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

function createInstructions(ctx: LocalContext) {
  const func = removeContext(ctx, originalFunc);
  const i32 = Object.assign(i32t, removeContexts(ctx, i32Ops));
  const i64 = Object.assign(i64t, removeContexts(ctx, i64Ops));
  const f32 = Object.assign(f32t, removeContexts(ctx, f32Ops));
  const f64 = Object.assign(f64t, removeContexts(ctx, f64Ops));
  const local = removeContexts(ctx, localOps);
  const global = Object.assign(
    globalConstructor,
    removeContexts(ctx, globalOps)
  );
  const ref = removeContexts(ctx, refOps);
  const control = removeContexts(ctx, controlOps);
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
    [K in any]: (ctx: LocalContext, ...args: any) => Instruction<any, any>;
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
