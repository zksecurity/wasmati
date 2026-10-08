import { i32t, i64t, f32t, f64t } from "../types.ts";
import { memoryInstruction } from "./memory.ts";
import { fixed } from "./stack-args.ts";
import { f32Const, f64Const, i32Const, i64Const } from "./const.ts";

export { i32Ops, i64Ops, f32Ops, f64Ops };

const i32Ops = {
  // memory
  load: memoryInstruction("i32.load", 32, [i32t], [i32t]),
  load16_s: memoryInstruction("i32.load16_s", 16, [i32t], [i32t]),
  load16_u: memoryInstruction("i32.load16_u", 16, [i32t], [i32t]),
  load8_s: memoryInstruction("i32.load8_s", 8, [i32t], [i32t]),
  load8_u: memoryInstruction("i32.load8_u", 8, [i32t], [i32t]),
  store: memoryInstruction("i32.store", 32, [i32t, i32t], []),
  store16: memoryInstruction("i32.store16", 16, [i32t, i32t], []),
  store8: memoryInstruction("i32.store8", 8, [i32t, i32t], []),

  // const
  const: i32Const,

  // comparison
  eqz: fixed("i32.eqz", [i32t], [i32t]),
  eq: fixed("i32.eq", [i32t, i32t], [i32t]),
  ne: fixed("i32.ne", [i32t, i32t], [i32t]),
  lt_s: fixed("i32.lt_s", [i32t, i32t], [i32t]),
  lt_u: fixed("i32.lt_u", [i32t, i32t], [i32t]),
  gt_s: fixed("i32.gt_s", [i32t, i32t], [i32t]),
  gt_u: fixed("i32.gt_u", [i32t, i32t], [i32t]),
  le_s: fixed("i32.le_s", [i32t, i32t], [i32t]),
  le_u: fixed("i32.le_u", [i32t, i32t], [i32t]),
  ge_s: fixed("i32.ge_s", [i32t, i32t], [i32t]),
  ge_u: fixed("i32.ge_u", [i32t, i32t], [i32t]),

  // unary
  clz: fixed("i32.clz", [i32t], [i32t]),
  ctz: fixed("i32.ctz", [i32t], [i32t]),
  popcnt: fixed("i32.popcnt", [i32t], [i32t]),

  // binary
  add: fixed("i32.add", [i32t, i32t], [i32t]),
  sub: fixed("i32.sub", [i32t, i32t], [i32t]),
  mul: fixed("i32.mul", [i32t, i32t], [i32t]),
  div_s: fixed("i32.div_s", [i32t, i32t], [i32t]),
  div_u: fixed("i32.div_u", [i32t, i32t], [i32t]),
  rem_s: fixed("i32.rem_s", [i32t, i32t], [i32t]),
  rem_u: fixed("i32.rem_u", [i32t, i32t], [i32t]),
  and: fixed("i32.and", [i32t, i32t], [i32t]),
  or: fixed("i32.or", [i32t, i32t], [i32t]),
  xor: fixed("i32.xor", [i32t, i32t], [i32t]),
  shl: fixed("i32.shl", [i32t, i32t], [i32t]),
  shr_s: fixed("i32.shr_s", [i32t, i32t], [i32t]),
  shr_u: fixed("i32.shr_u", [i32t, i32t], [i32t]),
  rotl: fixed("i32.rotl", [i32t, i32t], [i32t]),
  rotr: fixed("i32.rotr", [i32t, i32t], [i32t]),

  // conversion
  wrap_i64: fixed("i32.wrap_i64", [i64t], [i32t]),
  trunc_f32_s: fixed("i32.trunc_f32_s", [f32t], [i32t]),
  trunc_f32_u: fixed("i32.trunc_f32_u", [f32t], [i32t]),
  trunc_f64_s: fixed("i32.trunc_f64_s", [f64t], [i32t]),
  trunc_f64_u: fixed("i32.trunc_f64_u", [f64t], [i32t]),
  reinterpret_f32: fixed("i32.reinterpret_f32", [f32t], [i32t]),
  extend8_s: fixed("i32.extend8_s", [i32t], [i32t]),
  extend16_s: fixed("i32.extend16_s", [i32t], [i32t]),

  // non-trapping conversion
  trunc_sat_f32_s: fixed("i32.trunc_sat_f32_s", [f32t], [i32t]),
  trunc_sat_f32_u: fixed("i32.trunc_sat_f32_u", [f32t], [i32t]),
  trunc_sat_f64_s: fixed("i32.trunc_sat_f64_s", [f64t], [i32t]),
  trunc_sat_f64_u: fixed("i32.trunc_sat_f64_u", [f64t], [i32t]),
};

