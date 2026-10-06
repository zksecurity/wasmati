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
  assert.equal(parsed.memories[0].limits.address, "i64");
  assert.match(printWat(parsed), /\(memory \$m i64 1 2\)/);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  const { instance } = await (await buildTextModule(parsed)).instantiate();
  assert.equal((instance.exports.f as Function)(0n), 1n);
});
