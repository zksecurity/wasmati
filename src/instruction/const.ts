import { F32, F64, I32, I64 } from "../immediate.js";
import { baseInstructionWithArg } from "./base.js";
import { i32t, i64t, f32t, f64t } from "../types.js";

export { i32Const, i64Const, f32Const, f64Const };

const i32Const = baseInstructionWithArg("i32.const", I32, [], [i32t]);
const i64Const = baseInstructionWithArg("i64.const", I64, [], [i64t]);
const f32Const = baseInstructionWithArg("f32.const", F32, [], [f32t]);
const f64Const = baseInstructionWithArg("f64.const", F64, [], [f64t]);
