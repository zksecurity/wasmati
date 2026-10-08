import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  i32,
  funcref,
  importFunc,
  importGlobal,
  importMemory,
  importTable,
} from "../index.ts";

test("optional import paths retain automatic defaults and link all import kinds", async () => {
  const first = importFunc({ module: "env", in: [{ x: i32 }], out: [i32] }, (x) => x + 1);
  const second = importFunc({ field: "double", in: [{ x: i32 }], out: [i32] }, (x) => x * 2);
  const counter = new WebAssembly.Global({ value: "i32", mutable: true }, 10);
  const global = importGlobal(i32, counter, { mutable: true, module: "state", field: "counter" });
  const memory = importMemory({ min: 1, module: "state" });
  const table = importTable(
    { type: funcref, min: 1, field: "table" },
    new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
  );
  const module = Module({ exports: { first, second, global, memory, table } });
  assert.deepEqual(
    module.toObject().imports.map(({ module, name }) => [module, name]),
    [
      ["env", "f0"],
      ["", "double"],
      ["state", "counter"],
      ["", "table"],
      ["state", "m0"],
    ],
  );
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.first(5), 6);
  assert.equal(instance.exports.second(5), 10);
  assert.equal(instance.exports.global, counter);
  assert.equal(instance.exports.memory, memory.value);
  assert.equal(instance.exports.table, table.value);
});

test("explicit empty import fields override generated names", async () => {
  const empty = importFunc({ module: "", field: "", in: [], out: [i32] }, () => 42);
  const module = Module({ exports: { empty } });
  assert.equal(module.toObject().imports[0].name, "");
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.empty(), 42);
});
