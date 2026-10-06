import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Byte,
  RemainingBytes,
  constant,
  record,
  sequence,
  interleavedRecord,
  orUndefined,
  or,
  withByteCode,
} from "../binable.ts";
import { withByteLength } from "../immediate.ts";
import "../index.ts";
import { Elem } from "../memory-binable.ts";

test("alternatives accept numeric selectors for both encoding and decoding", () => {
  const codec = or([withByteCode(1, Byte), withByteCode(2, Byte)], (value) => (value < 10 ? 0 : 1));
  assert.deepEqual(codec.toBytes(3), [1, 3]);
  assert.deepEqual(codec.toBytes(20), [2, 20]);
  assert.equal(codec.fromBytes([1, 3]), 3);
  assert.equal(codec.fromBytes([2, 20]), 20);
  assert.throws(() => codec.fromBytes([1, 20]));
});

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
  assert.throws(() => withByteLength(RemainingBytes).fromBytes([3, 10, 20]));
  assert.deepEqual(withByteLength(RemainingBytes).fromBytes([2, 10, 20]), [10, 20]);
});

test("sequences reject elements that consume no bytes or overrun the input", () => {
  assert.throws(() => sequence(constant(0)).fromBytes([1]), /element length/);
  assert.throws(() => sequence(record({ a: Byte, b: Byte })).fromBytes([1]), /element length/);
});

test("interleaved records preserve extra entries around optional fields", () => {
  const codec = interleavedRecord(
    {
      first: withByteCode(1, Byte),
      optional: orUndefined(withByteCode(2, Byte)),
      last: withByteCode(3, Byte),
    },
    { codec: withByteCode(0, Byte), matches: (bytes, offset) => bytes[offset] === 0 },
  );
  const value = {
    value: { first: 10, optional: undefined, last: 30 },
    extras: [
      { after: undefined, value: 9 },
      { after: "first" as const, value: 19 },
      { after: "last" as const, value: 39 },
    ],
  };
  const bytes = [0, 9, 1, 10, 0, 19, 3, 30, 0, 39];
  assert.deepEqual(codec.toBytes(value), bytes);
  assert.deepEqual(codec.fromBytes(bytes), value);
  assert.deepEqual(
    codec.toBytes({ ...value, extras: [{ after: "optional", value: 19 }] }),
    [1, 10, 0, 19, 3, 30],
  );
});

test("active element segments encode a non-default table or element type explicitly", () => {
  const offset = [{ name: "i32.const", immediate: 0 }];
  const ref = (immediate: number) => [{ name: "ref.func", immediate }];
  const cases: [Elem, number][] = [
    [{ type: "funcref", init: [ref(1)], mode: { table: 0, offset } }, 0],
    [{ type: "funcref", init: [ref(1)], mode: { table: 1, offset } }, 2],
    [
      {
        type: "externref",
        init: [[{ name: "ref.null", immediate: "externref" }]],
        mode: { table: 0, offset },
      },
      6,
    ],
    [
      {
        type: "externref",
        init: [[{ name: "ref.null", immediate: "externref" }]],
        mode: { table: 1, offset },
      },
      6,
    ],
  ];
  for (const [elem, flags] of cases) {
    const bytes = Elem.toBytes(elem);
    assert.equal(bytes[0], flags);
    assert.deepEqual(Elem.fromBytes(bytes), elem);
  }
});
