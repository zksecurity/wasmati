import assert from "node:assert/strict";
import test from "node:test";
import { parseFloat, parseInteger, parseU32, printFloat } from "../text/numbers.ts";

const F32 = {
  fromText: (text: string) => parseFloat(text, 32),
  toText: (value: Parameters<typeof printFloat>[0]) => printFloat(value, 32),
};
const F64 = {
  fromText: (text: string) => parseFloat(text, 64),
  toText: (value: Parameters<typeof printFloat>[0]) => printFloat(value, 64),
};

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
  }
  assert.throws(() => F32.fromText("0x1.ffffffp127"), /overflows/);
  assert.throws(() => F64.fromText("0x1.fffffffffffff8p1023"), /overflows/);
});

test("NaN literals keep exact sign and payload bits, including signaling NaNs", () => {
  assert.deepEqual(F32.fromText("nan"), { bits: 0x7fc00000 });
  assert.deepEqual(F32.fromText("-nan:0x20_0000"), { bits: 0xffa00000 });
  assert.deepEqual(F32.fromText("+nan:0x1"), { bits: 0x7f800001 });
  assert.deepEqual(F64.fromText("nan:0x4000000000001"), { bits: 0x7ff4000000000001n });
  assert.deepEqual(F64.fromText("-nan"), { bits: 0xfff8000000000000n });
  for (const source of ["nan:0x0", "nan:0x800000", "nan:1", "nan:0x"])
    assert.throws(() => F32.fromText(source), /NaN/);
  assert.throws(() => F64.fromText("nan:0x10000000000000"), /NaN/);
  for (const source of ["nan", "-nan", "nan:0x200000", "-nan:0x1"])
    assert.equal(F32.toText(F32.fromText(source)), source);
  assert.equal(F64.toText({ bits: 0x7ff4000000000001n }), "nan:0x4000000000001");
  assert.equal(F32.toText(NaN), "nan");
  assert.equal(F32.toText({ bits: 0x3fc00000 }), "1.5");
});

test("f32 values print as the shortest decimal that parses back to them", () => {
  for (const [value, text] of [
    [0.1, "0.1"],
    [Math.fround(0.1), "0.1"],
    [Math.fround(3.4028234663852886e38), "3.4028235e+38"],
    [2 ** -149, "1e-45"],
    [-1.5, "-1.5"],
  ] as const) {
    const f32 = Math.fround(value);
    assert.equal(F32.toText(f32), text);
    assert.equal(F32.fromText(F32.toText(f32)), f32);
  }
  assert.equal(F64.toText(0.1), "0.1");
});

test("integer literals check signs, separators and ranges", () => {
  assert.equal(parseU32("0xff_ff"), 65535);
  assert.equal(parseInteger("0xffffffff", 32), -1n);
  assert.equal(parseInteger("-0x8000_0000", 32), -2147483648n);
  assert.equal(parseInteger("18446744073709551615", 64), -1n);
  assert.equal(parseInteger("-9223372036854775808", 64), -9223372036854775808n);
  for (const source of ["4294967296", "+2147483648", "-2147483649", "1.0", "1e2", "1__0", "_1"])
    assert.throws(() => parseInteger(source, 32), source);
  for (const source of ["-1", "+1", "4294967296"]) assert.throws(() => parseU32(source), source);
  assert.throws(() => parseInteger("18446744073709551616", 64));
});
