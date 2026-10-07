import assert from "node:assert/strict";
import { test } from "node:test";
import wabtFactory from "wabt";
import {
  localArray,
  constant,
  Module,
  NameSection,
  call,
  declareFunc,
  f64,
  func,
  funcref,
  global,
  i32,
  i64,
  importFunc,
  local,
  memory,
  table,
  v128,
} from "../index.ts";

test("named parameters and grouped locals emit their actual Wasm indices", async () => {
  const id = importFunc({ field: "identity", in: [{ value: i64 }], out: [i64] }, (value) => value);
  const helper = func(
    {
      name: "helper",
      in: [{ count: i32 }, { value: i64 }],
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
  const sum = func({ in: [{ count: i32 }, { value: i64 }], out: [i64] }, ({ count, value }) => {
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
  const { instance, module: compiled } = await module.instantiate();
  assert(instance instanceof WebAssembly.Instance);
  assert.equal(instance.exports.sum(2, 40n), 42n);
  assert.equal(instance.exports.alias(2, 40n), 42n);
  instance.exports.sum satisfies (count: number, value: bigint) => bigint;
  const nativeExports = Object.getOwnPropertyDescriptor(
    WebAssembly.Instance.prototype,
    "exports",
  )!.get!.call(instance);
  assert.equal(instance.exports, nativeExports);
  const worker = (await WebAssembly.instantiate(compiled, module.importMap)) as typeof instance;
  assert.equal(worker.exports.sum(2, 40n), 42n);
  const payloads = WebAssembly.Module.customSections(compiled, "name");
  assert.equal(payloads.length, 1);
  assert.deepEqual(NameSection.fromBytes(new Uint8Array(payloads[0])), expected);
  const recovered = Module.fromBytes<{ sum: typeof sum; alias: typeof sum }>(
    module.toBytes(),
    module.importMap,
  );
  assert.deepEqual(recovered.toBytes(), module.toBytes());
  const restored = await recovered.instantiate();
  assert.equal(restored.instance.exports.sum(2, 40n), 42n);
  const wabt = await wabtFactory();
  const wat = wabt.readWasm(module.toBytes(), { readDebugNames: true });
  try {
    const text = wat.toText({});
    for (const name of [
      "arithmetic",
      "sum",
      "helper",
      "count",
      "value",
      "first",
      "second",
      "fraction",
      "scratch",
    ]) {
      assert(text.includes(`$${name}`));
    }
  } finally {
    wat.destroy();
  }
});

test("explicit metadata overrides individual inferred names without mutating functions", () => {
  const add = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => i32.add(x, y));
  const one = Module({
    name: "one",
    exports: { add },
    names: {
      functions: { 0: "sum" },
      locals: { 0: { 1: "right" } },
    },
  });
  assert.deepEqual(one.module.names, {
    module: "one",
    functions: { 0: "sum" },
    locals: { 0: { 0: "x", 1: "right" } },
  });
  const two = Module({ exports: { other: add } });
  assert.deepEqual(two.module.names, {
    functions: { 0: "other" },
    locals: { 0: { 0: "x", 1: "y" } },
  });
});

test("local arrays retain their groups and names across type-based reordering", async () => {
  const dynamicLength: number = 2;
  const grouped = func(
    {
      in: [{ value: i32 }],
      locals: {
        head: i32,
        Y: localArray(i64, 2),
        floats: localArray(f64, 2),
        tail: i64,
        empty: localArray(v128, 0),
        dynamic: localArray(i32, dynamicLength),
      },
      out: [i64],
    },
    ({ value }, { head, Y, floats, tail, empty, dynamic }) => {
      assert.deepEqual([head.index, ...dynamic.map((x) => x.index)], [1, 2, 3]);
      assert.deepEqual([...Y.map((x) => x.index), tail.index], [4, 5, 6]);
      assert.deepEqual(
        floats.map((x) => x.index),
        [7, 8],
      );
      assert.deepEqual(empty, []);
      local.set(head, value);
      local.set(dynamic[0], head);
      local.set(dynamic[1], 2);
      local.set(Y[0], i64.extend_i32_u(dynamic[0]));
      local.set(Y[1], i64.extend_i32_u(dynamic[1]));
      local.set(floats[0], 1.5);
      local.set(floats[1], 2.5);
      local.set(tail, i64.add(Y[0], Y[1]));
      local.get(tail);
    },
  );
  const module = Module({ exports: { grouped } });
  const names = {
    0: "value",
    1: "head",
    2: "dynamic[0]",
    3: "dynamic[1]",
    4: "Y[0]",
    5: "Y[1]",
    6: "tail",
    7: "floats[0]",
    8: "floats[1]",
  };
  assert.deepEqual(module.module.names?.locals, { 0: names });
  assert.deepEqual(Module.fromBytes(module.toBytes()).module.names?.locals, { 0: names });
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.grouped(40), 42n);
});

test("named imports and exports support empty parameters and multiple results", async () => {
  const callback = (small: number, large: bigint): [number, bigint] => [small, large];
  const pair = importFunc({ in: [{ small: i32 }, { large: i64 }], out: [i32, i64] }, callback);
  assert.equal(pair.value, callback);
  const nothing = func({ in: [], out: [] }, () => {});
  const constant = func({ in: [], out: [i64] }, () => i64.const(42n));
  const { instance } = await Module({ exports: { pair, nothing, constant } }).instantiate();
  assert.deepEqual(instance.exports.pair(2, 40n), [2, 40n]);
  assert.equal(instance.exports.nothing(), undefined);
  assert.equal(instance.exports.constant(), 42n);
});

test("named callbacks supply internal names, and stack calls still work", async () => {
  const helper = func({ in: [{ value: i32 }], out: [i32] }, function increment({ value }) {
    i32.add(value, 1);
  });
  const entry = func({ in: [{ value: i32 }], out: [i32] }, ({ value }) => {
    local.get(value);
    call(helper);
  });
  const module = Module({ exports: { entry } });
  assert.deepEqual(module.module.names?.functions, { 0: "entry", 1: "increment" });
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.entry(41), 42);
});

test("exported globals, tables and memories receive names and retain native identity", async () => {
  const module = Module({
    name: "entities",
    exports: {
      counter: global(constant(() => i32.const(42))),
      memory: memory({ min: 1 }),
      table: table({ type: funcref, min: 0 }),
    },
  });
  assert.deepEqual(module.module.names, {
    module: "entities",
    globals: { 0: "counter" },
    memories: { 0: "memory" },
    tables: { 0: "table" },
  });
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.counter.value, 42);
  assert.equal(instance.exports.memory.buffer.byteLength, 65536);
  assert.equal(instance.exports.table.length, 0);
});

