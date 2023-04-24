// Deno example - run with `deno run examples/deno.ts`
import { i64, func, Module } from "npm:wasmati";

const myFunction = func({ in: [i64, i64], out: [i64] }, ([x, y]) => {
  i64.mul(x, y);
});

let module = Module({ exports: { myFunction } });
let { instance } = await module.instantiate();

let result = instance.exports.myFunction(5n, 20n);
console.log({ result });
// { result: 100n }
