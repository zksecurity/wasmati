import { Module, func, global, i32, call, importFunc, constant } from "wasmati";

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

export default Module({ exports: { increment } });
