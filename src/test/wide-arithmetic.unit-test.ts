import assert from "node:assert/strict";
import { test } from "node:test";
import { $, constant, Module, func, global, i32, i64, local, StackVar } from "../index.ts";

const add128 = func(
  { in: [{ aLo: i64 }, { aHi: i64 }, { bLo: i64 }, { bHi: i64 }], out: [i64, i64] },
  ({ aLo, aHi, bLo, bHi }) => {
    i64.add128(aLo, aHi, bLo, bHi);
  },
);
const sub128 = func(
  { in: [{ aLo: i64 }, { aHi: i64 }, { bLo: i64 }, { bHi: i64 }], out: [i64, i64] },
  ({ aLo, aHi, bLo, bHi }) => {
    local.get(aLo);
    local.get(aHi);
    local.get(bLo);
    local.get(bHi);
    i64.sub128();
  },
);
const mulWideS = func({ in: [{ a: i64 }, { b: i64 }], out: [i64, i64] }, ({ a, b }) => {
  i64.mul_wide_s(a, b);
});
const mulWideU = func({ in: [{ a: i64 }, { b: i64 }], out: [i64, i64] }, ({ a, b }) => {
  local.get(a);
  local.get(b);
  i64.mul_wide_u();
});

const module = Module({ exports: { add128, sub128, mulWideS, mulWideU } });

test("wide arithmetic encodes and decodes the proposal opcodes", () => {
  const cases = [
    [add128, 0x13, 4],
    [sub128, 0x14, 4],
    [mulWideS, 0x15, 2],
    [mulWideU, 0x16, 2],
  ] as const;
  for (const [op, subcode, arity] of cases) {
    const single = Module({ exports: { op } });
    const bytes = single.toBytes();
    const body = [
      0, // no locals
      ...Array.from({ length: arity }, (_, i) => [0x20, i]).flat(),
      0xfc,
      subcode,
      0x0b,
    ];
    // Name metadata follows the code section; inspect code without that metadata.
    const { names, ...json } = single.toJSON();
    const codeOnly = Module.fromJSON(json);
    assert.deepEqual([...codeOnly.toBytes().slice(-body.length)], body);
    const recovered = Module.fromBytes(bytes);
    assert.deepEqual(recovered.toJSON(), single.toJSON());
    assert.deepEqual(recovered.toBytes(), bytes);
  }
});

// JS exposes i64 results as signed bigints, even for unsigned operations.
function pair(x: bigint): [bigint, bigint] {
  return [BigInt.asIntN(64, x), BigInt.asIntN(64, x >> 64n)];
}
function join(lo: bigint, hi: bigint) {
  return BigInt.asUintN(64, lo) | (BigInt.asUintN(64, hi) << 64n);
}
const limbs = [0n, 1n, 2n, (1n << 63n) - 1n, 1n << 63n, (1n << 64n) - 2n, (1n << 64n) - 1n];

test("128-bit addition and subtraction match bigint, including carry, borrow and wraparound", async () => {
  const { instance } = await module.instantiate();
  const { add128, sub128 } = instance.exports;
  add128 satisfies (aLo: bigint, aHi: bigint, bLo: bigint, bHi: bigint) => [bigint, bigint];
  for (const aLo of limbs)
    for (const aHi of limbs) {
      for (const bLo of limbs)
        for (const bHi of limbs) {
          const a = join(aLo, aHi);
          const b = join(bLo, bHi);
          assert.deepEqual(add128(aLo, aHi, bLo, bHi), pair(a + b));
          assert.deepEqual(sub128(aLo, aHi, bLo, bHi), pair(a - b));
        }
    }
});

