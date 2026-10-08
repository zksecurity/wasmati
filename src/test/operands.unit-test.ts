import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  global,
  constant,
  i32,
  i64,
  local,
  block,
  br_on_null,
  drop,
  externref,
  call,
  unreachable,
  $,
} from "../index.ts";

test("globals read by operands that come after instruction results are dependencies", async () => {
  const g = global(constant(() => i32.const(100)));
  const f = func({ in: [], out: [i32] }, () => {
    const x = i32.const(101);
    i32.sub(x, g);
  });
  const h = global(constant(() => i32.sub(i32.const(101), g)));
  const read = func({ in: [], out: [i32] }, () => global.get(h));
  const { instance } = await Module({ exports: { f, read } }).instantiate();
  assert.equal(instance.exports.f(), 1);
  assert.equal(instance.exports.read(), 1);
});

test("branches on references leave the values under the reference in place", async () => {
  const f = func({ in: [{ r: externref }], out: [i32] }, ({ r }) => {
    block({ out: [i32] }, (label) => {
      const a = i32.const(5);
      local.get(r);
      br_on_null(label);
      drop();
      i32.add(a, 1);
    });
  });
  const { instance } = await Module({ exports: { f } }).instantiate();
  assert.equal(instance.exports.f("x"), 6);
  assert.equal(instance.exports.f(null), 5);
});

test("numbers, locals and globals are written where they are passed, after instruction results", async () => {
  const f = func({ in: [{ v: i32 }], out: [i32, i32, i32] }, ({ v }) => {
    i32.sub(i32.const(5), i32.const(9));
    const x = i32.const(9);
    i32.sub(x, v);
    i32.const(1);
    i32.add($, v);
  });
  const g = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
    unreachable();
    i32.sub($, x);
  });
  const { instance } = await Module({ exports: { f, g } }).instantiate();
  assert.deepEqual(instance.exports.f(10), [-4, -1, 11]);
});

test("numbers, locals and globals can't come before instruction results", () => {
  const g = global(constant(() => i32.const(0)));
  const callee = func({ in: [{ a: i32 }, { b: i32 }], out: [] }, () => {});
  const order = /comes before an instruction result/;
  const throws = (run: () => void) =>
    assert.throws(() => func({ in: [{ x: i32 }], out: [] }, run), order);
  throws(() => void i32.sub(5, i32.const(1)));
  throws(() => void i32.sub(g, $));
  throws(() => void i64.add128(1n, 0n, i64.const(2n), 0n));
  throws(() => call(callee, { a: 1, b: i32.const(2) }));
  throws(() => i32.store({}, 0, i32.const(1)));
  assert.throws(() => global(constant(() => i32.sub(1, i32.const(2)))), order);
});
