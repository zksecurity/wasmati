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
  select,
  call,
  unreachable,
  $,
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

test("numbers, locals and globals go right after the values below them", async () => {
  const f = func({ in: [{ v: i32 }], out: [i32, i32, i32] }, ({ v }) => {
    i32.const(100);
    const x = i32.const(9);
    i32.const(1);
    drop();
    i32.sub(5, x);
    i32.const(1);
    i32.const(2);
    i32.const(0);
    select();
    i32.sub(v, $);
  });
  const { instance } = await Module({ exports: { f } }).instantiate();
  assert.deepEqual(instance.exports.f(10), [100, -4, 8]);
});

test("locals and globals are not read before writes that come after earlier operands", () => {
  const g = global(
    constant(() => i32.const(0)),
    { mutable: true },
  );
  const bump = func({ in: [], out: [] }, () => global.set(g, 42));
  assert.throws(
    () =>
      func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
        const c = i32.const(1);
        local.set(x, 42);
        i32.sub(x, c);
      }),
    /local\.get: an operand would be read before local\.set/,
  );
  assert.throws(
    () =>
      func({ in: [], out: [i32] }, () => {
        const c = i32.const(1);
        call(bump);
        i32.sub(g, c);
      }),
    /global\.get: an operand would be read before call/,
  );
  // Immutable globals can't change.
  const h = global(constant(() => i32.const(7)));
  func({ in: [], out: [i32] }, () => {
    const c = i32.const(1);
    call(bump);
    i32.sub(h, c);
  });
});

test("operands are inserted in unreachable code", async () => {
  const f = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
    unreachable();
    i32.sub(x, $);
  });
  await Module({ exports: { f } }).instantiate();
});
