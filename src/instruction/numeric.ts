import { F32, F64, I32, I64 } from "../immediate.js";
import { instruction, instructionWithArg } from "./base.js";
import { i32t, i64t, f32t, f64t } from "../types.js";
import { memoryInstruction } from "./memory.js";

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
  const: instructionWithArg("i32.const", I32, [], [i32t]),

  // comparison
  eqz: instruction("i32.eqz", [i32t], [i32t]),
  eq: instruction("i32.eq", [i32t, i32t], [i32t]),
  ne: instruction("i32.ne", [i32t, i32t], [i32t]),
  lt_s: instruction("i32.lt_s", [i32t, i32t], [i32t]),
  lt_u: instruction("i32.lt_u", [i32t, i32t], [i32t]),
  gt_s: instruction("i32.gt_u", [i32t, i32t], [i32t]),
  gt_u: instruction("i32.gt_u", [i32t, i32t], [i32t]),
  le_s: instruction("i32.le_s", [i32t, i32t], [i32t]),
  le_u: instruction("i32.le_u", [i32t, i32t], [i32t]),
  ge_s: instruction("i32.ge_s", [i32t, i32t], [i32t]),
  ge_u: instruction("i32.ge_u", [i32t, i32t], [i32t]),

  // unary
  clz: instruction("i32.clz", [i32t], [i32t]),
  ctz: instruction("i32.ctz", [i32t], [i32t]),
  popcnt: instruction("i32.popcnt", [i32t], [i32t]),

  // binary
  add: instruction("i32.add", [i32t, i32t], [i32t]),
  sub: instruction("i32.sub", [i32t, i32t], [i32t]),
  mul: instruction("i32.mul", [i32t, i32t], [i32t]),
  div_s: instruction("i32.div_s", [i32t, i32t], [i32t]),
  div_u: instruction("i32.div_u", [i32t, i32t], [i32t]),
  rem_s: instruction("i32.rem_s", [i32t, i32t], [i32t]),
  rem_u: instruction("i32.rem_u", [i32t, i32t], [i32t]),
  and: instruction("i32.and", [i32t, i32t], [i32t]),
  or: instruction("i32.or", [i32t, i32t], [i32t]),
  xor: instruction("i32.xor", [i32t, i32t], [i32t]),
  shl: instruction("i32.shl", [i32t, i32t], [i32t]),
  shr_s: instruction("i32.shr_s", [i32t, i32t], [i32t]),
  shr_u: instruction("i32.shr_u", [i32t, i32t], [i32t]),
  rotl: instruction("i32.rotl", [i32t, i32t], [i32t]),
  rotr: instruction("i32.rotr", [i32t, i32t], [i32t]),

  // conversion
  wrap_i64: instruction("i32.wrap_i64", [i64t], [i32t]),
  trunc_f32_s: instruction("i32.trunc_f32_s", [f32t], [i32t]),
  trunc_f32_u: instruction("i32.trunc_f32_u", [f32t], [i32t]),
  trunc_f64_s: instruction("i32.trunc_f64_s", [f64t], [i32t]),
  trunc_f64_u: instruction("i32.trunc_f64_u", [f64t], [i32t]),
  reinterpret_f32: instruction("i32.reinterpret_f32", [f32t], [i32t]),
  extend8_s: instruction("i32.extend8_s", [i32t], [i32t]),
  extend16_s: instruction("i32.extend16_s", [i32t], [i32t]),

  // non-trapping conversion
  trunc_sat_f32_s: instruction("i32.trunc_sat_f32_s", [f32t], [i32t]),
  trunc_sat_f32_u: instruction("i32.trunc_sat_f32_u", [f32t], [i32t]),
  trunc_sat_f64_s: instruction("i32.trunc_sat_f64_s", [f64t], [i32t]),
  trunc_sat_f64_u: instruction("i32.trunc_sat_f64_u", [f64t], [i32t]),
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
  const: instructionWithArg("i64.const", I64, [], [i64t]),

  // comparison
  eqz: instruction("i64.eqz", [i64t], [i32t]),
  eq: instruction("i64.eq", [i64t, i64t], [i32t]),
  ne: instruction("i64.ne", [i64t, i64t], [i32t]),
  lt_s: instruction("i64.lt_s", [i64t, i64t], [i32t]),
  lt_u: instruction("i64.lt_u", [i64t, i64t], [i32t]),
  gt_s: instruction("i64.gt_u", [i64t, i64t], [i32t]),
  gt_u: instruction("i64.gt_u", [i64t, i64t], [i32t]),
  le_s: instruction("i64.le_s", [i64t, i64t], [i32t]),
  le_u: instruction("i64.le_u", [i64t, i64t], [i32t]),
  ge_s: instruction("i64.ge_s", [i64t, i64t], [i32t]),
  ge_u: instruction("i64.ge_u", [i64t, i64t], [i32t]),

  // unary
  clz: instruction("i64.clz", [i64t], [i64t]),
  ctz: instruction("i64.ctz", [i64t], [i64t]),
  popcnt: instruction("i64.popcnt", [i64t], [i64t]),

  // binary
  add: instruction("i64.add", [i64t, i64t], [i64t]),
  sub: instruction("i64.sub", [i64t, i64t], [i64t]),
  mul: instruction("i64.mul", [i64t, i64t], [i64t]),
  div_s: instruction("i64.div_s", [i64t, i64t], [i64t]),
  div_u: instruction("i64.div_u", [i64t, i64t], [i64t]),
  rem_s: instruction("i64.rem_s", [i64t, i64t], [i64t]),
  rem_u: instruction("i64.rem_u", [i64t, i64t], [i64t]),
  and: instruction("i64.and", [i64t, i64t], [i64t]),
  or: instruction("i64.or", [i64t, i64t], [i64t]),
  xor: instruction("i64.xor", [i64t, i64t], [i64t]),
  shl: instruction("i64.shl", [i64t, i64t], [i64t]),
  shr_s: instruction("i64.shr_s", [i64t, i64t], [i64t]),
  shr_u: instruction("i64.shr_u", [i64t, i64t], [i64t]),
  rotl: instruction("i64.rotl", [i64t, i64t], [i64t]),
  rotr: instruction("i64.rotr", [i64t, i64t], [i64t]),

  // conversion
  extend_i32_s: instruction("i64.extend_i32_s", [i32t], [i64t]),
  extend_i32_u: instruction("i64.extend_i32_u", [i32t], [i64t]),
  trunc_f32_s: instruction("i64.trunc_f32_s", [f32t], [i64t]),
  trunc_f32_u: instruction("i64.trunc_f32_u", [f32t], [i64t]),
  trunc_f64_s: instruction("i64.trunc_f64_s", [f64t], [i64t]),
  trunc_f64_u: instruction("i64.trunc_f64_u", [f64t], [i64t]),
  reinterpret_f32: instruction("i64.reinterpret_f64", [f64t], [i64t]),
  extend8_s: instruction("i64.extend8_s", [i64t], [i64t]),
  extend16_s: instruction("i64.extend16_s", [i64t], [i64t]),
  extend32_s: instruction("i64.extend32_s", [i64t], [i64t]),

  // non-trapping conversion
  trunc_sat_f32_s: instruction("i64.trunc_sat_f32_s", [f32t], [i64t]),
  trunc_sat_f32_u: instruction("i64.trunc_sat_f32_u", [f32t], [i64t]),
  trunc_sat_f64_s: instruction("i64.trunc_sat_f64_s", [f64t], [i64t]),
  trunc_sat_f64_u: instruction("i64.trunc_sat_f64_u", [f64t], [i64t]),
};