const i64Ops = {
  // memory
  load: memoryInstruction("i64.load", 64, [i32t], [i64t]),
  load32_s: memoryInstruction("i64.load32_s", 32, [i32t], [i64t]),
  load32_u: memoryInstruction("i64.load32_u", 32, [i32t], [i64t]),
  load16_s: memoryInstruction("i64.load16_s", 16, [i32t], [i64t]),
  load16_u: memoryInstruction("i64.load16_u", 16, [i32t], [i64t]),
  load8_s: memoryInstruction("i64.load8_s", 8, [i32t], [i64t]),
  load8_u: memoryInstruction("i64.load8_u", 8, [i32t], [i64t]),
  store: memoryInstruction("i64.store", 64, [i32t, i64t], []),
  store32: memoryInstruction("i64.store32", 32, [i32t, i64t], []),
  store16: memoryInstruction("i64.store16", 16, [i32t, i64t], []),
  store8: memoryInstruction("i64.store8", 8, [i32t, i64t], []),

  // const
  const: i64Const,

  // comparison
  eqz: fixed("i64.eqz", [i64t], [i32t]),
  eq: fixed("i64.eq", [i64t, i64t], [i32t]),
  ne: fixed("i64.ne", [i64t, i64t], [i32t]),
  lt_s: fixed("i64.lt_s", [i64t, i64t], [i32t]),
  lt_u: fixed("i64.lt_u", [i64t, i64t], [i32t]),
  gt_s: fixed("i64.gt_s", [i64t, i64t], [i32t]),
  gt_u: fixed("i64.gt_u", [i64t, i64t], [i32t]),
  le_s: fixed("i64.le_s", [i64t, i64t], [i32t]),
  le_u: fixed("i64.le_u", [i64t, i64t], [i32t]),
  ge_s: fixed("i64.ge_s", [i64t, i64t], [i32t]),
  ge_u: fixed("i64.ge_u", [i64t, i64t], [i32t]),

  // unary
  clz: fixed("i64.clz", [i64t], [i64t]),
  ctz: fixed("i64.ctz", [i64t], [i64t]),
  popcnt: fixed("i64.popcnt", [i64t], [i64t]),

  // binary
  add: fixed("i64.add", [i64t, i64t], [i64t]),
  sub: fixed("i64.sub", [i64t, i64t], [i64t]),
  mul: fixed("i64.mul", [i64t, i64t], [i64t]),
  div_s: fixed("i64.div_s", [i64t, i64t], [i64t]),
  div_u: fixed("i64.div_u", [i64t, i64t], [i64t]),
  rem_s: fixed("i64.rem_s", [i64t, i64t], [i64t]),
  rem_u: fixed("i64.rem_u", [i64t, i64t], [i64t]),
  and: fixed("i64.and", [i64t, i64t], [i64t]),
  or: fixed("i64.or", [i64t, i64t], [i64t]),
  xor: fixed("i64.xor", [i64t, i64t], [i64t]),
  shl: fixed("i64.shl", [i64t, i64t], [i64t]),
  shr_s: fixed("i64.shr_s", [i64t, i64t], [i64t]),
  shr_u: fixed("i64.shr_u", [i64t, i64t], [i64t]),
  rotl: fixed("i64.rotl", [i64t, i64t], [i64t]),
  rotr: fixed("i64.rotr", [i64t, i64t], [i64t]),

  // conversion
  extend_i32_s: fixed("i64.extend_i32_s", [i32t], [i64t]),
  extend_i32_u: fixed("i64.extend_i32_u", [i32t], [i64t]),
  trunc_f32_s: fixed("i64.trunc_f32_s", [f32t], [i64t]),
  trunc_f32_u: fixed("i64.trunc_f32_u", [f32t], [i64t]),
  trunc_f64_s: fixed("i64.trunc_f64_s", [f64t], [i64t]),
  trunc_f64_u: fixed("i64.trunc_f64_u", [f64t], [i64t]),
  reinterpret_f64: fixed("i64.reinterpret_f64", [f64t], [i64t]),
  extend8_s: fixed("i64.extend8_s", [i64t], [i64t]),
  extend16_s: fixed("i64.extend16_s", [i64t], [i64t]),
  extend32_s: fixed("i64.extend32_s", [i64t], [i64t]),

  // non-trapping conversion
  trunc_sat_f32_s: fixed("i64.trunc_sat_f32_s", [f32t], [i64t]),
  trunc_sat_f32_u: fixed("i64.trunc_sat_f32_u", [f32t], [i64t]),
  trunc_sat_f64_s: fixed("i64.trunc_sat_f64_s", [f64t], [i64t]),
  trunc_sat_f64_u: fixed("i64.trunc_sat_f64_u", [f64t], [i64t]),

  // wide arithmetic (128-bit operands and results are low/high i64 pairs)
  add128: fixed("i64.add128", [i64t, i64t, i64t, i64t], [i64t, i64t]),
  sub128: fixed("i64.sub128", [i64t, i64t, i64t, i64t], [i64t, i64t]),
  mul_wide_s: fixed("i64.mul_wide_s", [i64t, i64t], [i64t, i64t]),
  mul_wide_u: fixed("i64.mul_wide_u", [i64t, i64t], [i64t, i64t]),
};

