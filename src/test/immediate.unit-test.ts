import assert from "node:assert/strict";
import test from "node:test";
import { I32, I64, Name, S33, U32, U8 } from "../immediate.ts";

test("LEB128 integers roundtrip at their width", () => {
  for (const x of [0, 1, 10, 63, 64, 127, 9999, 2187698, 2 ** 27, 2 ** 30 + 2 ** 16, 2 ** 31 - 1])
    assert.equal(I32.fromBytes(I32.toBytes(x)), x);
  for (const x of [-1, -2, -10, -999, -(2 ** 21), -(2 ** 28), -(2 ** 29), -(2 ** 31)])
    assert.equal(I32.fromBytes(I32.toBytes(x)), x);
  for (const x of [0, 2 ** 6, 2 ** 27, 2 ** 32 - 1]) assert.equal(U32.fromBytes(U32.toBytes(x)), x);
  for (const x of [-(2n ** 40n) + 1n, -(2n ** 63n), 2n ** 63n - 1n])
    assert.equal(I64.fromBytes(I64.toBytes(x)), x);
  // Unsigned bit patterns encode as their signed interpretation.
  assert.deepEqual(I32.toBytes(0xffffffff), I32.toBytes(-1));
  assert.deepEqual(I64.toBytes(2n ** 64n - 1n), I64.toBytes(-1n));
});

test("LEB128 decoding rejects overlong encodings, unused bits and truncation", () => {
  // Redundant zero padding is allowed up to the maximum length.
  assert.equal(U32.fromBytes([0x80, 0x80, 0x80, 0x80, 0x00]), 0);
  assert.equal(I32.fromBytes([0xff, 0xff, 0xff, 0xff, 0x7f]), -1);
  assert.throws(() => U32.fromBytes([0x80, 0x80, 0x80, 0x80, 0x80, 0x00]), /too long/);
  assert.throws(() => U32.fromBytes([0x80, 0x80, 0x80, 0x80, 0x70]), /too large/);
  assert.throws(() => I32.fromBytes([0xff, 0xff, 0xff, 0xff, 0x4f]), /too large/);
  assert.throws(() => I32.fromBytes([0x80, 0x80, 0x80, 0x80, 0x1f]), /too large/);
  assert.throws(() => I64.fromBytes([...Array(9).fill(0x80), 0x02]), /too large/);
  assert.equal(I64.fromBytes([...Array(9).fill(0xff), 0x7f]), -1n);
  assert.throws(() => S33.fromBytes([0x80, 0x80, 0x80, 0x80, 0x20]), /too large/);
  assert.throws(() => U32.fromBytes([0x80]), /unexpected end/);
});

test("names must be complete UTF-8, lanes are single bytes", () => {
  assert.equal(Name.fromBytes(Name.toBytes("héllo")), "héllo");
  assert.throws(() => Name.fromBytes([2, 0xc3]), /unexpected end/);
  assert.throws(() => Name.fromBytes([1, 0xff]), /malformed UTF-8/);
  assert.deepEqual(U8.toBytes(200), [200]);
  assert.equal(U8.fromBytes([200]), 200);
});
