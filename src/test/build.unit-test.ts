import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "../build/build.ts";

const wasmati = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Write files to a new directory, with `WASMATI` standing for the import path of wasmati. */
async function project(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "wasmati-build-"));
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content.replaceAll("WASMATI", JSON.stringify(wasmati)));
  return directory;
}

test("built modules import their inline imports from an extracted host module", async () => {
  const directory = await project({
    "format.ts": "export const format = (x: number) => `value ${x}`;",
    "counter.ts": "export let count = 0;\nexport function increment() { count++; }",
    "lib.ts": `import { Module, func, i32, call, importFunc, importGlobal, jsString, externref, global, stringConstant } from WASMATI;
import { format } from "./format.ts";
import { increment } from "./counter.ts";
const lines: string[] = [];
const log = importFunc({ in: [{ x: i32 }], out: [] }, (x: number) => { lines.push(format(x)); });
const tick = importFunc({ in: [], out: [] }, increment);
const offset = importGlobal(i32, 10);
const twice = importFunc({ in: [{ x: i32 }], out: [] }, (x: number) => { lines.push(format(x)); });
const run = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  call(log, { x });
  call(twice, { x });
  call(tick);
  i32.add(x, 1);
});
const length = func({ in: [{ s: externref }], out: [i32] }, ({ s }) => call(jsString.length, { string: s }));
const hello = stringConstant("hello");
const greeting = func({ in: [], out: [externref] }, () => global.get(hello));
export default Module({ exports: { run, length, offset, greeting } });
`,
  });
  try {
    const output = await build(join(directory, "lib.ts"), { outDir: join(directory, "dist") });
    const host = await readFile(output.host!, "utf8");
    assert.match(host, /^import \{ format \} from "\.\.\/format\.ts";$/m);
    assert.match(host, /^const lines = \[\];$/m);
    assert.match(host, /^const log = \(x\) => \{ lines\.push\(format\(x\)\); \};$/m);
    assert.match(host, /^export \{ increment \} from "\.\.\/counter\.ts";$/m);
    // String constants become exports of the host module; builtins get a polyfill for bundlers.
    assert.match(host, /^const hello = "hello";$/m);
    const polyfill = await import(pathToFileURL(output.jsStringPolyfill!).href);
    assert.equal(polyfill.length("abcd"), 4);
    assert.match(
      await readFile(output.types, "utf8"),
      /declare function run\(x: number\): number;/,
    );
    const exports = await import(pathToFileURL(output.wasm).href);
    const { count } = await import(pathToFileURL(join(directory, "counter.ts")).href);
    assert.equal(count, 0);
    assert.equal(exports.run(41), 42);
    assert.equal(exports.length("abc"), 3);
    assert.equal(exports.offset, 10);
    assert.equal(exports.greeting(), "hello");
    // The counter module is shared between the app and the host module.
    const { count: after } = await import(pathToFileURL(join(directory, "counter.ts")).href);
    assert.equal(after, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("async imports become WebAssembly.Suspending exports, and explicit module paths are checked", async () => {
  const directory = await project({
    "host.ts": `export const slow = new WebAssembly.Suspending(async (x: number) => 2 * x);
export const add = (a: number, b: number) => a + b;`,
    "lib.ts": `import { Module, func, i32, call, importFunc, async } from WASMATI;
import { add } from "./host.ts";
const later = importFunc({ in: [{ x: i32 }], out: [i32], async: true }, async (x: number) => x + 1);
const plus = importFunc({ module: "./host.ts", field: "add", in: [{ a: i32 }, { b: i32 }], out: [i32] }, add);
const run = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => call(plus, { a: call(later, { x }), b: 1 }));
const sync = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => call(plus, { a: x, b: 1 }));
export default Module({ exports: { run: async(run), sync } });
`,
  });
  try {
    const output = await build(join(directory, "lib.ts"));
    assert.match(
      await readFile(output.host!, "utf8"),
      /const later = new WebAssembly\.Suspending\(async \(x\) => x \+ 1\);/,
    );
    assert.match(
      await readFile(output.entryTypes!, "utf8"),
      /declare function run\(x: number\): Promise<number>;/,
    );
    const { run, sync } = await import(pathToFileURL(output.entry!).href);
    assert.equal(await run(1), 3);
    assert.equal(sync(1), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the build rejects modules whose imports cannot be extracted faithfully", async () => {
  const module = (
    body: string,
    exports = "{ run }",
  ) => `import { Module, func, i32, call, importFunc, async } from WASMATI;
${body}
export default Module({ exports: ${exports} });
`;
  const cases: [string, Record<string, string>, RegExp][] = [
    [
      "other exports",
      {
        "lib.ts":
          module("const run = func({ in: [], out: [] }, () => {});") + "export const extra = 1;\n",
      },
      /lib\.ts exports extra; a built file may only export its Module/,
    ],
    [
      "variables of enclosing functions",
      {
        "lib.ts": module(`function logger(prefix: string) {
  return importFunc({ in: [{ x: i32 }], out: [] }, (x: number) => console.log(prefix, x));
}
const log = logger("> ");
const run = func({ in: [], out: [] }, () => call(log, { x: 1 }));`),
      },
      /uses "prefix", a variable of an enclosing function/,
    ],
    [
      "state that build code assigns",
      {
        "lib.ts": module(`let calls = 0;
const log = importFunc({ in: [], out: [] }, () => { calls++; });
calls = 10;
const run = func({ in: [], out: [] }, () => call(log));`),
      },
      /"calls" is used by import values, and assigned by code that runs while the module is built/,
    ],
    [
      "wasmati values",
      {
        "lib.ts": module(`const inner = func({ in: [], out: [] }, () => {});
const log = importFunc({ in: [], out: [] }, () => console.log(inner));
const run = func({ in: [], out: [] }, () => call(log));`),
      },
      /import values cannot use wasmati at runtime/,
    ],
    [
      "module paths to other values",
      {
        "host.ts": "export const log = () => {};",
        "lib.ts":
          module(`const log = importFunc({ module: "./host.ts", field: "log", in: [], out: [] }, () => {});
const run = func({ in: [], out: [] }, () => call(log));`),
      },
      /import "\.\/host\.ts" "log": the module's export is not the value imported during development/,
    ],
    [
      "built-in functions",
      {
        "lib.ts": module(`const random = importFunc({ in: [], out: [] }, Math.random);
const run = func({ in: [], out: [] }, () => call(random));`),
      },
      /is a built-in or bound function/,
    ],
  ];
  for (const [name, files, error] of cases) {
    const directory = await project(files);
    try {
      await assert.rejects(build(join(directory, "lib.ts")), error, name);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
