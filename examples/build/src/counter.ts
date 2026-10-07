import {
  Module,
  func,
  global,
  i32,
  call,
  importFunc,
  constant,
  externref,
  jsString,
} from "wasmati";

// Imports are written inline, as usual; `wasmati build` moves them into counter.host.js.
const messages: string[] = [];
const log = importFunc({ in: [{ value: i32 }], out: [] }, (value: number) => {
  messages.push(`count is ${value}`);
  console.log(messages.at(-1));
});

const count = global(
  constant(() => i32.const(0)),
  { mutable: true },
);

const increment = func({ in: [{ by: i32 }], out: [i32] }, ({ by }) => {
  global.set(count, i32.add(global.get(count), by));
  call(log, { value: global.get(count) });
  global.get(count);
});

// JS string builtins come from the engine, or from a polyfill that bundlers map wasm:js-string to.
const measure = func({ in: [{ text: externref }], out: [i32] }, ({ text }) =>
  call(jsString.length, { string: text }),
);

export default Module({ exports: { increment, measure } });
