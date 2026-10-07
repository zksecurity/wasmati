import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  i32,
  i64,
  memory,
  table,
  funcref,
  call_indirect,
  Const,
  elem,
  $,
} from "../index.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { buildTextModule } from "./text-helpers.ts";

test("instructions on a 64-bit memory take 64-bit addresses and sizes", async () => {
  const mem = memory({ min: 1, address: "i64" });
  const roundtrip = func(
    { in: [{ address: i64 }, { value: i32 }], out: [i32] },
    ({ address, value }) => {
      i32.store({ memory: mem }, address, value);
      i32.load({ memory: mem, offset: 4 }, i64.sub(address, 4n));
    },
  );
  const grow = func({ in: [], out: [i64] }, () => {
    i64.const(1n);
    memory.grow(mem);
    memory.size(mem);
    i64.add();
  });
  const { instance } = await Module({ exports: { roundtrip, grow, mem } }).instantiate();
  assert.equal(instance.exports.roundtrip(8n, 42), 42);
  assert.equal(instance.exports.grow(), 3n);
  assert.throws(
    () =>
      func({ in: [{ address: i32 }], out: [i32] }, ({ address }) =>
        i32.load({ memory: mem }, address),
      ),
    /expected type i64/i,
  );
});

test("a 64-bit memory must be named by its instructions", () => {
  const mem = memory({ min: 1, address: "i64" });
  const load = func({ in: [], out: [i32] }, () => i32.load({}, 0));
  assert.throws(() => Module({ exports: { load }, memory: mem }), /need a 32-bit memory/);
});

test("64-bit tables index with i64, including call_indirect and segment offsets", async () => {
  const t = table({ type: funcref, min: 2, address: "i64" });
  const answer = func({ in: [], out: [i32] }, () => i32.const(42));
  elem({ type: funcref, mode: { table: t, offset: Const.i64(1) } }, [Const.refFunc(answer)]);
  const call = func({ in: [], out: [i32] }, () => {
    i64.const(1n);
    call_indirect(t, { in: [], out: [i32] });
  });
  const size = func({ in: [], out: [i64] }, () => table.size(t));
  const { instance } = await Module({ exports: { call, size } }).instantiate();
  assert.equal(instance.exports.call(), 42);
  assert.equal(instance.exports.size(), 2n);
});

test("64-bit address types roundtrip through text and decompiled builders", async () => {
  const parsed = parseWat(`(module
    (memory $m (export "m") i64 1 2)
    (table i64 funcref (elem $f))
    (func $f (export "f") (param i64) (result i64)
      (i64.store offset=8 (local.get 0) (memory.size))
      (i64.load offset=8 (local.get 0))))`);
  assert.equal(parsed.memory?.limits.address, "i64");
  assert.match(printWat(parsed), /\(memory \$m i64 1 2\)/);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  const { instance } = await (await buildTextModule(parsed)).instantiate();
  assert.equal((instance.exports.f as Function)(0n), 1n);
});

test("sizes and offsets beyond 2^53 are exact bigints, and numbers otherwise", async () => {
  const max = 2n ** 64n - 1n;
  const parsed = parseWat(`(module
    (table (export "t") i64 1 0xffff_ffff_ffff_ffff funcref)
    (memory i64 1)
    (func (export "load") (param i64) (result i32) (i32.load offset=0xffff_ffff_ffff_ffff (local.get 0))))`);
  assert.deepEqual(parsed.tables[0].limits, { min: 1, max, shared: false, address: "i64" });
  assert.equal(parsed.funcs[0].body[1].immediate.offset, max);
  assert.match(printWat(parsed), /offset=18446744073709551615/);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  const bytes = BinaryModule.toBytes(parsed);
  assert.deepEqual(BinaryModule.fromBytes(bytes).tables, parsed.tables);
  assert.deepEqual(table({ type: funcref, min: 1n, max: 2n, address: "i64" }).type.limits.min, 1);
  const { instance } = await (await buildTextModule(parsed)).instantiate();
  assert.throws(() => (instance.exports.load as Function)(0n), /out of bounds/);
});

test("sizes have the address type of their memory or table, i32 by default", async () => {
  const size32 = func({ in: [], out: [i32] }, () => i32.add(memory.size(), 1));
  const memory32 = Module({ exports: { size32 }, memory: memory({ min: 2 }) });
  assert.equal((await memory32.instantiate()).instance.exports.size32(), 3);

  const mem64 = memory({ min: 1, address: "i64" });
  const table64 = table({ type: funcref, min: 2, address: "i64" });
  const sizes64 = func({ in: [], out: [i64, i64] }, () => {
    i64.add(memory.size(mem64), 1n);
    i64.add(table.size(table64), 1n);
  });
  const { instance } = await Module({ exports: { sizes64 } }).instantiate();
  assert.deepEqual(instance.exports.sizes64(), [2n, 3n]);
});
