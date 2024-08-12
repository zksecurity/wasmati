import { F32, F64, U8 } from "../immediate.js";
import { baseInstruction, instructionWithArg as iarg } from "./base.js";
import { i32t, i64t, f32t, f64t, v128t } from "../types.js";
import {
  memoryLaneInstruction as mli,
  memoryInstruction as mi,
} from "./memory.js";
import { array, Byte } from "../binable.js";
import { TupleN } from "../util.js";
import { LocalContext } from "../local-context.js";
import { instruction as i } from "./stack-args.js";

export {
  v128Ops,
  i8x16Ops,
  i16x8Ops,
  i32x4Ops,
  i64x2Ops,
  f32x4Ops,
  f64x2Ops,
  wrapConst,
};

type VectorShape = "i8x16" | "i16x8" | "i32x4" | "i64x2" | "f32x4" | "f64x2";

const shapeLength = {
  i8x16: 16,
  i16x8: 8,
  i32x4: 4,
  i64x2: 2,
  f32x4: 4,
  f64x2: 2,
} as const satisfies Record<VectorShape, number>;
type ShapeLength = typeof shapeLength;

type ShapeType = {
  i8x16: number;
  i16x8: number;
  i32x4: number;
  i64x2: bigint;
  f32x4: number;
  f64x2: number;
};

type V128Generic<Shape extends VectorShape> = [
  shape: Shape,
  value: TupleN<ShapeType[Shape], ShapeLength[Shape]>
];

type V128 =
  | V128Generic<"i8x16">
  | V128Generic<"i16x8">
  | V128Generic<"i32x4">
  | V128Generic<"i64x2">
  | V128Generic<"f32x4">
  | V128Generic<"f64x2">;

function toV128Bytes<T extends V128>(...[shape, value]: T): TupleN<number, 16> {
  type Bytes16 = TupleN<number, 16>;
  if (value.length !== shapeLength[shape])
    throw Error(
      `v128.const: got input of length ${value.length}, but expected length ${shapeLength[shape]} for shape ${shape}.`
    );
  switch (shape) {
    case "i8x16":
      return value;
    case "i16x8":
      return value.flatMap((v) => numberToBytes(v, 2)) as Bytes16;
    case "i32x4":
      return value.flatMap((v) => numberToBytes(v, 4)) as Bytes16;
    case "i64x2":
      return value.flatMap((v) => bigintToBytes(v, 8)) as Bytes16;
    case "f32x4":
      return value.flatMap((v) => F32.toBytes(v)) as Bytes16;
    case "f64x2":
      return value.flatMap((v) => F64.toBytes(v)) as Bytes16;
    default:
      throw Error("unreachable");
  }
}

const V128 = array(Byte, 16);

function wrapConst<R>(const_: (...createArgs: V128) => R) {
  return function <Shape extends VectorShape>(
    shape: Shape,
    value: TupleN<ShapeType[Shape], ShapeLength[Shape]>
  ) {
    return const_(...([shape, value] as V128));
  };
}

