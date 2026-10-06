import assert from "node:assert/strict";
import test from "node:test";
import { func, i32, i64, Module, params } from "../index.ts";

test("signed and unsigned greater-than use distinct instructions for i32 and i64", async () => {
  const signed32 = func({ in: params({ x: i32 }, { y: i32 }), out: [i32] }, ({ x, y }) =>
    i32.gt_s(x, y),
  );
  const unsigned32 = func({ in: params({ x: i32 }, { y: i32 }), out: [i32] }, ({ x, y }) =>
    i32.gt_u(x, y),
  );
  const signed64 = func({ in: params({ x: i64 }, { y: i64 }), out: [i32] }, ({ x, y }) =>
    i64.gt_s(x, y),
  );
  const unsigned64 = func({ in: params({ x: i64 }, { y: i64 }), out: [i32] }, ({ x, y }) =>
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
