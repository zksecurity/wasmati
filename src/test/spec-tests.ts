import { glob, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runWast } from "./wast-runner.ts";

// Run spec tests through wasmati. Fails if any assertion fails; modules beyond engine limits are skipped.
// Each argument is a spec checkout, whose core tests (test/core/**/*.wast) run, or a glob of WAST files.
// node --wasm-wide-arithmetic src/test/spec-tests.ts /path/to/spec [/path/to/proposal/test/core/x.wast ...]
const inputs = process.argv.slice(2);
if (inputs.length === 0)
  throw Error("Usage: node src/test/spec-tests.ts <spec-checkout | wast-glob>...");

const files: string[] = [];
for (const input of inputs) {
  const isCheckout = await stat(input).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const pattern = isCheckout ? join(input, "test/core/**/*.wast") : input;
  const matches = await Array.fromAsync(glob(pattern));
  if (matches.length === 0) throw Error(`No WAST files found for ${input}`);
  files.push(...matches.sort());
}

let passed = 0;
let failed = 0;
let skipped = 0;
for (const file of files) {
  const path = resolve(file);
  const result = await runWast(await readFile(path, "utf8"));
  passed += result.passed;
  failed += result.failures.length;
  skipped += result.skipped.length;
  for (const failure of result.failures)
    console.error(`${relative(".", path)}:${failure.line}: ${failure.kind}: ${failure.message}`);
  for (const skip of result.skipped)
    console.error(`${relative(".", path)}:${skip.line}: skipped ${skip.kind}: ${skip.message}`);
  console.log(`${relative(".", path)}: ${result.passed} passed, ${result.failures.length} failed`);
}
console.log(
  `Spec assertions through wasmati: ${passed} passed, ${failed} failed, ${skipped} skipped for engine limits`,
);
if (failed !== 0) process.exitCode = 1;
