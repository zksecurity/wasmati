import assert from "node:assert/strict";
import test from "node:test";
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
  isolatedWasmati,
  type Func,
  type Input,
  type Wasmati,
} from "../index.ts";
import * as wasmati from "../index.ts";

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

// Async builders interleave where they await, between functions, which are built synchronously:
// concurrent builds work with the default instance as well as with isolated ones.
test("modules built and instantiated concurrently with Promise.all work like ones built one after another", async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
  async function arithmetic(w: Wasmati, n: number) {
    const { func, i32, i64, local } = w;
    const mem = memory({ min: 1 });
    const exports: Record<string, Func<any, any>> = {};
    for (let k = 0; k < n; k++) {
      await tick();
      exports[`mul${k}`] = func(
        { in: [{ out: i32 }, { x: i32 }], locals: { xs: localArray(i64, 4), carry: i64 }, out: [] },
        ({ out, x }, { xs, carry }) => {
          for (let i = 0; i < 4; i++) local.set(xs[i], i64.load({ offset: 8 * i }, x));
          local.set(carry, BigInt(k));
          for (let i = 0; i < 4; i++) {
            local.set(carry, i64.add(i64.mul(xs[i], xs[3 - i]), carry));
            i64.store({ offset: 8 * i }, local.get(out), i64.and(local.get(carry), 0xffff_ffffn));
          }
        },
      );
    }
    await tick();
    const { instance } = await Module({ exports: { ...exports, mem }, memory: mem }).instantiate();
    return instance;
  }
  async function counters(w: Wasmati, n: number) {
    const { func, i32, global, constant, block, loop, br_if, local } = w;
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
    await tick();
    const { instance } = await Module({ exports }).instantiate();
    return instance;
  }
  type Instance = { exports: Record<string, any> };
  // What the instances compute: products of limbs in memory, and running counts.
  function products({ exports }: Instance, n: number) {
    let memory = new BigUint64Array(exports.mem.buffer);
    memory.set([3n, 5n << 33n, 7n, 11n << 40n]);
    let results: bigint[] = [];
    for (let k = 0; k < n; k++) {
      exports[`mul${k}`](64, 0);
      results.push(...memory.slice(8, 12));
    }
    return results;
  }
  function counts({ exports }: Instance, n: number) {
    return Array.from({ length: n }, (_, k) => exports[`count${k}`](3));
  }
  const expected = [
    products(await arithmetic(wasmati, 20), 20),
    counts(await counters(wasmati, 20), 20),
  ];
  for (let round = 0; round < 3; round++) {
    const [a, b] = await Promise.all([arithmetic(wasmati, 20), counters(wasmati, 20)]);
    assert.deepEqual([products(a, 20), counts(b, 20)], expected);
    const [c, d] = await Promise.all([
      arithmetic(isolatedWasmati(), 20),
      counters(isolatedWasmati(), 20),
    ]);
    assert.deepEqual([products(c, 20), counts(d, 20)], expected);
  }
  assert.equal(expected[1][19], (3 * (19 * 20)) / 2);
});

test("bodies must be synchronous", () => {
  const promised = /the body returned a promise/;
  assert.throws(() => func({ in: [{ x: i32 }], out: [] }, async () => {}), promised);
  assert.throws(() => func({ in: [], out: [] }, () => block(async () => {})), promised);
});

test("isolated instances build functions independently, even interleaved instruction by instruction", async () => {
  const a = isolatedWasmati();
  const b = isolatedWasmati();
  let g: Func<any, any> | undefined;
  const f = a.func({ in: [{ x: a.i32 }], out: [a.i32] }, ({ x }) => {
    const one = a.i32.add(x, 1);
    // b builds a whole function in the middle of an expression of a, and both emit into their own
    g = b.func({ in: [{ y: b.i32 }], out: [b.i32] }, ({ y }) => {
      const two = b.i32.mul(y, 2);
      a.i32.const(10);
      b.i32.add(two, 3);
    });
    a.i32.add(one, $);
  });
  const { instance } = await Module({ exports: { f, g: g! } }).instantiate();
  assert.equal(instance.exports.f(5), 16);
  assert.equal(instance.exports.g(5), 13);
});

test("helpers write into the instance they are handed, isolated or the default one", async () => {
  // a helper library, written against the instance it is handed
  const addOne = ({ i32 }: Wasmati, x: Input<"i32">) => i32.add(x, 1);
  const isolated = isolatedWasmati();
  const f = isolated.func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => addOne(isolated, x));
  const g = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => addOne(wasmati, x));
  const { instance } = await Module({ exports: { f, g } }).instantiate();
  assert.equal(instance.exports.f(1), 2);
  assert.equal(instance.exports.g(2), 3);
});

test("instructions throw where their instance builds nothing", () => {
  const idle = /no function or constant is being built with this instance/;
  const isolated = isolatedWasmati();
  assert.throws(() => i32.const(1), idle);
  assert.throws(() => isolated.i32.const(1), idle);
  assert.throws(() => func({ in: [{ x: i32 }], out: [] }, ({ x }) => isolated.local.get(x)), idle);
  assert.throws(() => isolated.func({ in: [], out: [i32] }, () => i32.const(1)), idle);
});
