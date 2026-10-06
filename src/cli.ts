#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { decompile } from "./index.ts";

const usage = `Usage: wasmati decompile <input.wasm> [-o <output.ts>]

Decompile Wasm into stack-style wasmati TypeScript. Writes to stdout unless -o is supplied.

Options:
  -o, --output <file>       Write the generated TypeScript to a file
      --import-path <path> Import wasmati from this path (default: wasmati)
  -h, --help               Show this help
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      "import-path": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(usage);
    return;
  }
  const [command, input] = positionals;
  if (command !== "decompile") throw Error(`Unknown command ${JSON.stringify(command)}.\n${usage}`);
  if (input === undefined || positionals.length !== 2) throw Error(usage);
  const source = decompile(await readFile(input), { importPath: values["import-path"] });
  if (values.output === undefined) process.stdout.write(source);
  else await writeFile(values.output, source, "utf8");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
