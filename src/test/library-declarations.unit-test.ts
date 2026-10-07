import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsc = join(root, "node_modules/.bin/tsc");

/** A library that exports wasmati values with inferred types, as libraries built on wasmati do. */
const library = `
import {
  func, declareFunc, importFunc, importGlobal, importMemory, importTable, importTag, i32, i64, f64,
  global, constant, memory, table, data, elem, funcref, externref, struct, array, mut, i8, rec,
  refType, funcType, tag, Module, localArray, async, call, block, if_, jsString, stringConstant,
} from "wasmati";

export const log = importFunc({ in: [{ x: i32 }], out: [] }, (x) => console.log(x));
export const slow = importFunc({ in: [{ x: i32 }], out: [i32], async: true }, async (x) => x);
export const base = importGlobal(i64, 1n);
export const shared = importMemory({ min: 1 });
export const memory64 = memory({ min: 1, address: "i64" });
export const imported = importTable({ type: funcref, min: 1 }, new WebAssembly.Table({ element: "anyfunc", initial: 1 }));
export const error = importTag({ in: [i32] });
export const exception = tag({ in: [i64] });
export const point = struct({ x: mut(i32), y: f64 });
export const bytes = array(mut(i8));
export const { node } = rec((types) => ({ node: struct({ next: refType(types.node, { nullable: true }) }) }));
export const binary = funcType({ in: [i32, i32], out: [i32] });
export const counter = global(constant(() => i64.const(0n)), { mutable: true });
export const functions = table({ type: funcref, min: 2 });
export const segment = data({ memory: shared, offset: 0 }, [1]);
export const hello = stringConstant("hello");

export const load = func({ in: [{ address: i64 }], locals: { limbs: localArray(i64, 2), s: externref }, out: [i64] }, ({ address }) => {
  i64.load({ memory: memory64 }, address);
});
export const getX = func({ in: [{ p: refType(point) }], out: [i32] }, ({ p }) => struct.get(point, "x", p));
export const add = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  block({ out: [i32] }, () => i32.const(1));
  if_({ out: [i32] }, () => i32.const(2), () => i32.const(3));
  i32.add();
  call(log, { x });
  i32.add(x, 1);
});
elem({ type: funcref, mode: { table: functions, offset: 0 } }, [add]);
export const mul = declareFunc({ in: [{ x: i64 }, { y: i64 }], locals: { t: i64, u: i32 }, out: [i64] });
mul.define(({ x, y }) => i64.mul(x, y));
export const run = func({ in: [], out: [i32] }, () => call(slow, { x: 1 }));
export const length = func({ in: [{ s: externref }], out: [i32] }, ({ s }) => call(jsString.length, { string: s }));

export const module = Module({ exports: { add, load, getX, mul, length, run: async(run), functions, counter, shared, exception, base } });
`;

test("libraries built on wasmati can emit declarations of inferred types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasmati-library-"));
  try {
    // wasmati as installed: its declarations, behind the package's exports
    const wasmati = join(directory, "node_modules/wasmati");
    await mkdir(wasmati, { recursive: true });
    await copyFile(join(root, "package.json"), join(wasmati, "package.json"));
    const build = spawnSync(
      tsc,
      [
        "-p",
        root,
        "--emitDeclarationOnly",
        "--incremental",
        "false",
        "--outDir",
        join(wasmati, "build"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

    await writeFile(join(directory, "library.mts"), library);
    const check = spawnSync(
      tsc,
      [
        "--ignoreConfig",
        "--declaration",
        "--emitDeclarationOnly",
        "--strict",
        "--target",
        "esnext",
        "--module",
        "nodenext",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        join(root, "node_modules/@types"),
        "library.mts",
      ],
      { encoding: "utf8", cwd: directory },
    );
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    // Declarations name wasmati's types instead of spelling out instruction namespaces like i64.
    const declarations = await readFile(join(directory, "library.d.mts"), "utf8");
    assert.ok(declarations.length < 10_000, `declarations are ${declarations.length} bytes`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
