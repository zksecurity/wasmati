import assert from "node:assert/strict";
import test from "node:test";
import { Wast } from "../text/script.ts";
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

test("script parsing and printing retain command semantics", async () => {
  const commands = Wast.fromText(source);
  const printed = Wast.toText(commands);
  assert.deepEqual(await runWast(printed), { passed: 10, failures: [] });
});

test("negative assertions cannot pass on unsupported parsing or decompilation", async () => {
  const result = await runWast(`
    (assert_invalid (module (func v128.const i32x4 0 0 0 0)) "type mismatch")
    (assert_malformed (module (tag (param i32))) "unexpected token")
    (assert_invalid (module (func call 99)) "unknown function")
    (assert_malformed (module quote "(func)") "unexpected token")
    (assert_malformed (module (type (struct))) "unexpected token")
    (assert_malformed (module (func (param (ref null func)))) "unexpected token")
    (assert_malformed (module (memory i64 1)) "unexpected token")`);
  assert.equal(result.passed, 0);
  assert.deepEqual(
    result.failures.map((failure) => failure.command),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test("missing modules, incorrect results and incorrect traps count as failures", async () => {
  const result = await runWast(`(module (func (export "id") (param i32) (result i32) local.get 0))
    (assert_return (invoke "id" (i32.const 1)) (i32.const 2))
    (assert_trap (invoke "missing") "unreachable")
    (assert_return (invoke $missing "id" (i32.const 1)) (i32.const 1))
    (assert_trap (invoke "id" (i32.const 1)) "unreachable")`);
  assert.equal(result.passed, 1);
  assert.equal(result.failures.length, 4);
});
