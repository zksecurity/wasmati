import assert from "node:assert/strict";
import test from "node:test";
import { func, i32, i64, f32, f64, Module } from "../index.ts";
import { F32, F64 } from "../immediate.ts";

test("signed and unsigned greater-than use distinct instructions for i32 and i64", async () => {
  const signed32 = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => i32.gt_s(x, y));
  const unsigned32 = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) =>
    i32.gt_u(x, y),
  );
  const signed64 = func({ in: [{ x: i64 }, { y: i64 }], out: [i32] }, ({ x, y }) => i64.gt_s(x, y));
  const unsigned64 = func({ in: [{ x: i64 }, { y: i64 }], out: [i32] }, ({ x, y }) =>
    i64.gt_u(x, y),
  );
  const module = Module({ exports: { signed32, unsigned32, signed64, unsigned64 } });
  assert.deepEqual(
    module.module.funcs.map((f) => f.body.at(-1)!.name),
    ["i32.gt_s", "i32.gt_u", "i64.gt_s", "i64.gt_u"],
  );
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.signed32(-1, 0), 0);
  assert.equal(instance.exports.unsigned32(-1, 0), 1);
  assert.equal(instance.exports.signed64(-1n, 0n), 0);
  assert.equal(instance.exports.unsigned64(-1n, 0n), 1);
});

test("float immediates preserve every NaN bit pattern, which JS numbers cannot carry", async () => {
  const f32Bytes = [0x01, 0x00, 0xa0, 0xff]; // -nan:0x200001, signaling
  const f64Bytes = [0x01, 0, 0, 0, 0, 0, 0xf4, 0x7f]; // nan:0x4000000000001, signaling
  assert.deepEqual(F32.fromBytes(f32Bytes), { bits: 0xffa00001 });
  assert.deepEqual(F32.toBytes(F32.fromBytes(f32Bytes)), f32Bytes);
  assert.deepEqual(F64.fromBytes(f64Bytes), { bits: 0x7ff4000000000001n });
  assert.deepEqual(F64.toBytes(F64.fromBytes(f64Bytes)), f64Bytes);
  assert.equal(F32.fromBytes(F32.toBytes(1.5)), 1.5);
  assert.ok(Object.is(F64.fromBytes(F64.toBytes(-0)), -0));
  assert.throws(() => F32.fromBytes([0, 0, 0xc0]));

  const bits32 = func({ in: [], out: [i32] }, () =>
    i32.reinterpret_f32(f32.const({ bits: 0xffa00001 })),
  );
  const bits64 = func({ in: [], out: [i64] }, () =>
    i64.reinterpret_f64(f64.const({ bits: 0x7ff4000000000001n })),
  );
  const { instance } = await Module({ exports: { bits32, bits64 } }).instantiate();
  assert.equal(instance.exports.bits32(), 0xffa00001 | 0);
  assert.equal(instance.exports.bits64(), 0x7ff4000000000001n);
});
