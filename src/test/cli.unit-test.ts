import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Module, func, i32, local } from "../index.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const importPath = fileURLToPath(new URL("../index.ts", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("CLI writes executable TypeScript to stdout or the selected output file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasmati-cli-"));
  try {
    const input = join(directory, "input.wasm");
    const add = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => {
      local.get(x);
      local.get(y);
      i32.add();
    });
    await writeFile(input, Module({ exports: { add } }).toBytes());
    const defaultOutput = run("decompile", input);
    assert.equal(defaultOutput.status, 0, defaultOutput.stderr);
    assert.match(defaultOutput.stdout, /from "wasmati"/);
    assert.equal(defaultOutput.stderr, "");
    for (const option of [undefined, "-o", "--output"]) {
      const output = join(directory, `${option ?? "stdout"}.mts`);
      const result = run(
        "decompile",
        input,
        "--import-path",
        importPath,
        ...(option ? [option, output] : []),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      if (option === undefined) await writeFile(output, result.stdout);
      else assert.equal(result.stdout, "");
      assert.match(await readFile(output, "utf8"), /local.get\(x\)/);
      const { default: createModule } = await import(pathToFileURL(output).href);
      const { instance } = await createModule().instantiate();
      assert.equal(instance.exports.add(20, 22), 42);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI provides help and reports invocation errors without source on stdout", () => {
  for (const args of [[], ["--help"], ["decompile", "-h"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: wasmati <command>/);
    assert.equal(result.stderr, "");
  }
  for (const args of [
    ["unknown"],
    ["decompile"],
    ["decompile", "a", "b"],
    ["decompile", "--unknown"],
    ["decompile", "-o"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0);
  }
});

test("CLI reports file and decoding failures without writing an output file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasmati-cli-"));
  try {
    const input = join(directory, "input.wasm");
    const output = join(directory, "output.ts");
    const missing = run("decompile", input, "-o", output);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT/);
    await writeFile(input, "invalid wasm");
    const invalid = run("decompile", input, "-o", output);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI converts between the binary and text formats, and decompiles text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wasmati-cli-"));
  try {
    const text = join(directory, "input.wat");
    const binary = join(directory, "output.wasm");
    await writeFile(
      text,
      `(module (func $add (export "add") (param $x i32) (param $y i32) (result i32)
        (i32.add (local.get $x) (local.get $y))))`,
    );
    const assembled = run("wasm", text, "-o", binary);
    assert.equal(assembled.status, 0, assembled.stderr);
    const { instance } = await WebAssembly.instantiate(await readFile(binary));
    assert.equal((instance.exports.add as (x: number, y: number) => number)(20, 22), 42);
    const printed = run("wat", binary);
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /\(func \$add .*\(param \$x i32\)/);
    const decompiled = run("decompile", text);
    assert.equal(decompiled.status, 0, decompiled.stderr);
    assert.match(decompiled.stdout, /local\.get\(x\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
