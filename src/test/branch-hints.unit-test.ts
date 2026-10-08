import assert from "node:assert/strict";
import test from "node:test";
import { Module, func, i32, local, block, loop, br_if, control } from "../index.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule } from "../module-binable.ts";

const countdown = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  block((done) =>
    loop((next) => {
      i32.eqz(x);
      br_if(done, { likely: false });
      local.set(x, i32.sub(x, 1));
      i32.const(1);
      br_if(next, { likely: true });
    }),
  );
  local.get(x);
  control.if(
    { out: [i32], likely: false },
    () => i32.const(1),
    () => i32.const(2),
  );
});

function hints(body: { name: string; immediate: any; likely?: boolean }[]): [string, boolean][] {
  return body.flatMap((instruction) => {
    const { name, immediate, likely } = instruction;
    const own: [string, boolean][] = likely === undefined ? [] : [[name, likely]];
    const nested = immediate?.instructions;
    const inner =
      nested === undefined
        ? []
        : Array.isArray(nested)
          ? nested
          : [...nested.if, ...(nested.else ?? [])];
    return [...hints(inner), ...own];
  });
}

test("branch hints on if and br_if roundtrip through the code metadata section", async () => {
  const module = Module({ exports: { countdown } });
  const expected = [
    ["br_if", false],
    ["br_if", true],
    ["if", false],
  ];
  assert.deepEqual(hints(module.toObject().funcs[0].body), expected);
  const decoded = BinaryModule.fromBytes(module.toBytes());
  assert.deepEqual(hints(decoded.funcs[0].body), expected);
  assert.equal(decoded.customSections, undefined);
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.countdown(3), 2);
});

test("branch hints print as annotations, and decompile to likely options", () => {
  const module = Module({ exports: { countdown } }).toObject();
  const text = printWat(module);
  assert.match(text, /\(@metadata\.code\.branch_hint "\\00"\) br_if 1/);
  assert.match(text, /\(@metadata\.code\.branch_hint "\\00"\) if \(result i32\)/);
  assert.equal(printWat(parseWat(text)), text);
  const source = decompileModule(module);
  assert.match(source, /br_if\(1, \{ likely: false \}\)/);
  assert.match(source, /control\.if\(\{ out: \[i32\], likely: false \}, \(\) => \{/);
  assert.throws(
    () => decompileModule(parseWat(`(module (func (@metadata.code.branch_hint "\\01") nop))`)),
    /branch hint on nop/,
  );
  assert.throws(
    () => parseWat(`(module (func (@metadata.code.branch_hint "\\02") (if (i32.const 0) (then))))`),
    /malformed hint/,
  );
});
