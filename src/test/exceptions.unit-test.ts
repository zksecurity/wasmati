import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  i32,
  local,
  tag,
  importTag,
  block,
  try_table,
  throw_,
  throw_ref,
  exnref,
  control,
} from "../index.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { buildTextModule } from "./text-helpers.ts";

test("tags throw values that try_table catches into enclosing blocks", async () => {
  const error = tag({ in: [i32] });
  const safeDivide = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => {
    block({ out: [i32] }, (caught) => {
      try_table({ out: [i32] }, [{ tag: error, label: caught }], () => {
        local.get(y);
        i32.eqz();
        control.if({}, () => {
          i32.const(-1);
          throw_(error);
        });
        i32.div_s(x, y);
      });
      control.return();
    });
  });
  const { instance } = await Module({ exports: { safeDivide, error } }).instantiate();
  assert.equal(instance.exports.safeDivide(7, 2), 3);
  assert.equal(instance.exports.safeDivide(7, 0), -1);
  assert.ok(instance.exports.error instanceof WebAssembly.Tag);
});

test("caught exceptions can be rethrown by reference, and escape to JS", async () => {
  const error = importTag({ in: [i32] });
  const rethrow = func({ in: [], out: [] }, () => {
    block({ out: [exnref] }, (caught) => {
      try_table({}, [{ ref: true, label: caught }], () => {
        i32.const(42);
        throw_(error);
      });
      control.return();
    });
    throw_ref();
  });
  const { instance } = await Module({ exports: { rethrow } }).instantiate();
  try {
    instance.exports.rethrow();
    assert.fail("expected an exception");
  } catch (exception) {
    assert.ok(exception instanceof WebAssembly.Exception);
    assert.equal(exception.getArg(error.value, 0), 42);
  }
  assert.throws(
    () =>
      func({ in: [], out: [] }, () =>
        block({ out: [i32] }, (label) => try_table({}, [{ label }], () => {})),
      ),
    /catch clause provides \[\], label expects \[i32\]/,
  );
});

test("tags and try_table roundtrip through text, binary and decompiled builders", async () => {
  const parsed = parseWat(`(module
    (tag $e (export "e") (param i32 i64))
    (func (export "run") (result i32)
      (block $h (result i32 i64)
        (try_table (catch $e $h) (throw $e (i32.const 5) (i64.const 6)))
        (unreachable))
      drop))`);
  assert.deepEqual(parsed.tags, [0]);
  assert.match(printWat(parsed), /try_table \(catch \$e 0\)/);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  const bytes = BinaryModule.toBytes(parsed);
  assert.deepEqual(BinaryModule.toBytes(BinaryModule.fromBytes(bytes)), bytes);
  assert.match(
    decompileModule(parsed),
    /try_table\(\{ in: \[\], out: \[\] \}, \[\{ tag: e, label: 0 \}\]/,
  );
  const { instance } = await (await buildTextModule(parsed)).instantiate();
  assert.equal((instance.exports.run as Function)(), 5);
});
