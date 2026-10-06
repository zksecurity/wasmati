import { glob, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runWast } from "./wast-runner.ts";

// Run the core tests of a WebAssembly/spec checkout (wg-3.0) through wasmati.
// node --wasm-wide-arithmetic src/test/spec-tests.ts /path/to/spec [--baseline file [--update]]
// With a baseline, fail if any file passes fewer assertions than recorded; --update records the current counts.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { baseline: { type: "string" }, update: { type: "boolean", default: false } },
});
const [root] = positionals;
if (root === undefined || positionals.length > 1 || !(await stat(root)).isDirectory())
  throw Error("Usage: node src/test/spec-tests.ts <spec-checkout> [--baseline file [--update]]");

const files: string[] = [];
for await (const file of glob("test/core/**/*.wast", { cwd: resolve(root) })) files.push(file);
if (files.length === 0) throw Error("No WAST files found");

const counts: Record<string, number> = {};
let passed = 0;
let failed = 0;
for (const file of files.sort()) {
  const path = resolve(root, file);
  const result = await runWast(await readFile(path, "utf8"));
  counts[file] = result.passed;
  passed += result.passed;
  failed += result.failures.length;
  for (const failure of result.failures)
    console.error(`${relative(".", path)}:${failure.line}: ${failure.kind}: ${failure.message}`);
  console.log(`${file}: ${result.passed} passed, ${result.failures.length} failed`);
}

if (values.baseline !== undefined) {
  if (values.update) {
    await writeFile(values.baseline, JSON.stringify(counts, null, 2) + "\n");
  } else {
    const baseline: Record<string, number> = JSON.parse(await readFile(values.baseline, "utf8"));
    const regressions = Object.entries(baseline).filter(([file, n]) => (counts[file] ?? 0) < n);
    const improvements = Object.entries(counts).filter(([file, n]) => n > (baseline[file] ?? 0));
    for (const [file, n] of regressions)
      console.log(`Regression: ${file} passed ${counts[file] ?? 0}, baseline ${n}`);
    if (improvements.length > 0)
      console.log(`${improvements.length} files improved: update the baseline with --update`);
    if (regressions.length > 0) process.exitCode = 1;
  }
}
console.log(`Spec assertions through wasmati: ${passed} passed, ${failed} failed`);
