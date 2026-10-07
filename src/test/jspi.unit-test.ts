import assert from "node:assert/strict";
import test from "node:test";
import { Module, func, declareFunc, i32, importFunc, call } from "../index.ts";

test("promising exports suspend on suspending imports until their promises resolve", async () => {
  const log: string[] = [];
  const slowDouble = importFunc({ in: [{ x: i32 }], out: [i32], suspending: true }, async (x) => {
    log.push(`start ${x}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    log.push(`end ${x}`);
    return 2 * x;
  });
  const run = func({ in: [{ x: i32 }], out: [i32], promising: true }, ({ x }) => {
    i32.add(call(slowDouble, { x }), 1);
  });
  const later = declareFunc({ in: [], out: [i32], promising: true });
  later.define(() => call(slowDouble, { x: 1 }));
  const sync = func({ in: [], out: [i32] }, () => call(slowDouble, { x: 0 }));
  const { instance } = await Module({ exports: { run, later, sync } }).instantiate();
  const result: Promise<number> = instance.exports.run(20);
  log.push("returned");
  assert.equal(await result, 41);
  assert.equal(await instance.exports.later(), 2);
  assert.deepEqual(log, ["start 20", "returned", "end 20", "start 1", "end 1"]);
  assert.ok(instance instanceof WebAssembly.Instance);
  // Without a promising export, Wasm cannot suspend.
  assert.throws(() => instance.exports.sync(), WebAssembly.SuspendError);
});
