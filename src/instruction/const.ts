import { F32, F64, I32, I64 } from "../immediate.js";
import { baseInstructionWithImmediate } from "./base.js";
import { i32t, i64t, f32t, f64t } from "../types.js";

export { i32Const, i64Const, f32Const, f64Const };

const i32Const = baseInstructionWithImmediate(
  "i32.const",
  I32,
  [],
  [i32t],
  checkInt32
);
const i64Const = baseInstructionWithImmediate(
  "i64.const",
  I64,
  [],
  [i64t],
  checkInt64
);
const f32Const = baseInstructionWithImmediate("f32.const", F32, [], [f32t]);
const f64Const = baseInstructionWithImmediate("f64.const", F64, [], [f64t]);

// integer validation

function checkInt32(value: number) {
  if (!Number.isInteger(value))
    throw Error(`i32.const: value must be an integer, got ${value}`);
  if (value < -0x8000_0000 || value >= 0x1_0000_0000)
    throw Error(
      `i32.const: value lies outside the int32 and uint32 ranges, got ${value}`
    );
}

function checkInt64(value: bigint) {
  if (value < -0x8000_0000_0000_0000n || value >= 0x1_0000_0000_0000_0000n)
    throw Error(
      `i64.const: value lies outside the int64 and uint64 ranges, got ${value}`
    );
}
