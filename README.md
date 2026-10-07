# wasmati 🍚 &nbsp; [![npm version](https://img.shields.io/npm/v/wasmati.svg?style=flat)](https://www.npmjs.com/package/wasmati)

_Write low-level WebAssembly, from JavaScript_

**wasmati** is a TS library that lets you create Wasm modules by writing out their instructions.

- 🥷 You want to create low-level, hand-optimized Wasm libraries? wasmati is the tool to do so effectively.
- 🚀 You want to sprinkle some Wasm in your JS app, to speed up critical parts? wasmati gives you a JS-native way to achieve that.
- 🌱 You want the latest Wasm features? wasmati supports all of WebAssembly 3.0 and every proposal at phase 4 or 5, and keeps up with new ones. Proposals at earlier phases follow once they see major adoption in engines.
- ⚠️ You want to compile Wasm modules from a high-level language, like Rust or C? wasmati is not for you.

```sh
npm i wasmati
```

```ts
// example.ts
import { i64, func, Module } from "wasmati";

const myMultiply = func({ in: [{ x: i64 }, { y: i64 }], out: [i64] }, ({ x, y }) => {
  i64.mul(x, y);
});

let module = Module({ exports: { myMultiply } });
let { instance } = await module.instantiate();

let result = instance.exports.myMultiply(5n, 20n);
console.log({ result });
```

```
$ node example.ts
{ result: 100n }
```

## Features

- Works in all modern browsers, `node` and `deno`

