import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  i32,
  importFunc,
  call,
  call_indirect,
  async,
  table,
  funcref,
  elem,
  control,
  drop,
} from "../index.ts";

test("async exports wait for async imports, and return promises", async () => {
  const log: string[] = [];
  const slowDouble = importFunc({ in: [{ x: i32 }], out: [i32], async: true }, async (x) => {
    log.push(`start ${x}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    log.push(`end ${x}`);
    return 2 * x;
  });
  // Internal functions on the way are ordinary synchronous functions.
  const step = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
    i32.add(call(slowDouble, { x }), 1);
  });
  const run = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => call(step, { x }));
  const { instance } = await Module({
    exports: { run: async(run), step: async(step) },
  }).instantiate();
  const result: Promise<number> = instance.exports.run(20);
  log.push("returned");
  assert.equal(await result, 41);
  assert.equal(await instance.exports.step(1), 3);
  assert.deepEqual(log, ["start 20", "returned", "end 20", "start 1", "end 1"]);
  assert.ok(instance instanceof WebAssembly.Instance);
});

test("exports and start functions that reach async imports by direct calls must be async", async () => {
  const fetchValue = importFunc(
    { name: "fetchValue", in: [], out: [i32], async: true },
    async () => 1,
  );
  const parse = func({ name: "parse", in: [], out: [i32] }, () => call(fetchValue));
  const run = func({ name: "run", in: [], out: [i32] }, () => {
    i32.const(0);
    control.if(
      { out: [i32] },
      () => call(parse),
      () => i32.const(0),
    );
  });
  assert.throws(
    () => Module({ exports: { run } }),
    /export "run" reaches async import "fetchValue" via "parse"; export it as async/,
  );
  const init = func({ in: [], out: [] }, () => {
    call(parse);
    drop();
  });
  assert.throws(() => Module({ exports: {}, start: init }), /the start function reaches/);
  Module({ exports: { run: async(run) } });

  // Indirect calls are not followed, and fail when they would suspend.
  const t = table({ type: funcref, min: 1 });
  elem({ type: funcref, mode: { table: t, offset: 0 } }, [parse]);
  const indirect = func({ in: [], out: [i32] }, () => {
    i32.const(0);
    call_indirect(t, { in: [], out: [i32] });
  });
  const { instance } = await Module({ exports: { indirect } }).instantiate();
  assert.throws(() => instance.exports.indirect(), WebAssembly.SuspendError);
});