const f32Ops = {
  // memory
  load: memoryInstruction("f32.load", 32, [i32t], [f32t]),
  store: memoryInstruction("f32.store", 32, [i32t, f32t], []),

  // const
  const: instructionWithArg("f32.const", F32, [], [f32t]),

  // comparison
  eq: instruction("f32.eq", [f32t, f32t], [i32t]),
  ne: instruction("f32.ne", [f32t, f32t], [i32t]),
  lt: instruction("f32.lt", [f32t, f32t], [i32t]),
  gt: instruction("f32.gt", [f32t, f32t], [i32t]),
  le: instruction("f32.le", [f32t, f32t], [i32t]),
  ge: instruction("f32.ge", [f32t, f32t], [i32t]),

  // unary
  abs: instruction("f32.abs", [f32t], [f32t]),
  neg: instruction("f32.neg", [f32t], [f32t]),
  ceil: instruction("f32.ceil", [f32t], [f32t]),
  floor: instruction("f32.floor", [f32t], [f32t]),
  trunc: instruction("f32.trunc", [f32t], [f32t]),
  nearest: instruction("f32.nearest", [f32t], [f32t]),
  sqrt: instruction("f32.sqrt", [f32t], [f32t]),

  // binary
  add: instruction("f32.add", [f32t, f32t], [f32t]),
  sub: instruction("f32.sub", [f32t, f32t], [f32t]),
  mul: instruction("f32.mul", [f32t, f32t], [f32t]),
  div: instruction("f32.div", [f32t, f32t], [f32t]),
  min: instruction("f32.min", [f32t, f32t], [f32t]),
  max: instruction("f32.max", [f32t, f32t], [f32t]),
  copysign: instruction("f32.copysign", [f32t, f32t], [f32t]),

  // conversion
  convert_i32_s: instruction("f32.convert_i32_s", [i32t], [f32t]),
  convert_i32_u: instruction("f32.convert_i32_u", [i32t], [f32t]),
  convert_i64_s: instruction("f32.convert_i64_s", [i64t], [f32t]),
  convert_i64_u: instruction("f32.convert_i64_u", [i64t], [f32t]),
  demote_f64: instruction("f32.demote_f64", [f64t], [f32t]),
  reinterpret_i32: instruction("f32.reinterpret_i32", [i32t], [f32t]),
};

