import assert from "node:assert/strict";
import test from "node:test";
import { Module, block, call, constant, func, global, i32, local, $, type Func } from "../index.ts";

// Builders share one context, which functions, constants and modules built in the middle of a body
// must leave as they found it.
test("functions, constants and modules can be built in the middle of a function body", async () => {
  let inner: Func<any, any> | undefined;
  let other: Uint8Array<ArrayBuffer> | undefined;
  const outer = func({ in: [{ x: i32 }], locals: { t: i32 }, out: [i32] }, ({ x }, { t }) => {
    i32.add(x, 1);
    block({ in: [i32], out: [i32] }, () => {
      const b = i32.add(x, 2);
      inner = func({ in: [{ y: i32 }], out: [i32] }, ({ y }) => {
        const c = i32.mul(y, 3);
        // two levels deep: a module of its own
        const deep = func({ in: [], out: [i32] }, () => i32.const(4));
        other = Module({ exports: { deep } }).toBytes();
        i32.add(c, 0);
      });
      i32.add($, b);
    });
    const offset = global(constant(() => i32.const(100)));
    local.set(t, i32.mul($, 2));
    call(inner!, { y: x });
    i32.add($, t);
    i32.add($, offset);
  });
  const { instance } = await Module({ exports: { outer } }).instantiate();
  // 3x + 2 (x + 1 + x + 2) + 100
  assert.equal(instance.exports.outer(5), 15 + 26 + 100);
  const deep = new WebAssembly.Instance(new WebAssembly.Module(other!));
  assert.equal((deep.exports.deep as () => number)(), 4);
});
