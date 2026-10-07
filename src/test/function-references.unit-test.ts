import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  i32,
  local,
  ref,
  refType,
  funcref,
  global,
  table,
  Const,
  elem,
  block,
  call_ref,
  return_call,
  return_call_ref,
  br_on_null,
  br_on_non_null,
  control,
} from "../index.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { buildTextModule } from "./text-helpers.ts";

const unary = { in: [i32], out: [i32] };

test("typed function references are called with call_ref and tail calls", async () => {
  const double = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => i32.add(x, x));
  const apply = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
    local.get(x);
    ref.func(double);
    call_ref(unary);
  });
  const tail = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
    local.get(x);
    return_call(double);
  });
  const tailRef = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
    local.get(x);
    ref.func(double);
    return_call_ref(unary);
  });
  // Functions referenced in code must be declared, here by a declarative segment.
  const declared = elem({ type: funcref, mode: "declarative" }, [Const.refFunc(double)]);
  const module = Module({ exports: { apply, tail, tailRef }, dependencies: [declared] });
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.apply(4), 8);
  assert.equal(instance.exports.tail(5), 10);
  assert.equal(instance.exports.tailRef(6), 12);
  assert.throws(() => func({ in: [], out: [] }, () => return_call(double)), /results must match/);
});

test("null checks narrow nullable references", async () => {
  const nullable = refType(unary, { nullable: true });
  const one = func({ in: [{ x: i32 }], out: [i32] }, () => i32.const(1));
  const g = global(Const.refFunc(one), { mutable: true, type: nullable });
  const callOrZero = func({ in: [], out: [i32] }, () => {
    block({ out: [] }, (empty) => {
      i32.const(7);
      global.get(g);
      br_on_null(empty);
      call_ref(unary);
      control.return();
    });
    i32.const(0);
  });
  const isSet = func({ in: [], out: [i32] }, () => {
    block({ out: [refType(unary)] }, (set) => {
      global.get(g);
      br_on_non_null(set);
      i32.const(0);
      control.return();
    });
    ref.as_non_null();
    ref.is_null();
    i32.eqz();
  });
  const clear = func({ in: [], out: [] }, () => global.set(g, ref.null(nullable)));
  const { instance } = await Module({ exports: { callOrZero, isSet, clear } }).instantiate();
  assert.equal(instance.exports.callOrZero(), 1);
  assert.equal(instance.exports.isSet(), 1);
  instance.exports.clear();
  assert.equal(instance.exports.callOrZero(), 0);
  assert.equal(instance.exports.isSet(), 0);
  // Function references default to funcref globals, and declared types must fit.
  assert.equal(global(Const.refFunc(one)).type.value, "funcref");
  assert.throws(() => global(Const.refNull(funcref), { type: refType(unary) }), /does not fit/);
});

test("tables may hold typed references and initialize them", async () => {
  const seven = func({ in: [{ x: i32 }], out: [i32] }, () => i32.const(7));
  const t = table({ type: refType(unary), min: 2, init: Const.refFunc(seven) });
  const call = func({ in: [{ i: i32 }], out: [i32] }, ({ i }) => {
    i32.const(0);
    local.get(i);
    table.get(t);
    call_ref(unary);
  });
  const module = Module({ exports: { call } });
  assert.deepEqual(module.module.tables[0].type, { ref: 0, nullable: false });
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.call(1), 7);
});

test("typed references roundtrip through text, binary and decompiled builders", async () => {
  const parsed = parseWat(`(module
    (type $f (func (param i32) (result i32)))
    (type $g (func (param (ref null $f)) (result (ref $f))))
    (table $t 1 (ref $f) (ref.func $inc))
    (global $h (mut (ref null $f)) (ref.null $f))
    (func $inc (type $f) (i32.add (local.get 0) (i32.const 1)))
    (func $force (type $g) (ref.as_non_null (local.get 0)))
    (func (export "run") (result i32)
      (local $r (ref null $f))
      (local.set $r (call $force (table.get $t (i32.const 0))))
      (return_call_ref $f (i32.const 41) (local.get $r))))`);
  assert.deepEqual(parsed.types[1].args, [{ ref: 0, nullable: true }]);
  assert.deepEqual(parsed.tables[0].init, [{ name: "ref.func", immediate: 0 }]);
  assert.match(
    printWat(parsed),
    /\(type \$g \(func \(param \(ref null \$f\)\) \(result \(ref \$f\)\)\)\)/,
  );
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  const bytes = BinaryModule.toBytes(parsed);
  assert.deepEqual(BinaryModule.toBytes(BinaryModule.fromBytes(bytes)), bytes);
  assert.match(
    decompileModule(parsed),
    /refType\(\{ in: \[i32\], out: \[i32\] \}, \{ nullable: true \}\)/,
  );
  const { instance } = await (await buildTextModule(parsed)).instantiate();
  assert.equal((instance.exports.run as Function)(), 42);
});
