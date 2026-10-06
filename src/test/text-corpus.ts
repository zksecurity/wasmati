import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tokenize } from "../text/lexer.ts";
import { Script } from "../text/text.ts";

// Syntax-only smoke test against an external checkout of WebAssembly/spec at wg-3.0.
// This does not validate modules or execute WAST assertions. Malformed quoted modules stay strings.
// Usage: node src/test/text-corpus.ts /path/to/spec
const root = process.argv[2];
if (root === undefined) throw Error("Usage: node src/test/text-corpus.ts /path/to/spec");
let passed = 0;
let failed = 0;
const spellings = (source: string) => tokenize(source).map(({ kind, text }) => ({ kind, text }));
for await (const file of glob("test/core/**/*.wast", { cwd: resolve(root) })) {
  try {
    const source = await readFile(resolve(root, file), "utf8");
    const printed = Script.toText(Script.fromText(source));
    assert.deepEqual(spellings(printed), spellings(source));
    passed++;
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}
if (passed + failed === 0) throw Error("No test/core/**/*.wast files found");
console.log(
  `Text syntax roundtrip: ${passed} passed, ${failed} failed. WAST assertions were not run.`,
);
if (failed !== 0) process.exitCode = 1;
