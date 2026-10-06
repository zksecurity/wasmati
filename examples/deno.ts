// Deno example - run with `deno run examples/deno.ts`
import { i64, func, Module } from "npm:wasmati";

const myFunction = func({ in: { x: i64, y: i64 }, out: [i64] }, ({ x, y }) => {
  i64.mul(x, y);
});

let module = Module({ exports: { myFunction } });
let { exports } = await module.instantiate();

let result = exports.myFunction({ x: 5n, y: 20n });
console.log({ result });
// { result: 100n }