test("native parameter order follows the declaration, including numeric keys", async () => {
  const ordered = func({ in: [{ last: i32 }, { 2: i32 }, { 1: i64 }], out: [i64] }, (args) => {
    i64.add(args[1], i64.extend_i32_u(i32.sub(args[2], args.last)));
  });
  assert.deepEqual(ordered.params.names, ["last", "2", "1"]);
  const { instance } = await Module({ exports: { ordered } }).instantiate();
  assert.equal(instance.exports.ordered(3, 5, 40n), 42n);
  instance.exports.ordered satisfies (last: number, two: number, one: bigint) => bigint;
});

test("parameter metadata supports names that require escaping", async () => {
  const key = 'left"\\\n🍚';
  const identity = importFunc({ in: [{ [key]: i64 }], out: [i64] }, (value) => value);
  const { instance } = await Module({ exports: { identity } }).instantiate();
  assert.equal(instance.exports.identity(42n), 42n);
});

test("parameter declarations require one unique name per entry and local arrays require valid lengths", () => {
  // @ts-expect-error runtime checks also cover declarations from untyped JS
  assert.throws(() => func({ in: [{ x: i32, y: i64 }], out: [] }, () => {}), /exactly one name/);
  // @ts-expect-error empty parameter entry
  assert.throws(() => func({ in: [{}], out: [] }, () => {}), /exactly one name/);
  // @ts-expect-error duplicate parameter name
  assert.throws(() => func({ in: [{ x: i32 }, { x: i64 }], out: [] }, () => {}), /duplicate name/);
  // @ts-expect-error declarations validate names before their bodies are defined
  assert.throws(() => declareFunc({ in: [{ x: i32, y: i64 }], out: [] }), /exactly one name/);
  assert.throws(
    // @ts-expect-error imports validate duplicate names too
    () => importFunc({ in: [{ x: i32 }, { x: i64 }], out: [] }, () => {}),
    /duplicate name/,
  );
  for (const length of [-1, 0.5, Infinity]) {
    assert.throws(() => localArray(i64, length), /non-negative integer/);
  }
});

test("modules without parameter names retain native calls", async () => {
  const identity = func({ in: [{ value: i32 }], out: [i32] }, ({ value }) => local.get(value));
  const module = Module({ exports: { identity } });
  delete module.module.names;
  const recovered = Module.fromBytes<{ identity: typeof identity }>(module.toBytes());
  const { instance } = await recovered.instantiate();
  instance.exports.identity satisfies (value: number) => number;
  assert.equal(instance.exports.identity(42), 42);
});
