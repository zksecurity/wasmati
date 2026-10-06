import { glob, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runWast } from "./wast-runner.ts";

// Run an external checkout of WebAssembly/spec (wg-3.0), or individual .wast files.
// node --wasm-wide-arithmetic src/test/spec-tests.ts /path/to/spec
if (process.argv.length < 3)
  throw Error("Usage: node src/test/spec-tests.ts <spec-checkout | .wast files...>");
let passed = 0;
let failed = 0;
const files: string[] = [];
for (const input of process.argv.slice(2)) {
  const path = resolve(input);
  if ((await stat(path)).isDirectory()) {
    for await (const file of glob("test/core/**/*.wast", { cwd: path }))
      files.push(resolve(path, file));
  } else files.push(path);
}
if (files.length === 0) throw Error("No WAST files found");
for (const path of files.sort()) {
  try {
    const result = await runWast(await readFile(path, "utf8"));
    passed += result.passed;
    failed += result.failures.length;
    for (const failure of result.failures)
      console.error(`${path}:${failure.line}: ${failure.kind}: ${failure.message}`);
    console.log(`${path}: ${result.passed} passed, ${result.failures.length} failed`);
  } catch (error) {
    failed++;
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`Spec assertions through wasmati: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
