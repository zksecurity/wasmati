// run with `node --loader=ts-node/esm examples/fma.ts`
import assert from "assert";
import { f64, f64x2, func, Module } from "../src/index.js";

const fma = func({ in: [f64, f64, f64], out: [f64] }, ([x, y, z]) => {
  f64x2.splat(x);
  f64x2.splat(y);
  f64x2.splat(z);
  f64x2.relaxed_madd();
  f64x2.extract_lane(0);
});

let module = Module({ exports: { fma } });
let { instance } = await module.instantiate();

console.dir(module.module, { depth: Infinity });

let [x, y, z] = [0.5, 3, 1.5];

let result = instance.exports.fma(x, y, z);

assert.equal(result, x * y + z);
console.log({ result });
// { result: 0.5 * 3 + 1.5 = 3 }
