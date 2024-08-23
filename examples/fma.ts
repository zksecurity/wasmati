// run with `node --loader=ts-node/esm examples/fma.ts`
import assert from "assert";
import { f64, f64x2, func, Module } from "../src/index.js";

const fma = func({ in: [f64, f64, f64], out: [f64] }, ([x, y, z]) => {
  let r = f64x2.relaxed_madd(f64x2.splat(x), f64x2.splat(y), f64x2.splat(z));
  f64x2.extract_lane(0, r);
});

const fnma = func({ in: [f64, f64, f64], out: [f64] }, ([x, y, z]) => {
  let r = f64x2.relaxed_nmadd(f64x2.splat(x), f64x2.splat(y), f64x2.splat(z));
  f64x2.extract_lane(0, r);
});

let module = Module({ exports: { fma, fnma } });
let { instance } = await module.instantiate();

console.dir(module.module, { depth: Infinity });

let [x, y, z] = [0.5, 3, 1.25];

let r1 = instance.exports.fma(x, y, z);
let r2 = instance.exports.fnma(x, y, z);

assert.equal(r1, x * y + z);
assert.equal(r2, -(x * y) + z);

console.log({ r1, r2 });
// { r1: 2.75, r2: -0.25 }