const v128Ops = {
  // const
  const: baseInstruction("v128.const", V128, {
    create(_: LocalContext, ...v: V128) {
      let v128Bytes = toV128Bytes(...v);
      return { in: [], out: ["v128"], resolveArgs: [v128Bytes] };
    },
  }),

  // memory
  load: mi("v128.load", 128, [i32t], [v128t]),
  load8x8_s: mi("v128.load8x8_s", 8, [i32t], [v128t]),
  load8x8_u: mi("v128.load8x8_u", 8, [i32t], [v128t]),
  load16x4_s: mi("v128.load16x4_s", 16, [i32t], [v128t]),
  load16x4_u: mi("v128.load16x4_u", 16, [i32t], [v128t]),
  load32x2_s: mi("v128.load32x2_s", 32, [i32t], [v128t]),
  load32x2_u: mi("v128.load32x2_u", 32, [i32t], [v128t]),
  load8_splat: mi("v128.load8_splat", 8, [i32t], [v128t]),
  load16_splat: mi("v128.load16_splat", 16, [i32t], [v128t]),
  load32_splat: mi("v128.load32_splat", 32, [i32t], [v128t]),
  load64_splat: mi("v128.load64_splat", 64, [i32t], [v128t]),
  load32_zero: mi("v128.load32_zero", 32, [i32t], [v128t]),
  load64_zero: mi("v128.load64_zero", 64, [i32t], [v128t]),
  store: mi("v128.store", 128, [i32t, v128t], []),

  load8_lane: mli("v128.load8_lane", 8, [i32t, v128t], [v128t]),
  load16_lane: mli("v128.load16_lane", 16, [i32t, v128t], [v128t]),
  load32_lane: mli("v128.load32_lane", 32, [i32t, v128t], [v128t]),
  load64_lane: mli("v128.load64_lane", 64, [i32t, v128t], [v128t]),
  store8_lane: mli("v128.store8_lane", 8, [i32t, v128t], []),
  store16_lane: mli("v128.store16_lane", 16, [i32t, v128t], []),
  store32_lane: mli("v128.store32_lane", 32, [i32t, v128t], []),
  store64_lane: mli("v128.store64_lane", 64, [i32t, v128t], []),

  // logical
  not: i("v128.not", [v128t], [v128t]),
  and: i("v128.and", [v128t, v128t], [v128t]),
  andnot: i("v128.andnot", [v128t, v128t], [v128t]),
  or: i("v128.or", [v128t, v128t], [v128t]),
  xor: i("v128.xor", [v128t, v128t], [v128t]),
  bitselect: i("v128.bitselect", [v128t, v128t, v128t], [v128t]),
  any_true: i("v128.any_true", [v128t], [i32t]),
};

const i8x16Ops = {
  // shuffle
  shuffle: iarg("i8x16.shuffle", array(U8, 16), [v128t, v128t], [v128t]),

  // lane
  extract_lane_s: iarg("i8x16.extract_lane_s", U8, [v128t], [i32t]),
  extract_lane_u: iarg("i8x16.extract_lane_u", U8, [v128t], [i32t]),
  replace_lane: iarg("i8x16.replace_lane", U8, [v128t, i32t], [v128t]),

  // swizzle / splat
  swizzle: i("i8x16.swizzle", [v128t, v128t], [v128t]),
  splat: i("i8x16.splat", [i32t], [v128t]),

  // comparison
  eq: i("i8x16.eq", [v128t, v128t], [v128t]),
  ne: i("i8x16.ne", [v128t, v128t], [v128t]),
  lt_s: i("i8x16.lt_s", [v128t, v128t], [v128t]),
  lt_u: i("i8x16.lt_u", [v128t, v128t], [v128t]),
  gt_s: i("i8x16.gt_s", [v128t, v128t], [v128t]),
  gt_u: i("i8x16.gt_u", [v128t, v128t], [v128t]),
  le_s: i("i8x16.le_s", [v128t, v128t], [v128t]),
  le_u: i("i8x16.le_u", [v128t, v128t], [v128t]),
  ge_s: i("i8x16.ge_s", [v128t, v128t], [v128t]),
  ge_u: i("i8x16.ge_u", [v128t, v128t], [v128t]),

  // logic & arithmetic
  abs: i("i8x16.abs", [v128t], [v128t]),
  neg: i("i8x16.neg", [v128t], [v128t]),
  popcnt: i("i8x16.popcnt", [v128t], [v128t]),
  all_true: i("i8x16.all_true", [v128t], [i32t]),
  bitmask: i("i8x16.bitmask", [v128t], [i32t]),
  narrow_i16x8_s: i("i8x16.narrow_i16x8_s", [v128t, v128t], [v128t]),
  narrow_i16x8_u: i("i8x16.narrow_i16x8_u", [v128t, v128t], [v128t]),
  shl: i("i8x16.shl", [v128t, i32t], [v128t]),
  shr_s: i("i8x16.shr_s", [v128t, i32t], [v128t]),
  shr_u: i("i8x16.shr_u", [v128t, i32t], [v128t]),
  add: i("i8x16.add", [v128t, v128t], [v128t]),
  add_sat_s: i("i8x16.add_sat_s", [v128t, v128t], [v128t]),
  add_sat_u: i("i8x16.add_sat_u", [v128t, v128t], [v128t]),
  sub: i("i8x16.sub", [v128t, v128t], [v128t]),
  sub_sat_s: i("i8x16.sub_sat_s", [v128t, v128t], [v128t]),
  sub_sat_u: i("i8x16.sub_sat_u", [v128t, v128t], [v128t]),
  min_s: i("i8x16.min_s", [v128t, v128t], [v128t]),
  min_u: i("i8x16.min_u", [v128t, v128t], [v128t]),
  max_s: i("i8x16.max_s", [v128t, v128t], [v128t]),
  max_u: i("i8x16.max_u", [v128t, v128t], [v128t]),
  avgr_u: i("i8x16.avgr_u", [v128t, v128t], [v128t]),

  // relaxed
  relaxed_i8x16_swizzle: i("i8x16.relaxed_swizzle", [v128t, v128t], [v128t]),
  relaxed_laneselect: i(
    "i8x16.relaxed_laneselect",
    [v128t, v128t, v128t],
    [v128t]
  ),
};

