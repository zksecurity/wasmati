// Builds a module, which needs the builder only.
import { func, i32, Module } from "wasmati";
const add = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => i32.add(x, y));
export const add2 = async () =>
  (await Module({ exports: { add } }).instantiate()).instance.exports.add(1, 1);
