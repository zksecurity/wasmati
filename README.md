# wasmati

_Write low-level WebAssembly, from JavaScript_

**wasmati** is a TS library that lets you create Wasm modules by writing out their instructions.

- 🥷 You want to create low-level, hand-optimized Wasm libraries? wasmati is the toolset to do so effectively.
- 🚀 You want to sprinkle some Wasm into your JS application, to speed up critical parts? wasmati gives you a JS-native way to achieve that.
- ⚠️ You want to compile your Wasm modules from a high-level language, like Rust or C? wasmati is not for you.

```sh
npm i wasmati
```

```ts
// example.ts
import { i64, func, Module } from "wasmati";

const myFunction = func({ in: [i64, i64], out: [i64] }, ([x, y]) => {
  i64.mul(x, y);
});

let module = Module({ exports: { myFunction } });
let { instance } = await module.instantiate();

let result = instance.exports.myFunction(5n, 20n);
console.log({ result });
```

```
$ ts-node-esm example.ts
{ result: 100n }
```

## Features

- Works in all modern browsers, `node` and `deno`

- **Parity with WebAssembly.** The API directly corresponds to Wasm opcodes, like `i32.add` etc. All opcodes and language features of the [latest WebAssembly spec (2.0)](https://webassembly.github.io/spec/core/index.html) are supported.

- **Readability.** Wasm code looks imperative - like writing WAT by hand, just with better DX:

```ts
const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
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
const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  i32.add(x, y); // local.get(x), local.get(y) are filled in
  i32.shl($, 2); // $ is the top of the stack; i32.const(2) is filled in
  call(otherFunction);
});

// or also

const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  let z = i32.add(x, y);
  call(otherFunction, [i32.shl(z, 2)]);
});
```

- **Type-safe.** Example: Local variables are typed; instructions know their input types:

```ts
const myFunction = func(
  { in: [i32, i32], locals: [i64], out: [i32] },
  ([x, y], [u]) => {
    i32.add(x, u); // type error: "Argument of type 'i64' is not assignable to parameter of type 'i32'."
  }
);
```

- **Great debugging DX.** Stack traces point to the exact line in your code where an invalid opcode is called:

```
Error: i32.add: Expected i32 on the stack, got i64.
    ...
    at file:///home/gregor/code/wasmati/examples/example.ts:16:9
```

- **Easy construction of modules.** Just declare exports; dependencies and imports are collected for you. Nothing ends up in the module which isn't needed by any of its exports or its start function.

```ts
let mem = memory({ min: 10 });

let module = Module({ exports: { myFunction, mem } });
let instance = await module.instantiate();
```

- **Excellent type inference.** Example: Exported function types are inferred from `func` definitions:

```ts
instance.exports.myFunction;
//                 ^ (arg_0: number, arg_1: number) => number
```

- **Atomic import declaration.** Imports are declared as types along with their JS values. Abstracts away the global "import object" that is separate from "import declaration".

```ts
const consoleLog = importFunc({ in: [i32], out: [] }, (x) =>
  console.log("logging from wasm:", x)
);

const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  call(consoleLog, [x]);
  i32.add(x, y);
});
```

- Great composability and IO
  - Internal representation of modules / funcs / etc is a readable JSON object
    - close to [the spec's type layout](https://webassembly.github.io/spec/core/syntax/modules.html#modules) (but improves readability or JS ergonomics where necessary)
  - Helpers like `module.toBytes()`, `Module.fromBytes(bytes, imports)`

### Features that aren't implemented yet

_PRs welcome!_

- **Wasmati build.** We want to add an optional build step which takes as input a file that exports your `Module`, and compiles it to a file which doesn't depend on wasmati at runtime. Instead, it hard-codes the Wasm bytecode as base64 string, correctly imports all dependencies (imports) for the instantiation like the original file did, instantiates the module (top-level await) and exports the module's exports.

```ts
// example.ts
let module = Module({ exports: { myFunction, mem } });

export { module as default };
```

```ts
import { myFunction } from "./example.wasm.js"; // example.wasm.js does not depend on wasmati at runtime
```

- **Experimental Wasm opcodes.** We want to support opcodes from recently standardized or in-progress feature proposals ([like this one](https://github.com/WebAssembly/threads/blob/master/proposals/threads/Overview.md)) which haven't yet made it to the spec. The eventual goal is to support these as soon as they are implemented in at least one JS engine.implemented yet

- **Custom module sections.** We want to support creation and parsing of "custom sections" like the [name section](https://webassembly.github.io/spec/core/appendix/custom.html#name-section)

### Some ideas that are a bit further out:

- **Decompiler**: take _any_ Wasm file and create TS DSL code from it, to modify it, debug it etc
- **Source maps**, so you can look at the culprit JS code when Wasm throws an error
- Optional JS interpreter which can take DSL code and execute it _in JS_
  - could enable even more flexible debugging -- inspect the stack, global/local scope etc