const i16x8Ops = {
  // lane
  extract_lane_s: iarg("i16x8.extract_lane_s", U8, [v128t], [i32t]),
  extract_lane_u: iarg("i16x8.extract_lane_u", U8, [v128t], [i32t]),
  replace_lane: iarg("i16x8.replace_lane", U8, [v128t, i32t], [v128t]),

  // splat
  splat: i("i16x8.splat", [i32t], [v128t]),

  // comparison
  eq: i("i16x8.eq", [v128t, v128t], [v128t]),
  ne: i("i16x8.ne", [v128t, v128t], [v128t]),
  lt_s: i("i16x8.lt_s", [v128t, v128t], [v128t]),
  lt_u: i("i16x8.lt_u", [v128t, v128t], [v128t]),
  gt_s: i("i16x8.gt_s", [v128t, v128t], [v128t]),
  gt_u: i("i16x8.gt_u", [v128t, v128t], [v128t]),
  le_s: i("i16x8.le_s", [v128t, v128t], [v128t]),
  le_u: i("i16x8.le_u", [v128t, v128t], [v128t]),
  ge_s: i("i16x8.ge_s", [v128t, v128t], [v128t]),
  ge_u: i("i16x8.ge_u", [v128t, v128t], [v128t]),

  // logic & arithmetic
  extadd_pairwise_i8x16_s: i("i16x8.extadd_pairwise_i8x16_s", [v128t], [v128t]),
  extadd_pairwise_i8x16_u: i("i16x8.extadd_pairwise_i8x16_u", [v128t], [v128t]),
  abs: i("i16x8.abs", [v128t], [v128t]),
  neg: i("i16x8.neg", [v128t], [v128t]),
  q15mulr_sat_s: i("i16x8.q15mulr_sat_s", [v128t, v128t], [v128t]),
  all_true: i("i16x8.all_true", [v128t], [i32t]),
  bitmask: i("i16x8.bitmask", [v128t], [i32t]),
  narrow_i32x4_s: i("i16x8.narrow_i32x4_s", [v128t, v128t], [v128t]),
  narrow_i32x4_u: i("i16x8.narrow_i32x4_u", [v128t, v128t], [v128t]),
  extend_low_i8x16_s: i("i16x8.extend_low_i8x16_s", [v128t], [v128t]),
  extend_high_i8x16_s: i("i16x8.extend_high_i8x16_s", [v128t], [v128t]),
  extend_low_i8x16_u: i("i16x8.extend_low_i8x16_u", [v128t], [v128t]),
  extend_high_i8x16_u: i("i16x8.extend_high_i8x16_u", [v128t], [v128t]),
  shl: i("i16x8.shl", [v128t, i32t], [v128t]),
  shr_s: i("i16x8.shr_s", [v128t, i32t], [v128t]),
  shr_u: i("i16x8.shr_u", [v128t, i32t], [v128t]),
  add: i("i16x8.add", [v128t, v128t], [v128t]),
  add_sat_s: i("i16x8.add_sat_s", [v128t, v128t], [v128t]),
  add_sat_u: i("i16x8.add_sat_u", [v128t, v128t], [v128t]),
  sub: i("i16x8.sub", [v128t, v128t], [v128t]),
  sub_sat_s: i("i16x8.sub_sat_s", [v128t, v128t], [v128t]),
  sub_sat_u: i("i16x8.sub_sat_u", [v128t, v128t], [v128t]),
  mul: i("i16x8.mul", [v128t, v128t], [v128t]),
  min_s: i("i16x8.min_s", [v128t, v128t], [v128t]),
  min_u: i("i16x8.min_u", [v128t, v128t], [v128t]),
  max_s: i("i16x8.max_s", [v128t, v128t], [v128t]),
  max_u: i("i16x8.max_u", [v128t, v128t], [v128t]),
  avgr_u: i("i16x8.avgr_u", [v128t, v128t], [v128t]),
  extmul_low_i8x16_s: i("i16x8.extmul_low_i8x16_s", [v128t, v128t], [v128t]),
  extmul_high_i8x16_s: i("i16x8.extmul_high_i8x16_s", [v128t, v128t], [v128t]),
  extmul_low_i8x16_u: i("i16x8.extmul_low_i8x16_u", [v128t, v128t], [v128t]),
  extmul_high_i8x16_u: i("i16x8.extmul_high_i8x16_u", [v128t, v128t], [v128t]),

  // relaxed
  relaxed_laneselect: i(
    "i16x8.relaxed_laneselect",
    [v128t, v128t, v128t],
    [v128t]
  ),
  relaxed_q15mulr_s: i("i16x8.relaxed_q15mulr_s", [v128t, v128t], [v128t]),
  relaxed_dot_i8x16_i7x16_s: i(
    "i16x8.relaxed_dot_i8x16_i7x16_s",
    [v128t, v128t],
    [v128t]
  ),
};

