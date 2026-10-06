import assert from "node:assert/strict";
import { test } from "node:test";
import wabtFactory from "wabt";
import { Const, Module, NameSection, call, f64, func, funcref, global, i32, i64, importFunc, local, memory, table } from "../index.ts";

test("named parameters and grouped locals emit their actual Wasm indices", async () => {
  const id = importFunc({ in: { value: i64 }, out: [i64] }, ({ value }) => value);
  id.string = "identity";
  const helper = func(
    {
      name: "helper",
      in: { count: i32, value: i64 },
      locals: { first: i64, fraction: f64, second: i64, scratch: i32 },
      out: [i64],
    },
    ({ count, value }, { first, fraction, second, scratch }) => {
      assert.deepEqual([count.index, value.index], [0, 1]);
      assert.deepEqual([first.index, fraction.index, second.index, scratch.index], [2, 4, 3, 5]);
      local.set(first, value);
      local.set(fraction, 1.5);
      local.set(second, i64.extend_i32_u(count));
      local.set(scratch, count);
      call(id, { value: i64.add(first, second) });
    },
  );
  const sum = func({ in: { count: i32, value: i64 }, out: [i64] }, ({ count, value }) => {
    // Call object order is independent of the callee's parameter order.
    call(helper, { value, count });
  });
  const module = Module({ name: "arithmetic", exports: { sum, alias: sum } });
  const expected = {
    module: "arithmetic",
    functions: { 0: "identity", 1: "sum", 2: "helper" },
    locals: {
      0: { 0: "value" },
      1: { 0: "count", 1: "value" },
      2: { 0: "count", 1: "value", 2: "first", 3: "second", 4: "fraction", 5: "scratch" },
    },
  };
  assert.deepEqual(module.module.names, expected);
  const { exports, instance, module: compiled } = await module.instantiate();
  assert(instance instanceof WebAssembly.Instance);
  assert.equal(exports.sum({ value: 40n, count: 2 }), 42n);
  assert.equal(exports.alias({ count: 2, value: 40n }), 42n);
  const native = instance.exports.sum as (count: number, value: bigint) => bigint;
  assert.equal(native(2, 40n), 42n);
  const payloads = WebAssembly.Module.customSections(compiled, "name");
  assert.equal(payloads.length, 1);
  assert.deepEqual(NameSection.fromBytes(new Uint8Array(payloads[0])), expected);
  const recovered = Module.fromBytes<{ sum: typeof sum; alias: typeof sum }>(module.toBytes(), module.importMap);
  assert.deepEqual(recovered.toBytes(), module.toBytes());
  const restored = await recovered.instantiate();
  assert.equal(restored.exports.sum({ count: 2, value: 40n }), 42n);
  const wabt = await wabtFactory();
  const wat = wabt.readWasm(module.toBytes(), { readDebugNames: true });
  try {
    const text = wat.toText({});
    for (const name of ["arithmetic", "sum", "helper", "count", "value", "first", "second", "fraction", "scratch"]) {
      assert(text.includes(`$${name}`));
    }
  } finally {
    wat.destroy();
  }
});

test("explicit metadata overrides individual inferred names without mutating functions", () => {
  const add = func({ in: { x: i32, y: i32 }, out: [i32] }, ({ x, y }) => i32.add(x, y));
  const one = Module({ name: "one", exports: { add }, names: {
    functions: { 0: "sum" }, locals: { 0: { 1: "right" } },
  } });
  assert.deepEqual(one.module.names, {
    module: "one", functions: { 0: "sum" }, locals: { 0: { 0: "x", 1: "right" } },
  });
  const two = Module({ exports: { other: add } });
  assert.deepEqual(two.module.names, {
    functions: { 0: "other" }, locals: { 0: { 0: "x", 1: "y" } },
  });
});

test("named imports and exports support empty parameters and multiple results", async () => {
  const pair = importFunc({ in: { small: i32, large: i64 }, out: [i32, i64] }, ({ small, large }) => [small, large]);
  const nothing = func({ in: {}, out: [] }, () => {});
  const constant = func({ in: {}, out: [i64] }, () => i64.const(42n));
  const { exports } = await Module({ exports: { pair, nothing, constant } }).instantiate();
  assert.deepEqual(exports.pair({ large: 40n, small: 2 }), [2, 40n]);
  assert.equal(exports.nothing(), undefined);
  assert.equal(exports.constant(), 42n);
});

test("named callbacks supply internal names, and stack calls still work", async () => {
  const helper = func({ in: { value: i32 }, out: [i32] }, function increment({ value }) {
    i32.add(value, 1);
  });
  const entry = func({ in: { value: i32 }, out: [i32] }, ({ value }) => {
    local.get(value);
    call(helper);
  });
  const module = Module({ exports: { entry } });
  assert.deepEqual(module.module.names?.functions, { 0: "entry", 1: "increment" });
  const { exports } = await module.instantiate();
  assert.equal(exports.entry({ value: 41 }), 42);
});

test("exported globals, tables and memories receive names and retain native identity", async () => {
  const module = Module({ name: "entities", exports: {
    counter: global(Const.i32(42)), memory: memory({ min: 1 }), table: table({ type: funcref, min: 0 }),
  } });
  assert.deepEqual(module.module.names, {
    module: "entities", globals: { 0: "counter" }, memories: { 0: "memory" }, tables: { 0: "table" },
  });
  const { instance, exports } = await module.instantiate();
  assert.equal(exports.counter, instance.exports.counter);
  assert.equal(exports.memory, instance.exports.memory);
  assert.equal(exports.table, instance.exports.table);
});

test("native parameter order follows Object.keys, including numeric keys", async () => {
  const ordered = func({ in: { last: i32, 2: i32, 1: i64 }, out: [i64] }, (args) => {
    i64.add(args[1], i64.extend_i32_u(i32.sub(args[2], args.last)));
  });
  assert.deepEqual(Object.keys(ordered.params), ["1", "2", "last"]);
  const { instance, exports } = await Module({ exports: { ordered } }).instantiate();
  assert.equal(exports.ordered({ last: 3, 1: 40n, 2: 5 }), 42n);
  const native = instance.exports.ordered as (one: bigint, two: number, last: number) => bigint;
  assert.equal(native(40n, 5, 3), 42n);
});

test("JS adapters handle parameter keys that require escaping", async () => {
  const key = 'left"\\\n🍚';
  const identity = importFunc({ in: { [key]: i64 }, out: [i64] }, (args) => args[key]);
  const { exports } = await Module({ exports: { identity } }).instantiate();
  assert.equal(exports.identity({ [key]: 42n }), 42n);
});

test("modules without parameter names retain native calls", async () => {
  const identity = func({ in: { value: i32 }, out: [i32] }, ({ value }) => local.get(value));
  const module = Module({ exports: { identity } });
  delete module.module.names;
  const recovered = Module.fromBytes<{ identity: typeof identity }>(module.toBytes());
  const { instance, exports } = await recovered.instantiate();
  const native = instance.exports.identity as (value: number) => number;
  assert.equal(native(42), 42);
  assert.throws(() => exports.identity({ value: 42 }), /require unique parameter names/);
});
