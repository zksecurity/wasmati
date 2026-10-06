import assert from "node:assert/strict";
import { test } from "node:test";
import { Byte, Bytes, constant, record, sequence } from "../binable.ts";
import { U32, withByteLength } from "../immediate.ts";

test("length-delimited sequences compose with following record fields", () => {
  const codec = record({ values: withByteLength(sequence(Byte)), marker: Byte });
  assert.deepEqual(codec.toBytes({ values: [10, 20], marker: 99 }), [2, 10, 20, 99]);
  assert.deepEqual(codec.fromBytes([2, 10, 20, 99]), { values: [10, 20], marker: 99 });
  assert.deepEqual(codec.fromBytes([0, 99]), { values: [], marker: 99 });
});

test("length-delimited codecs cannot read across their payload boundary", () => {
  const codec = record({ value: withByteLength(Byte), marker: Byte });
  assert.throws(() => codec.fromBytes([0, 99]));
  assert.throws(() => codec.fromBytes([2, 10, 20, 99]));
  assert.throws(() => withByteLength(Bytes).fromBytes([3, 10, 20]));
  assert.deepEqual(withByteLength(Bytes).fromBytes([2, 10, 20]), [10, 20]);
});

test("sequences reject elements that consume no bytes or overrun the input", () => {
  assert.throws(() => sequence(constant(0)).fromBytes([1]), /element length/);
  assert.throws(() => sequence(record({ a: Byte, b: Byte })).fromBytes([1]), /element length/);
});

test("u32 framing rejects truncated, overflowing and out-of-range lengths", () => {
  for (const bytes of [[], [128], [255, 255, 255, 255, 16], [128, 128, 128, 128, 128, 0]]) {
    assert.throws(() => U32.fromBytes(bytes));
  }
  for (const value of [-1, 1.5, 2 ** 32]) assert.throws(() => U32.toBytes(value));
  assert.equal(U32.fromBytes([255, 255, 255, 255, 15]), 0xffff_ffff);
});
