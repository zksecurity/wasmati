import assert from "node:assert/strict";
import test from "node:test";
import { Byte, RemainingBytes, record } from "../binable.ts";
import { I32, I64, Name, S33, U32, U64, U8, withByteLength } from "../immediate.ts";

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

test("integers encode like the reference encoder, also through the fast paths", () => {
  // Signed LEB128 of BigInts, the encoder before the fast paths.
  const reference = (x: bigint) => {
    const bytes: number[] = [];
    while (true) {
      const byte = Number(x & 0x7fn);
      x >>= 7n;
      if ((x === 0n && (byte & 0x40) === 0) || (x === -1n && (byte & 0x40) !== 0))
        return [...bytes, byte];
      bytes.push(byte | 0x80);
    }
  };
  const edges = [0n, 1n, -1n, 63n, 64n, -64n, -65n, 2n ** 31n, -(2n ** 31n), 2n ** 32n, 2n ** 53n];
  const values = [...edges, ...edges.map((x) => x - 1n), 2n ** 63n - 1n, -(2n ** 63n)];
  for (let i = 0n; i < 64n; i++) values.push(1n << i, -(1n << i), 0x5a5a5a5a5a5a5a5an >> i);
  for (const x of values) {
    assert.deepEqual(I64.toBytes(x), reference(BigInt.asIntN(64, x)), `i64 ${x}`);
    if (x >= -(2n ** 31n) && x < 2n ** 32n)
      assert.deepEqual(I32.toBytes(Number(x)), reference(BigInt.asIntN(32, x)), `i32 ${x}`);
    if (x >= 0n && x <= BigInt(Number.MAX_SAFE_INTEGER))
      assert.equal(U64.fromBytes(U64.toBytes(Number(x))), Number(x), `u64 ${x}`);
  }
});

test("length prefixes take as many bytes as the length needs, also when the buffer grows", () => {
  const Bytes = withByteLength(RemainingBytes);
  for (const length of [0, 1, 127, 128, 5000, 16383, 16384, 70000]) {
    const body = Array.from({ length }, (_, i) => i % 251);
    const bytes = record({ before: Byte, value: Bytes, after: Byte }).encode({
      before: 1,
      value: body,
      after: 2,
    });
    const prefix = U32.toBytes(length);
    assert.equal(bytes.length, 2 + prefix.length + length);
    assert.deepEqual([...bytes.subarray(1, 1 + prefix.length)], prefix);
    assert.equal(bytes[bytes.length - 1], 2);
    assert.deepEqual(Bytes.fromBytes(bytes.subarray(1, -1)), body);
  }
  // Nested prefixes, where the inner body moves twice.
  const Nested = withByteLength(withByteLength(RemainingBytes));
  const body = Array.from({ length: 300 }, (_, i) => i % 256);
  assert.deepEqual(Nested.toBytes(body), [...U32.toBytes(302), ...U32.toBytes(300), ...body]);
});