- **Parity with WebAssembly.** The API directly corresponds to Wasm opcodes, like `i32.add` etc. All opcodes and language features of [WebAssembly 3.0](https://webassembly.github.io/spec/core/) are supported, including garbage collection, typed function references, tail calls, exception handling, memory64, multiple memories, extended constant expressions, relaxed SIMD and JS string builtins (`jsString`, `stringConstant`). In addition, wasmati supports all standardized and nearly standardized (phase 4 and 5) proposals that are not part of that spec:

  - [threads and atomics](https://github.com/WebAssembly/threads/blob/master/proposals/threads/Overview.md)
  - [wide arithmetic](https://github.com/WebAssembly/wide-arithmetic/blob/main/proposals/wide-arithmetic/Overview.md)
  - [branch hinting](https://github.com/WebAssembly/branch-hinting/blob/main/proposals/branch-hinting/Overview.md): `br_if(label, { likely: true })`, `if_({ likely: false }, ...)`
  - [JS Promise Integration](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md): Wasm waits for async imports, `importFunc({ ..., async: true }, async () => ...)`, when JS enters it through async exports, `Module({ exports: { run: async(run) } })`, which return promises. `Module` checks that other exports cannot reach async imports.
  - [compact import sections](https://github.com/WebAssembly/compact-import-section/blob/main/proposals/compact-import-section/Overview.md), which wasmati reads

  Every module and assertion of the official WebAssembly 3.0 spec test suite runs through wasmati in CI, along with the tests of these proposals: modules are decompiled to wasmati code, rebuilt, and checked against the expected results.

- **Readability.** Wasm code looks imperative - like writing WAT by hand, just with better DX:

```ts
const myFunction = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => {
  local.get(x);
  local.get(y);
  i32.add();
  i32.const(2);
  i32.shl();
  call(otherFunction);
});
```

- Optional syntax sugar to reduce boilerplate assembly like `local.get` and `i32.const`

```ts
const myFunction = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => {
  i32.add(x, y); // local.get(x), local.get(y) are filled in
  i32.shl($, 2); // $ is the top of the stack; i32.const(2) is filled in
  call(otherFunction);
});

// or also

const myFunction = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => {
  let z = i32.add(x, y);
  call(otherFunction, { value: i32.shl(z, 2) });
});
```

- **Type-safe.** Example: Local variables are typed; instructions know their input types:

```ts
const myFunction = func(
  { in: [{ x: i32 }, { y: i32 }], locals: { u: i64 }, out: [i32] },
  ({ x, y }, { u }) => {
    i32.add(x, u); // type error: Type '"i64"' is not assignable to type '"i32"'.
  }
);
```

- **Great debugging DX.** Stack traces point to the exact line in your code where an invalid opcode is called:

```
Error: i32.add: expected i32 on the stack, got i64
    ...
    at file:///home/gregor/code/wasmati/examples/example.ts:16:9
```

- **Easy construction of modules.** Just declare exports; dependencies and imports are collected for you. Nothing ends up in the module which isn't needed by any of its exports or its start function.

```ts
let mem = memory({ min: 10 });

let module = Module({ exports: { myFunction, mem } });
let { instance } = await module.instantiate();
```

- **Excellent type inference.** Example: Exported function types are inferred from `func` definitions:

```ts
instance.exports.myFunction;
//                 ^ (x: number, y: number) => number
```

- **Atomic import declaration.** Imports are declared as types along with their JS values. Abstracts away the global "import object" that is separate from "import declaration".

```ts
const consoleLog = importFunc({ in: [{ x: i32 }], out: [] }, (x) =>
  console.log("logging from wasm:", x)
);

const myFunction = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => {
  call(consoleLog, { x });
  i32.add(x, y);
});
```

- Great composability and IO
  - Internal representation of modules / funcs / etc is a readable JSON object
    - close to [the spec's type layout](https://webassembly.github.io/spec/core/syntax/modules.html#modules) (but improves readability or JS ergonomics where necessary)
  - Convert to/from Wasm bytecode with `module.toBytes()`, `Module.fromBytes(bytes)`
  - Convert to/from the WebAssembly text format with `module.toWat()`, `Module.fromWat(text)`
  - Generate stack-style wasmati TypeScript with `decompile(bytesOrWat)` or `wasmati decompile input.wasm -o output.ts` (omit `-o` to write to stdout). The generated default export builds a `Module` from a `WebAssembly.Imports` object.
  - Convert files on the command line with `wasmati wat input.wasm` and `wasmati wasm input.wat -o output.wasm`. All commands take either format as input.

- Named parameters and debug names. `in: [{ x: i32 }, { y: i64 }]` declares parameter order; builder callbacks and `call(f, { x, y })` use names, while native exports retain typed positional arguments. Parameter, local and export keys populate the Wasm name section. Functions can use an explicit `name` or a named callback.

## Build: Wasm without the wasmati runtime

`wasmati build` turns a file that default-exports a `Module` into a `.wasm` file that JS imports directly, as an ES module. The app ships only the Wasm module and its imports, not wasmati.

```ts
// counter.ts
const log = importFunc({ in: [{ value: i32 }], out: [] }, (value) => console.log(value));
// ...
export default Module({ exports: { increment } });
```

```sh
npx wasmati build counter.ts -o built
```

```ts
import { increment } from "./built/counter.wasm";
```

The build writes:

- `counter.wasm`, the module.
- `counter.d.wasm.ts`, the types of its exports. TypeScript reads them with the `allowArbitraryExtensions` option.
- `counter.host.js`, if the module has imports written inline as above. The build extracts them from `counter.ts`, together with the top-level declarations and imports that they use; the Wasm module imports them from there.
- `counter.js` and `counter.d.ts`, if the module has async exports. JS imports this entry module instead, which wraps the async exports with `WebAssembly.promising`.
- `js-string.js`, if the module uses JS string builtins (`jsString`): a polyfill for bundlers, see below. String constants (`stringConstant`) become exports of `counter.host.js`.

A built file may only export its `Module`. Code that the app shares with imports, like state, belongs in another module, which both import. The build rejects imports that it can't move faithfully, such as functions that use variables of an enclosing function, and imports with an explicit `module` path must lead to the same value from the built file.

Built modules run in Node from 22.19 and 24.5, and in Deno from 2.1, which implement the ESM integration of Wasm. In browsers, bundle them. Bundlers do not provide JS string builtins, so map their module, `wasm:js-string`, to the polyfill. [examples/build](examples/build) has both configurations, which CI tests in Chrome:

- **Vite** with [`vite-plugin-wasm`](https://github.com/Menci/vite-plugin-wasm), building for the `esnext` target:

```js
export default {
  plugins: [wasm()],
  resolve: { alias: { "wasm:js-string": "/path/to/built/js-string.js" } },
  build: { target: "esnext" },
};
```

- **Next.js** with Turbopack, importing built modules in client code:

```js
export default {
  turbopack: { resolveAlias: { "wasm:js-string": "./path/to/built/js-string.js" } },
};
```

## Documentation

- [The wasmati skill](skills/wasmati/SKILL.md): detailed docs of the API, written for coding agents and readable by humans. It ships with the package, at `node_modules/wasmati/skills/wasmati/SKILL.md`.
- [The changelog](CHANGELOG.md), with migration notes for breaking changes.

## Ideas

_PRs welcome!_

- **Source maps**, so you can look at the culprit JS code when Wasm throws an error
- Optional JS interpreter which can take DSL code and execute it _in JS_
  - could enable even more flexible debugging -- inspect the stack, global/local scope etc
