import { readFile } from "node:fs/promises";
import { decompile } from "../src/index.ts";

// node examples/decompile.ts input.wasm [import-path] > output.ts
const [input, importPath = "wasmati"] = process.argv.slice(2);
if (input === undefined) throw Error("Usage: node examples/decompile.ts input.wasm [import-path]");
process.stdout.write(decompile(await readFile(input), { importPath }));