const i32x4Ops = {
  // lane
  extract_lane: iarg("i32x4.extract_lane", U8, [v128t], [i32t]),
  replace_lane: iarg("i32x4.replace_lane", U8, [v128t, i32t], [v128t]),

  // splat
  splat: i("i32x4.splat", [i32t], [v128t]),

  // comparison
  eq: i("i32x4.eq", [v128t, v128t], [v128t]),
  ne: i("i32x4.ne", [v128t, v128t], [v128t]),
  lt_s: i("i32x4.lt_s", [v128t, v128t], [v128t]),
  lt_u: i("i32x4.lt_u", [v128t, v128t], [v128t]),
  gt_s: i("i32x4.gt_s", [v128t, v128t], [v128t]),
  gt_u: i("i32x4.gt_u", [v128t, v128t], [v128t]),
  le_s: i("i32x4.le_s", [v128t, v128t], [v128t]),
  le_u: i("i32x4.le_u", [v128t, v128t], [v128t]),
  ge_s: i("i32x4.ge_s", [v128t, v128t], [v128t]),
  ge_u: i("i32x4.ge_u", [v128t, v128t], [v128t]),

  // logic & arithmetic
  extadd_pairwise_i16x8_s: i("i32x4.extadd_pairwise_i16x8_s", [v128t], [v128t]),
  extadd_pairwise_i16x8_u: i("i32x4.extadd_pairwise_i16x8_u", [v128t], [v128t]),
  abs: i("i32x4.abs", [v128t], [v128t]),
  neg: i("i32x4.neg", [v128t], [v128t]),
  all_true: i("i32x4.all_true", [v128t], [i32t]),
  bitmask: i("i32x4.bitmask", [v128t], [i32t]),
  extend_low_i16x8_s: i("i32x4.extend_low_i16x8_s", [v128t], [v128t]),
  extend_high_i16x8_s: i("i32x4.extend_high_i16x8_s", [v128t], [v128t]),
  extend_low_i16x8_u: i("i32x4.extend_low_i16x8_u", [v128t], [v128t]),
  extend_high_i16x8_u: i("i32x4.extend_high_i16x8_u", [v128t], [v128t]),
  shl: i("i32x4.shl", [v128t, i32t], [v128t]),
  shr_s: i("i32x4.shr_s", [v128t, i32t], [v128t]),
  shr_u: i("i32x4.shr_u", [v128t, i32t], [v128t]),
  add: i("i32x4.add", [v128t, v128t], [v128t]),
  sub: i("i32x4.sub", [v128t, v128t], [v128t]),
  mul: i("i32x4.mul", [v128t, v128t], [v128t]),
  min_s: i("i32x4.min_s", [v128t, v128t], [v128t]),
  min_u: i("i32x4.min_u", [v128t, v128t], [v128t]),
  max_s: i("i32x4.max_s", [v128t, v128t], [v128t]),
  max_u: i("i32x4.max_u", [v128t, v128t], [v128t]),
  dot_i16x8_s: i("i32x4.dot_i16x8_s", [v128t, v128t], [v128t]),
  extmul_low_i16x8_s: i("i32x4.extmul_low_i16x8_s", [v128t, v128t], [v128t]),
  extmul_high_i16x8_s: i("i32x4.extmul_high_i16x8_s", [v128t, v128t], [v128t]),
  extmul_low_i16x8_u: i("i32x4.extmul_low_i16x8_u", [v128t, v128t], [v128t]),
  extmul_high_i16x8_u: i("i32x4.extmul_high_i16x8_u", [v128t, v128t], [v128t]),

  // non-trapping conversion
  trunc_sat_f32x4_s: i("i32x4.trunc_sat_f32x4_s", [v128t], [v128t]),
  trunc_sat_f32x4_u: i("i32x4.trunc_sat_f32x4_u", [v128t], [v128t]),
  trunc_sat_f64x2_s_zero: i("i32x4.trunc_sat_f64x2_s_zero", [v128t], [v128t]),
  trunc_sat_f64x2_u_zero: i("i32x4.trunc_sat_f64x2_u_zero", [v128t], [v128t]),

  // relaxed
  relaxed_trunc_f32x4_s: i("i32x4.relaxed_trunc_f32x4_s", [v128t], [v128t]),
  relaxed_trunc_f32x4_u: i("i32x4.relaxed_trunc_f32x4_u", [v128t], [v128t]),
  relaxed_trunc_f64x2_s_zero: i(
    "i32x4.relaxed_trunc_f64x2_s_zero",
    [v128t],
    [v128t]
  ),
  relaxed_trunc_f64x2_u_zero: i(
    "i32x4.relaxed_trunc_f64x2_u_zero",
    [v128t],
    [v128t]
  ),
  relaxed_laneselect: i(
    "i32x4.relaxed_laneselect",
    [v128t, v128t, v128t],
    [v128t]
  ),
  relaxed_dot_i8x16_i7x16_add_s: i(
    "i32x4.relaxed_dot_i8x16_i7x16_add_s",
    [v128t, v128t, v128t],
    [v128t]
  ),
};

