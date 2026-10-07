import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  global,
  constant,
  i32,
  local,
  block,
  br_on_null,
  drop,
  externref,
} from "../index.ts";

test("globals read by operands that come after instruction results are dependencies", async () => {
  const g = global(constant(() => i32.const(100)));
  const f = func({ in: [], out: [i32] }, () => {
    const x = i32.const(1);
    i32.sub(g, x);
  });
  const h = global(constant(() => i32.sub(g, i32.const(1))));
  const read = func({ in: [], out: [i32] }, () => global.get(h));
  const { instance } = await Module({ exports: { f, read } }).instantiate();
  assert.equal(instance.exports.f(), 99);
  assert.equal(instance.exports.read(), 99);
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