test("signed and unsigned widening multiplication match bigint", async () => {
  const { instance } = await module.instantiate();
  const { mulWideS, mulWideU } = instance.exports;
  mulWideU satisfies (a: bigint, b: bigint) => [bigint, bigint];
  for (const a of limbs)
    for (const b of limbs) {
      assert.deepEqual(mulWideS(a, b), pair(BigInt.asIntN(64, a) * BigInt.asIntN(64, b)));
      assert.deepEqual(mulWideU(a, b), pair(a * b));
      // Negative JS arguments carry the same bits as their unsigned counterparts.
      assert.deepEqual(mulWideU(BigInt.asIntN(64, a), BigInt.asIntN(64, b)), pair(a * b));
    }
  // Exercise optimized execution with deterministic inputs spanning all 64 bits.
  let state = 1n;
  function next() {
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    return state;
  }
  for (let i = 0; i < 20_000; i++) {
    const a = next(),
      b = next(),
      c = next(),
      d = next();
    assert.deepEqual(mulWideU(a, b), pair(a * b));
    assert.deepEqual(mulWideS(a, b), pair(BigInt.asIntN(64, a) * BigInt.asIntN(64, b)));
    assert.deepEqual(instance.exports.add128(a, b, c, d), pair(join(a, b) + join(c, d)));
    assert.deepEqual(instance.exports.sub128(a, b, c, d), pair(join(a, b) - join(c, d)));
  }
});

test("wide results compose with locals, constants, globals and stack operands", async () => {
  const one = global(constant(() => i64.const(1n)));
  const multiplyAdd = func(
    { in: [{ a: i64 }, { b: i64 }], locals: { lo: i64, hi: i64 }, out: [i64, i64] },
    ({ a, b }, { lo, hi }) => {
      const result: [StackVar<i64>, StackVar<i64>] = i64.mul_wide_u(a, b);
      // High is on top of the stack; save it before low.
      local.set(hi, result[1]);
      local.set(lo, result[0]);
      i64.add128(lo, hi, one, 0n);
    },
  );
  const stackAdd = func({ in: [{ a: i64 }, { b: i64 }], out: [i64, i64] }, ({ a, b }) => {
    i64.mul_wide_u(a, b);
    i64.add128($, $, 1n, 0n);
  });
  const constantsBelowStack = func(
    { in: [{ a: i64 }, { b: i64 }], out: [i64, i64] },
    ({ a, b }) => {
      i64.const(0n);
      i64.const(0n);
      i64.mul_wide_u(a, b);
      i64.sub128();
    },
  );
  const chained = func(
    { in: [{ a: i64 }, { b: i64 }, { c: i64 }, { d: i64 }], out: [i64, i64] },
    ({ a, b, c, d }) => {
      i64.mul_wide_u(a, b);
      i64.mul_wide_u(c, d);
      i64.add128();
    },
  );
  const { instance } = await Module({
    exports: { multiplyAdd, stackAdd, constantsBelowStack, chained },
  }).instantiate();
  for (const a of limbs)
    for (const b of limbs) {
      assert.deepEqual(instance.exports.multiplyAdd(a, b), pair(a * b + 1n));
      assert.deepEqual(instance.exports.stackAdd(a, b), pair(a * b + 1n));
      assert.deepEqual(instance.exports.constantsBelowStack(a, b), pair(-a * b));
      assert.deepEqual(instance.exports.chained(a, b, b, a), pair(2n * a * b));
    }
});

test("decoded wide arithmetic modules execute", async () => {
  const recovered = Module.fromBytes<{
    add128: typeof add128;
    sub128: typeof sub128;
    mulWideS: typeof mulWideS;
    mulWideU: typeof mulWideU;
  }>(module.toBytes());
  const { instance } = await recovered.instantiate();
  assert.deepEqual(instance.exports.add128(-1n, -1n, 1n, 0n), [0n, 0n]);
  assert.deepEqual(instance.exports.sub128(0n, 0n, 1n, 0n), [-1n, -1n]);
  assert.deepEqual(instance.exports.mulWideS(-1n, 2n), [-2n, -1n]);
  assert.deepEqual(instance.exports.mulWideU(-1n, -1n), [1n, -2n]);
});

test("wide arithmetic validates operand types and both results", () => {
  assert.throws(
    () =>
      func({ in: [{ x: i32 }], out: [i64, i64] }, ({ x }) => {
        // @ts-expect-error wide instructions take i64 operands
        i64.mul_wide_s(x, 1n);
      }),
    /Expected type i64/,
  );
  assert.throws(
    () =>
      func({ in: [], out: [i64, i64] }, () => {
        i32.const(1);
        i64.const(2n);
        i64.mul_wide_u();
      }),
    /expected i64 on the stack, got i32/,
  );
  assert.throws(
    () =>
      func({ in: [], out: [i64] }, () => {
        i64.mul_wide_u(1n, 2n);
      }),
    /expected stack to be empty/,
  );
});