const i64x2Ops = {
  // lane
  extract_lane: iarg("i64x2.extract_lane", U8, [v128t], [i64t]),
  replace_lane: iarg("i64x2.replace_lane", U8, [v128t, i64t], [v128t]),

  // splat
  splat: i("i64x2.splat", [i64t], [v128t]),

  // comparison
  eq: i("i64x2.eq", [v128t, v128t], [v128t]),
  ne: i("i64x2.ne", [v128t, v128t], [v128t]),
  lt_s: i("i64x2.lt_s", [v128t, v128t], [v128t]),
  gt_s: i("i64x2.gt_s", [v128t, v128t], [v128t]),
  le_s: i("i64x2.le_s", [v128t, v128t], [v128t]),
  ge_s: i("i64x2.ge_s", [v128t, v128t], [v128t]),

  // logic & arithmetic
  abs: i("i64x2.abs", [v128t], [v128t]),
  neg: i("i64x2.neg", [v128t], [v128t]),
  all_true: i("i64x2.all_true", [v128t], [i32t]),
  bitmask: i("i64x2.bitmask", [v128t], [i64t]),
  extend_low_i32x4_s: i("i64x2.extend_low_i32x4_s", [v128t], [v128t]),
  extend_high_i32x4_s: i("i64x2.extend_high_i32x4_s", [v128t], [v128t]),
  extend_low_i32x4_u: i("i64x2.extend_low_i32x4_u", [v128t], [v128t]),
  extend_high_i32x4_u: i("i64x2.extend_high_i32x4_u", [v128t], [v128t]),
  shl: i("i64x2.shl", [v128t, i32t], [v128t]),
  shr_s: i("i64x2.shr_s", [v128t, i32t], [v128t]),
  shr_u: i("i64x2.shr_u", [v128t, i32t], [v128t]),
  add: i("i64x2.add", [v128t, v128t], [v128t]),
  sub: i("i64x2.sub", [v128t, v128t], [v128t]),
  mul: i("i64x2.mul", [v128t, v128t], [v128t]),
  extmul_low_i32x4_s: i("i64x2.extmul_low_i32x4_s", [v128t, v128t], [v128t]),
  extmul_high_i32x4_s: i("i64x2.extmul_high_i32x4_s", [v128t, v128t], [v128t]),
  extmul_low_i32x4_u: i("i64x2.extmul_low_i32x4_u", [v128t, v128t], [v128t]),
  extmul_high_i32x4_u: i("i64x2.extmul_high_i32x4_u", [v128t, v128t], [v128t]),

  // relaxed
  relaxed_laneselect: i(
    "i64x2.relaxed_laneselect",
    [v128t, v128t, v128t],
    [v128t]
  ),
};