const f64Ops = {
  // memory
  load: memoryInstruction("f64.load", 64, [i32t], [f64t]),
  store: memoryInstruction("f64.store", 64, [i32t, f64t], []),

  // const
  const: instructionWithArg("f64.const", F64, [], [f64t]),

  // comparison
  eq: instruction("f64.eq", [f64t, f64t], [i32t]),
  ne: instruction("f64.ne", [f64t, f64t], [i32t]),
  lt: instruction("f64.lt", [f64t, f64t], [i32t]),
  gt: instruction("f64.gt", [f64t, f64t], [i32t]),
  le: instruction("f64.le", [f64t, f64t], [i32t]),
  ge: instruction("f64.ge", [f64t, f64t], [i32t]),

  // unary
  abs: instruction("f64.abs", [f64t], [f64t]),
  neg: instruction("f64.neg", [f64t], [f64t]),
  ceil: instruction("f64.ceil", [f64t], [f64t]),
  floor: instruction("f64.floor", [f64t], [f64t]),
  trunc: instruction("f64.trunc", [f64t], [f64t]),
  nearest: instruction("f64.nearest", [f64t], [f64t]),
  sqrt: instruction("f64.sqrt", [f64t], [f64t]),

  // binary
  add: instruction("f64.add", [f64t, f64t], [f64t]),
  sub: instruction("f64.sub", [f64t, f64t], [f64t]),
  mul: instruction("f64.mul", [f64t, f64t], [f64t]),
  div: instruction("f64.div", [f64t, f64t], [f64t]),
  min: instruction("f64.min", [f64t, f64t], [f64t]),
  max: instruction("f64.max", [f64t, f64t], [f64t]),
  copysign: instruction("f64.copysign", [f64t, f64t], [f64t]),

  // conversion
  convert_i32_s: instruction("f64.convert_i32_s", [i32t], [f64t]),
  convert_i32_u: instruction("f64.convert_i32_u", [i32t], [f64t]),
  convert_i64_s: instruction("f64.convert_i64_s", [i64t], [f64t]),
  convert_i64_u: instruction("f64.convert_i64_u", [i64t], [f64t]),
  promote_f32: instruction("f64.promote_f32", [f32t], [f64t]),
  reinterpret_i64: instruction("f64.reinterpret_i64", [i64t], [f64t]),
};
