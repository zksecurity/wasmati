import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  Module,
  block,
  br_if,
  call,
  constant,
  func,
  global,
  i32,
  i64,
  local,
  localArray,
  loop,
  memory,
  $,
  type Func,
} from "../index.ts";

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

// Async builders interleave where they await, between functions, which are built synchronously.
test("modules built concurrently with Promise.all equal modules built one after another", async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
  async function arithmetic(n: number) {
    const mem = memory({ min: 1 });
    const exports: Record<string, Func<any, any>> = {};
    for (let k = 0; k < n; k++) {
      await tick();
      exports[`mul${k}`] = func(
        { in: [{ out: i32 }, { x: i32 }], locals: { xs: localArray(i64, 4), carry: i64 }, out: [] },
        ({ out, x }, { xs, carry }) => {
          for (let i = 0; i < 4; i++) local.set(xs[i], i64.load({ offset: 8 * i }, x));
          for (let i = 0; i < 4; i++) {
            local.set(carry, i64.add(i64.mul(xs[i], xs[3 - i]), carry));
            i64.store({ offset: 8 * i }, local.get(out), i64.and(local.get(carry), 0xffff_ffffn));
          }
        },
      );
    }
    return Module({ exports: { ...exports, mem }, memory: mem });
  }
  async function counters(n: number) {
    const counter = global(
      constant(() => i32.const(0)),
      { mutable: true },
    );
    const exports: Record<string, Func<any, any>> = {};
    for (let k = 0; k < n; k++) {
      await tick();
      exports[`count${k}`] = func({ in: [{ n: i32 }], out: [i32] }, ({ n }) => {
        block((done) =>
          loop((next) => {
            i32.eqz(n);
            br_if(done);
            global.set(counter, i32.add(global.get(counter), k));
            local.set(n, i32.sub(n, 1));
            i32.const(1);
            br_if(next);
          }),
        );
        global.get(counter);
      });
    }
    return Module({ exports });
  }
  const hash = (module: { toBytes(): Uint8Array }) =>
    createHash("sha256").update(module.toBytes()).digest("hex");
  const expected = [hash(await arithmetic(20)), hash(await counters(20))];
  for (let round = 0; round < 3; round++) {
    const [a, b] = await Promise.all([arithmetic(20), counters(20)]);
    assert.deepEqual([hash(a), hash(b)], expected);
    const { instance } = await b.instantiate();
    assert.equal((instance.exports.count7 as (n: number) => number)(3), 21);
  }
});

test("bodies must be synchronous", () => {
  const promised = /the body returned a promise/;
  assert.throws(() => func({ in: [{ x: i32 }], out: [] }, async () => {}), promised);
  assert.throws(() => func({ in: [], out: [] }, () => block(async () => {})), promised);
});
