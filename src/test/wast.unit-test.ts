import assert from "node:assert/strict";
import test from "node:test";
import { runWast } from "./wast-runner.ts";

const source = `(module $math
  (func (export "sub") (param $x i32) (param $y i32) (result i32) (i32.sub (local.get $x) (local.get $y)))
  (func (export "div") (param i64 i64) (result i64) local.get 0 local.get 1 i64.div_s)
  (func (export "pair") (result i32 i64) i32.const -1 i64.const 9))
  (assert_return (invoke "sub" (i32.const 10) (i32.const 3)) (i32.const 7))
  (assert_return (invoke $math "pair") (i32.const 0xffffffff) (i64.const 9))
  (assert_trap (invoke "div" (i64.const 1) (i64.const 0)) "integer divide by zero")
  (assert_trap (invoke "div" (i64.const -9223372036854775808) (i64.const -1)) "integer overflow")
  (register "math" $math)
  (module (import "math" "sub" (func $sub (param i32 i32) (result i32)))
    (func (export "use") (result i32) (call $sub (i32.const 11) (i32.const 2))))
  (assert_return (invoke "use") (i32.const 9))
  (assert_invalid (module (func (result i32) i64.const 1)) "type mismatch")
  (assert_malformed (module quote "(func (param $x i32 i64))") "unexpected token")`;

test("WAST assertions execute modules generated through the wasmati API", async () => {
  assert.deepEqual(await runWast(source), { passed: 10, failures: [] });
});

test("floats and vectors are compared as bits, with NaN classes and alternatives", async () => {
  const result = await runWast(`(module
    (func (export "id32") (param f32) (result f32) local.get 0)
    (func (export "id64") (param f64) (result f64) local.get 0)
    (func (export "add") (param f32 f32) (result f32) (f32.add (local.get 0) (local.get 1)))
    (func (export "vec") (param v128) (result v128) local.get 0)
    (global (export "g") f64 (f64.const -nan:0x4000000000001)))
    (assert_return (invoke "id32" (f32.const nan:0x200000)) (f32.const nan:0x200000))
    (assert_return (invoke "id32" (f32.const -0x1p-149)) (f32.const -0x1p-149))
    (assert_return (invoke "id64" (f64.const -nan:0x1)) (f64.const -nan:0x1))
    (assert_return (invoke "add" (f32.const nan) (f32.const 1)) (f32.const nan:canonical))
    (assert_return (invoke "add" (f32.const nan:0x200000) (f32.const 1)) (f32.const nan:arithmetic))
    (assert_return (invoke "vec" (v128.const f32x4 nan:0x400001 -0 1 inf))
      (v128.const f32x4 nan:arithmetic -0 1 inf))
    (assert_return (invoke "vec" (v128.const i8x16 -1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 255))
      (v128.const i16x8 0x02ff 0x0403 0x0605 0x0807 0x0a09 0x0c0b 0x0e0d 0xff0f))
    (assert_return (invoke "id32" (f32.const 1)) (either (f32.const 2) (f32.const 1)))
    (assert_return (get "g") (f64.const -nan:0x4000000000001))
    (assert_return (invoke "id32" (f32.const nan:0x200000)) (f32.const nan:0x200001))
    (assert_return (invoke "add" (f32.const nan:0x200000) (f32.const 1)) (f32.const nan:canonical))
    (assert_return (invoke "vec" (v128.const f32x4 0 0 0 1)) (v128.const f32x4 0 0 0 nan:canonical))`);
  assert.equal(result.passed, 10);
  assert.deepEqual(
    result.failures.map((failure) => failure.command),
    [11, 12, 13],
  );
  assert.match(result.failures[0].message, /expected f32 0x7fa00001, got f32 0x7fa00000/);
});

test("references, the spectest host module, and module definitions", async () => {
  const result = await runWast(`(module $host
    (import "spectest" "print_i32" (func (param i32)))
    (func (export "print") (param i32) local.get 0 call 0)
    (func (export "extern") (param externref) (result externref) local.get 0)
    (func (export "null") (result funcref) ref.null func)
    (func $loop (export "loop") call $loop))
    (invoke "print" (i32.const 1))
    (assert_return (invoke "extern" (ref.extern 1)) (ref.extern 1))
    (assert_return (invoke "extern" (ref.extern 1)) (ref.extern))
    (assert_return (invoke "extern" (ref.null extern)) (ref.null))
    (assert_return (invoke "null") (ref.null func))
    (assert_return (invoke "extern" (ref.extern 1)) (ref.extern 2))
    (module definition $counter (func (export "one") (result i32) i32.const 1))
    (module instance $first $counter)
    (assert_return (invoke $first "one") (i32.const 1))
    (assert_unlinkable (module (import "spectest" "missing" (func))) "unknown import")
    (assert_exhaustion (invoke $host "loop") "call stack exhausted")`);
  assert.equal(result.passed, 11);
  assert.deepEqual(
    result.failures.map((failure) => failure.command),
    [7],
  );
});

test("negative assertions cannot pass on unsupported parsing or decompilation", async () => {
  const result = await runWast(`
    (assert_malformed (module (tag (param i32))) "unexpected token")
    (assert_invalid (module (func call 99)) "unknown function")
    (assert_malformed (module quote "(func)") "unexpected token")
    (assert_malformed (module (type (struct))) "unexpected token")
    (assert_malformed (module (func (param (ref null func)))) "unexpected token")`);
  assert.equal(result.passed, 0);
  assert.deepEqual(
    result.failures.map((failure) => failure.command),
    [1, 2, 3, 4, 5],
  );
});

test("missing modules, incorrect results, incorrect traps and earlier failures count as failures", async () => {
  const result = await runWast(`(module (func (export "id") (param i32) (result i32) local.get 0))
    (assert_return (invoke "id" (i32.const 1)) (i32.const 2))
    (assert_trap (invoke "missing") "unreachable")
    (assert_return (invoke $missing "id" (i32.const 1)) (i32.const 1))
    (assert_trap (invoke "id" (i32.const 1)) "unreachable")
    (module (func (export "id") (param i32) (result i32) local.get 0) (tag))
    (assert_return (invoke "id" (i32.const 1)) (i32.const 1))`);
  assert.equal(result.passed, 1);
  assert.equal(result.failures.length, 6);
  assert.match(result.failures[5].message, /no module instance/);
});
