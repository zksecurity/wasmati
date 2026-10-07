import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  i32,
  call,
  jsString,
  stringConstant,
  externref,
  global,
  array,
  refType,
  type Instance,
} from "../index.ts";
import { helperBytes } from "../js-string-polyfill.ts";

const hello = stringConstant("hello ");
const greet = func({ in: [{ name: externref }], out: [externref] }, ({ name }) => {
  call(jsString.concat, { first: global.get(hello), second: name });
});
const length = func({ in: [{ string: externref }], out: [i32] }, ({ string }) =>
  call(jsString.length, { string }),
);
const hi = func({ in: [], out: [externref] }, () => {
  array.new_fixed(jsString.charCodeArray, [104, 105]);
  i32.const(0);
  i32.const(2);
  call(jsString.fromCharCodeArray);
});

test("JS string builtins and string constants are provided by the engine", async () => {
  const module = Module({ exports: { greet, length, hi } });
  assert.deepEqual(
    module.module.imports.map(({ module, name }) => [module, name]),
    [
      ["wasm:js-string", "concat"],
      ["wasm:js-string", "length"],
      ["wasm:js-string", "fromCharCodeArray"],
      ["'", "hello "],
    ],
  );
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.greet("world"), "hello world");
  assert.equal(instance.exports.length("abc"), 3);
  assert.equal(instance.exports.hi(), "hi");
});

test("without engine builtins, JS functions behave like them", async () => {
  const module = Module({ exports: { greet, length, hi } });
  const { instance } = await WebAssembly.instantiate(module.toBytes(), module.importMap);
  const exports = instance.exports as any;
  assert.equal(exports.greet("world"), "hello world");
  assert.equal(exports.length("abc"), 3);
  assert.equal(exports.hi(), "hi");
});

test("the polyfill's array helper is the module that wasmati builds", () => {
  const charCodes = refType(jsString.charCodeArray, { nullable: true });
  const length = func({ in: [{ array: charCodes }], out: [i32] }, ({ array: a }) => array.len(a));
  const get = func({ in: [{ array: charCodes }, { i: i32 }], out: [i32] }, ({ array: a, i }) =>
    array.get_u(jsString.charCodeArray, a, i),
  );
  const set = func(
    { in: [{ array: charCodes }, { i: i32 }, { code: i32 }], out: [] },
    ({ array: a, i, code }) => array.set(jsString.charCodeArray, a, i, code),
  );
  const bytes = Module({ exports: { length, get, set } }).toBytes();
  assert.equal(Buffer.from(bytes).toString("base64"), helperBytes);
});

test("compiled modules use the engine's builtins, and instantiate with the import object", async () => {
  const wasm = Module({ exports: { greet, length } });
  const compiled = await wasm.compile();
  assert.deepEqual(
    WebAssembly.Module.imports(compiled).map(({ module }) => module),
    [],
  );
  const instance = (await WebAssembly.instantiate(compiled, wasm.importMap)) as Instance<
    typeof wasm
  >;
  assert.equal(instance.exports.greet("world"), "hello world");
  assert.equal(instance.exports.length("four"), 4);
});
