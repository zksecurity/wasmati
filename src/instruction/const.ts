import { F32, F64, I32, I64 } from "../immediate.ts";
import { fixedWithImmediate } from "./stack-args.ts";
import { i32t, i64t, f32t, f64t } from "../types.ts";

export { i32Const, i64Const, f32Const, f64Const, checkInt32, checkInt64 };

const i32Const = fixedWithImmediate("i32.const", I32, [], [i32t], checkInt32);
const i64Const = fixedWithImmediate("i64.const", I64, [], [i64t], checkInt64);
const f32Const = fixedWithImmediate("f32.const", F32, [], [f32t]);
const f64Const = fixedWithImmediate("f64.const", F64, [], [f64t]);

// integer validation

function checkInt32(value: number) {
  if (!Number.isInteger(value)) throw Error(`i32.const: value must be an integer, got ${value}`);
  if (value < -0x8000_0000 || value >= 0x1_0000_0000)
    throw Error(`i32.const: value lies outside the int32 and uint32 ranges, got ${value}`);
}

const int64Min = -0x8000_0000_0000_0000n;
const uint64End = 0x1_0000_0000_0000_0000n;

function checkInt64(value: bigint) {
  if (value < int64Min || value >= uint64End)
    throw Error(`i64.const: value lies outside the int64 and uint64 ranges, got ${value}`);
}
