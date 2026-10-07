import assert from "node:assert/strict";
import test from "node:test";
import {
  func,
  global,
  Const,
  i32,
  i64,
  f32,
  f64,
  v128,
  i8x16,
  i32x4,
  i64x2,
  Module,
} from "../index.ts";
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

test("i64x2.bitmask returns an i32", async () => {
  const bitmask = func({ in: [{ x: v128 }], out: [i32] }, ({ x }) => i64x2.bitmask(x));
  const module = Module({ exports: { bitmask } });
  assert.ok(WebAssembly.validate(module.toBytes()));
});

test("vector constants accept signed lanes and initialize globals", async () => {
  const g = global(Const.v128("i32x4", [-1, 2, 0xffffffff, -0x80000000]));
  const lane = func({ in: [], out: [i32] }, () => i32x4.extract_lane(0, global.get(g)));
  const { instance } = await Module({ exports: { lane } }).instantiate();
  assert.equal(instance.exports.lane(), -1);
  assert.throws(() => Const.v128("i8x16", [256, ...Array(15).fill(0)] as any), /fit/);
});

test("constant expressions combine integers with add, sub and mul", async () => {
  const base = global(Const.i32(10));
  const offset = global(
    Const.i32.add(Const.globalGet(base), Const.i32.mul(Const.i32(3), Const.i32(4))),
  );
  const wide = global(Const.i64.sub(Const.i64(1), Const.i64(2)));
  const read = func({ in: [], out: [i32] }, () => global.get(offset));
  const readWide = func({ in: [], out: [i64] }, () => global.get(wide));
  const module = Module({ exports: { read, readWide } });
  assert.deepEqual(
    module.module.globals[1].init.map((i) => i.name),
    ["global.get", "i32.const", "i32.const", "i32.mul", "i32.add"],
  );
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.read(), 22);
  assert.equal(instance.exports.readWide(), -1n);
});

test("i8x16.relaxed_swizzle is named after its instruction", async () => {
  const swizzle = func({ in: [], out: [i32] }, () => {
    v128.const("i8x16", [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    v128.const("i8x16", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    i8x16.relaxed_swizzle();
    i8x16.extract_lane_u(0);
  });
  const { instance } = await Module({ exports: { swizzle } }).instantiate();
  assert.equal(instance.exports.swizzle(), 7);
});
