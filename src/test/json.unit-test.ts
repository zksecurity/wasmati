import assert from "node:assert/strict";
import test from "node:test";
import { Module, data, f32, f64, func, i64, memory } from "../index.ts";

test("modules are JSON, with tagged bigints, bytes and numbers that JSON can't hold", async () => {
  const mem = memory({ min: 1 });
  data({ memory: mem, offset: 0 }, [0, 1, 0xff]);
  const constants = func({ in: [], out: [i64, f64, f64, f32] }, () => {
    i64.const(-(2n ** 63n));
    f64.const(-Infinity);
    f64.const(-0);
    f32.const({ bits: 0x7fa00001 });
  });
  const module = Module({
    exports: { constants, mem },
    customSections: [{ name: "extra", data: new Uint8Array([0xab, 0xcd]) }],
  });
  const text = JSON.stringify(module);
  for (const tagged of [
    '{"$bigint":"-9223372036854775808"}',
    '{"$number":"-Infinity"}',
    '{"$number":"-0"}',
    '{"$bytes":"0001ff"}',
    '{"$bytes":"abcd"}',
  ])
    assert.ok(text.includes(tagged), tagged);
  const recovered = Module.fromJSON<{ constants: typeof constants }>(JSON.parse(text));
  assert.deepEqual(recovered.toBytes(), module.toBytes());
  const { instance } = await recovered.instantiate();
  const [x, y, z] = instance.exports.constants();
  assert.equal(x, -(2n ** 63n));
  assert.equal(y, -Infinity);
  assert.ok(Object.is(z, -0));
});
