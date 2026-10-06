import { glob, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { runWast } from "./wast-runner.ts";

// Run the core tests of a WebAssembly/spec checkout (wg-3.0) through wasmati. Fails if any assertion fails.
// node --wasm-wide-arithmetic src/test/spec-tests.ts /path/to/spec
const [root] = process.argv.slice(2);
if (root === undefined || !(await stat(root)).isDirectory())
  throw Error("Usage: node src/test/spec-tests.ts <spec-checkout>");

const files: string[] = [];
for await (const file of glob("test/core/**/*.wast", { cwd: resolve(root) })) files.push(file);
if (files.length === 0) throw Error("No WAST files found");

let passed = 0;
let failed = 0;
for (const file of files.sort()) {
  const path = resolve(root, file);
  const result = await runWast(await readFile(path, "utf8"));
  passed += result.passed;
  failed += result.failures.length;
  for (const failure of result.failures)
    console.error(`${relative(".", path)}:${failure.line}: ${failure.kind}: ${failure.message}`);
  console.log(`${file}: ${result.passed} passed, ${result.failures.length} failed`);
}
console.log(`Spec assertions through wasmati: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
