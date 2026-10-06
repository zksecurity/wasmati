import assert from "node:assert/strict";
import test from "node:test";
import { Module, func, i32, memory, data, Const } from "../index.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { decompileModule } from "../decompile.ts";
import { buildTextModule } from "./text-helpers.ts";

test("instructions and segments name one of several memories", async () => {
  const small = memory({ min: 1 });
  const large = memory({ min: 2 });
  data({ memory: large, offset: Const.i32(0) }, [7]);
  const copy = func({ in: [], out: [i32] }, () => {
    i32.const(0);
    i32.const(0);
    i32.const(1);
    memory.copy(small, large);
    i32.load8_u({ memory: small }, 0);
    memory.size(large);
    i32.add();
  });
  const module = Module({ exports: { copy }, dependencies: [small, large] });
  assert.equal(module.module.memories.length, 2);
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.copy(), 9);
});

test("with several memories, the default memory is ambiguous", () => {
  const load = func({ in: [], out: [i32] }, () => i32.load({}, 0));
  assert.throws(
    () => Module({ exports: { load }, dependencies: [memory({ min: 1 }), memory({ min: 1 })] }),
    /must name their memory/,
  );
});

test("memory indices roundtrip through binary, text and decompiled builders", async () => {
  const parsed = parseWat(`(module
    (memory $a 1) (memory $b 1)
    (data (memory $b) (i32.const 8) "\\2a")
    (func (export "f") (result i32)
      (i32.store8 $a (i32.const 0) (i32.load8_u $b offset=8 (i32.const 0)))
      (i32.load8_u $a (i32.const 0))))`);
  const load = parsed.funcs[0].body.find((i) => i.name === "i32.load8_u");
  assert.deepEqual(load?.immediate, { offset: 8, align: 0, memory: 1 });
  const bytes = BinaryModule.toBytes(parsed);
  assert.deepEqual(BinaryModule.toBytes(BinaryModule.fromBytes(bytes)), bytes);
  assert.deepEqual(BinaryModule.fromBytes(bytes).funcs, parsed.funcs);
  assert.match(printWat(parsed), /i32\.load8_u \$b offset=8/);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  assert.match(decompileModule(parsed), /i32\.load8_u\(\{ memory: b, offset: 8, align: 1 \}\)/);
  const { instance } = await (await buildTextModule(parsed)).instantiate();
  assert.equal((instance.exports.f as Function)(), 42);
});
