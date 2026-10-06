import assert from "node:assert/strict";
import test from "node:test";
import { F32, F64 } from "../text/float.ts";
import { UnsupportedTextError } from "../text/lexer.ts";

test("finite float text rounds decimal and hex exactly once", () => {
  assert.equal(F32.fromText("1.000000059604644775390625"), 1);
  assert.equal(F32.fromText("1.0000000596046447753906250000000001"), 1 + 2 ** -23);
  assert.equal(F32.fromText("1.0000000596046447753906249999999999"), 1);
  assert.equal(F32.fromText("0x1.000001p0"), 1);
  assert.equal(F32.fromText("0x1.000003p0"), 1 + 2 ** -22);
  assert.equal(F64.fromText("0x1.00000000000008p0"), 1);
  assert.equal(F64.fromText("0x1.000000000000081p0"), 1 + 2 ** -52);
  assert.equal(F64.fromText("0x1.2p+1"), 2.25);
  assert.equal(F64.fromText("1_2.5_0e-1"), 1.25);
  assert.equal(F64.fromText("0x1_0.8p-1"), 8.25);
});

test("subnormal values, signed zero, infinities and overflow obey the target width", () => {
  assert.equal(F32.fromText("0x1p-149"), 2 ** -149);
  assert.equal(F32.fromText("0x1p-150"), 0);
  assert.equal(F32.fromText("0x1.000001p-150"), 2 ** -149);
  assert.equal(F64.fromText("0x1p-1074"), Number.MIN_VALUE);
  assert.equal(F64.fromText("0x1p-1075"), 0);
  assert.equal(F32.fromText("0x1.fffffep127"), Math.fround(3.4028234663852886e38));
  assert.equal(F64.fromText("0x1.fffffffffffffp1023"), Number.MAX_VALUE);
  for (const codec of [F32, F64]) {
    assert.ok(Object.is(codec.fromText("-0"), -0));
    assert.ok(Object.is(codec.fromText("-1e-9999999999999999999999"), -0));
    assert.equal(codec.fromText("inf"), Infinity);
    assert.equal(codec.fromText("-inf"), -Infinity);
    assert.throws(() => codec.fromText("1e9999999999999999999999"), /overflows/);
    for (const source of ["i_nf", "0x1__0", "1e_2"]) assert.throws(() => codec.fromText(source));
    assert.throws(() => codec.fromText("nan:0x1"), UnsupportedTextError);
  }
  assert.throws(() => F32.fromText("0x1.ffffffp127"), /overflows/);
  assert.throws(() => F64.fromText("0x1.fffffffffffff8p1023"), /overflows/);
});
