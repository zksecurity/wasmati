// Run with node src/bench/named-arguments.ts; compares the actual exported adapters.
import { Module, func, i32, local } from "../index.ts";

const add = func({ in: { value: i32, increment: i32 }, out: [i32] }, ({ value, increment }) => {
  i32.add(value, increment);
});
const arithmetic = func(
  { in: { value: i32, increment: i32 }, locals: { accumulator: i32 }, out: [i32] },
  ({ value, increment }, { accumulator }) => {
    local.set(accumulator, value);
    for (let i = 0; i < 64; i++) {
      local.set(accumulator, i32.xor(i32.mul(accumulator, 1664525), increment));
    }
    local.get(accumulator);
  },
);
const { instance, exports } = await Module({ exports: { add, arithmetic } }).instantiate();
const iterations = Number(process.env.WASMATI_BENCH_ITERATIONS ?? 10_000_000);
let checksum = 0;

function nativeTime(fn: (value: number, increment: number) => number) {
  let value = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) value = fn(value, i);
  const duration = performance.now() - start;
  checksum ^= value;
  return duration * 1e6 / iterations;
}

function namedTime(fn: (args: { value: number; increment: number }) => number) {
  let value = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) value = fn({ value, increment: i });
  const duration = performance.now() - start;
  checksum ^= value;
  return duration * 1e6 / iterations;
}

const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const name of ["add", "arithmetic"] as const) {
  const native = instance.exports[name] as (value: number, increment: number) => number;
  const named = exports[name];
  for (let i = 0; i < 3; i++) {
    nativeTime(native);
    namedTime(named);
  }
  const nativeSamples: number[] = [], namedSamples: number[] = [];
  for (let i = 0; i < 7; i++) {
    // Alternate order to reduce timing bias.
    if (i % 2 === 0) {
      nativeSamples.push(nativeTime(native));
      namedSamples.push(namedTime(named));
    } else {
      namedSamples.push(namedTime(named));
      nativeSamples.push(nativeTime(native));
    }
  }
  const raw = median(nativeSamples), adapted = median(namedSamples);
  console.log(`${name}: native ${raw.toFixed(2)} ns, named ${adapted.toFixed(2)} ns, difference ${(adapted - raw).toFixed(2)} ns/call`);
}
console.log({ iterations, checksum });