const f32x4Ops = {
  // lane
  extract_lane: iarg("f32x4.extract_lane", U8, [v128t], [f32t]),
  replace_lane: iarg("f32x4.replace_lane", U8, [v128t, f32t], [v128t]),

  // splat
  splat: i("f32x4.splat", [f32t], [v128t]),

  // comparison
  eq: i("f32x4.eq", [v128t, v128t], [v128t]),
  ne: i("f32x4.ne", [v128t, v128t], [v128t]),
  lt: i("f32x4.lt", [v128t, v128t], [v128t]),
  gt: i("f32x4.gt", [v128t, v128t], [v128t]),
  le: i("f32x4.le", [v128t, v128t], [v128t]),
  ge: i("f32x4.ge", [v128t, v128t], [v128t]),

  // logic & arithmetic
  ceil: i("f32x4.ceil", [v128t], [v128t]),
  floor: i("f32x4.floor", [v128t], [v128t]),
  trunc: i("f32x4.trunc", [v128t], [v128t]),
  nearest: i("f32x4.nearest", [v128t], [v128t]),
  abs: i("f32x4.abs", [v128t], [v128t]),
  neg: i("f32x4.neg", [v128t], [v128t]),
  sqrt: i("f32x4.sqrt", [v128t], [v128t]),
  add: i("f32x4.add", [v128t, v128t], [v128t]),
  sub: i("f32x4.sub", [v128t, v128t], [v128t]),
  mul: i("f32x4.mul", [v128t, v128t], [v128t]),
  div: i("f32x4.div", [v128t, v128t], [v128t]),
  min: i("f32x4.min", [v128t, v128t], [v128t]),
  max: i("f32x4.max", [v128t, v128t], [v128t]),
  pmin: i("f32x4.pmin", [v128t, v128t], [v128t]),
  pmax: i("f32x4.pmax", [v128t, v128t], [v128t]),

  // non-trapping conversion
  convert_i32x4_s: i("f32x4.convert_i32x4_s", [v128t], [v128t]),
  convert_i32x4_u: i("f32x4.convert_i32x4_u", [v128t], [v128t]),
  demote_f64x2_zero: i("f32x4.demote_f64x2_zero", [v128t], [v128t]),

  // relaxed
  relaxed_madd: i("f32x4.relaxed_madd", [v128t, v128t, v128t], [v128t]),
  relaxed_nmadd: i("f32x4.relaxed_nmadd", [v128t, v128t, v128t], [v128t]),
  relaxed_min: i("f32x4.relaxed_min", [v128t, v128t], [v128t]),
  relaxed_max: i("f32x4.relaxed_max", [v128t, v128t], [v128t]),
};