const f32Ops = {
  // memory
  load: memoryInstruction("f32.load", 32, [i32t], [f32t]),
  store: memoryInstruction("f32.store", 32, [i32t, f32t], []),

  // const
  const: f32Const,

  // comparison
  eq: fixed("f32.eq", [f32t, f32t], [i32t]),
  ne: fixed("f32.ne", [f32t, f32t], [i32t]),
  lt: fixed("f32.lt", [f32t, f32t], [i32t]),
  gt: fixed("f32.gt", [f32t, f32t], [i32t]),
  le: fixed("f32.le", [f32t, f32t], [i32t]),
  ge: fixed("f32.ge", [f32t, f32t], [i32t]),

  // unary
  abs: fixed("f32.abs", [f32t], [f32t]),
  neg: fixed("f32.neg", [f32t], [f32t]),
  ceil: fixed("f32.ceil", [f32t], [f32t]),
  floor: fixed("f32.floor", [f32t], [f32t]),
  trunc: fixed("f32.trunc", [f32t], [f32t]),
  nearest: fixed("f32.nearest", [f32t], [f32t]),
  sqrt: fixed("f32.sqrt", [f32t], [f32t]),

  // binary
  add: fixed("f32.add", [f32t, f32t], [f32t]),
  sub: fixed("f32.sub", [f32t, f32t], [f32t]),
  mul: fixed("f32.mul", [f32t, f32t], [f32t]),
  div: fixed("f32.div", [f32t, f32t], [f32t]),
  min: fixed("f32.min", [f32t, f32t], [f32t]),
  max: fixed("f32.max", [f32t, f32t], [f32t]),
  copysign: fixed("f32.copysign", [f32t, f32t], [f32t]),

  // conversion
  convert_i32_s: fixed("f32.convert_i32_s", [i32t], [f32t]),
  convert_i32_u: fixed("f32.convert_i32_u", [i32t], [f32t]),
  convert_i64_s: fixed("f32.convert_i64_s", [i64t], [f32t]),
  convert_i64_u: fixed("f32.convert_i64_u", [i64t], [f32t]),
  demote_f64: fixed("f32.demote_f64", [f64t], [f32t]),
  reinterpret_i32: fixed("f32.reinterpret_i32", [i32t], [f32t]),
};

const f64Ops = {
  // memory
  load: memoryInstruction("f64.load", 64, [i32t], [f64t]),
  store: memoryInstruction("f64.store", 64, [i32t, f64t], []),

  // const
  const: f64Const,

  // comparison
  eq: fixed("f64.eq", [f64t, f64t], [i32t]),
  ne: fixed("f64.ne", [f64t, f64t], [i32t]),
  lt: fixed("f64.lt", [f64t, f64t], [i32t]),
  gt: fixed("f64.gt", [f64t, f64t], [i32t]),
  le: fixed("f64.le", [f64t, f64t], [i32t]),
  ge: fixed("f64.ge", [f64t, f64t], [i32t]),

  // unary
  abs: fixed("f64.abs", [f64t], [f64t]),
  neg: fixed("f64.neg", [f64t], [f64t]),
  ceil: fixed("f64.ceil", [f64t], [f64t]),
  floor: fixed("f64.floor", [f64t], [f64t]),
  trunc: fixed("f64.trunc", [f64t], [f64t]),
  nearest: fixed("f64.nearest", [f64t], [f64t]),
  sqrt: fixed("f64.sqrt", [f64t], [f64t]),

  // binary
  add: fixed("f64.add", [f64t, f64t], [f64t]),
  sub: fixed("f64.sub", [f64t, f64t], [f64t]),
  mul: fixed("f64.mul", [f64t, f64t], [f64t]),
  div: fixed("f64.div", [f64t, f64t], [f64t]),
  min: fixed("f64.min", [f64t, f64t], [f64t]),
  max: fixed("f64.max", [f64t, f64t], [f64t]),
  copysign: fixed("f64.copysign", [f64t, f64t], [f64t]),

  // conversion
  convert_i32_s: fixed("f64.convert_i32_s", [i32t], [f64t]),
  convert_i32_u: fixed("f64.convert_i32_u", [i32t], [f64t]),
  convert_i64_s: fixed("f64.convert_i64_s", [i64t], [f64t]),
  convert_i64_u: fixed("f64.convert_i64_u", [i64t], [f64t]),
  promote_f32: fixed("f64.promote_f32", [f32t], [f64t]),
  reinterpret_i64: fixed("f64.reinterpret_i64", [i64t], [f64t]),
};