const f64x2Ops = {
  // lane
  extract_lane: iarg("f64x2.extract_lane", U8, [v128t], [f64t]),
  replace_lane: iarg("f64x2.replace_lane", U8, [v128t, f64t], [v128t]),

  // splat
  splat: i("f64x2.splat", [f64t], [v128t]),

  // comparison
  eq: i("f64x2.eq", [v128t, v128t], [v128t]),
  ne: i("f64x2.ne", [v128t, v128t], [v128t]),
  lt: i("f64x2.lt", [v128t, v128t], [v128t]),
  gt: i("f64x2.gt", [v128t, v128t], [v128t]),
  le: i("f64x2.le", [v128t, v128t], [v128t]),
  ge: i("f64x2.ge", [v128t, v128t], [v128t]),

  // logic & arithmetic
  ceil: i("f64x2.ceil", [v128t], [v128t]),
  floor: i("f64x2.floor", [v128t], [v128t]),
  trunc: i("f64x2.trunc", [v128t], [v128t]),
  nearest: i("f64x2.nearest", [v128t], [v128t]),
  abs: i("f64x2.abs", [v128t], [v128t]),
  neg: i("f64x2.neg", [v128t], [v128t]),
  sqrt: i("f64x2.sqrt", [v128t], [v128t]),
  add: i("f64x2.add", [v128t, v128t], [v128t]),
  sub: i("f64x2.sub", [v128t, v128t], [v128t]),
  mul: i("f64x2.mul", [v128t, v128t], [v128t]),
  div: i("f64x2.div", [v128t, v128t], [v128t]),
  min: i("f64x2.min", [v128t, v128t], [v128t]),
  max: i("f64x2.max", [v128t, v128t], [v128t]),
  pmin: i("f64x2.pmin", [v128t, v128t], [v128t]),
  pmax: i("f64x2.pmax", [v128t, v128t], [v128t]),

  // non-trapping conversion
  convert_low_i32x4_s: i("f64x2.convert_low_i32x4_s", [v128t], [v128t]),
  convert_low_i32x4_u: i("f64x2.convert_low_i32x4_u", [v128t], [v128t]),
  promote_low_f32x4: i("f64x2.promote_low_f32x4", [v128t], [v128t]),

  // relaxed
  relaxed_madd: i("f64x2.relaxed_madd", [v128t, v128t, v128t], [v128t]),
  relaxed_nmadd: i("f64x2.relaxed_nmadd", [v128t, v128t, v128t], [v128t]),
  relaxed_min: i("f64x2.relaxed_min", [v128t, v128t], [v128t]),
  relaxed_max: i("f64x2.relaxed_max", [v128t, v128t], [v128t]),
};

// helper

function numberToBytes<N extends number>(x: number, length: N) {
  let bytes = Array(length).fill(0) as TupleN<number, N>;
  for (let i = 0; i < length; i++) {
    bytes[i] = x & 0xff;
    x >>= 8;
  }
  if (x !== 0) throw Error(`${x} doesn't fit into ${length} bytes.`);
  return bytes;
}
function bigintToBytes<N extends number>(x: bigint, length: N) {
  let bytes = Array(length).fill(0) as TupleN<number, N>;
  for (let i = 0; i < length; i++) {
    bytes[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw Error(`${x} doesn't fit into ${length} bytes.`);
  return bytes;
}
