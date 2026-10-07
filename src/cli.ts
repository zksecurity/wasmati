#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { decompile, Module } from "./index.ts";

const usage = `Usage: wasmati <command> <input> [-o <output>]

Inputs may be Wasm binaries or the WebAssembly text format. Writes to stdout unless -o is supplied.

Commands:
  decompile <input>         Decompile into stack-style wasmati TypeScript
  wat <input>               Print in the WebAssembly text format
  wasm <input>              Assemble into a Wasm binary
  build <input.ts>          Build a file that default-exports a Module into <name>.wasm, which JS
                            imports directly, with types and, for inline imports, <name>.host.js.
                            -o sets the output directory.

Options:
  -o, --output <file>       Write the output to a file
      --import-path <path> Import wasmati from this path in decompiled code (default: wasmati)
  -h, --help               Show this help
`;

const commands = ["decompile", "wat", "wasm", "build"];

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
  if (!commands.includes(command))
    throw Error(`Unknown command ${JSON.stringify(command)}.\n${usage}`);
  if (input === undefined || positionals.length !== 2) throw Error(usage);
  if (command === "build") {
    const { build } = await import("./build/build.ts");
    const output = await build(input, { outDir: values.output });
    for (const file of Object.values(output)) console.log(file);
    return;
  }
  const bytes = await readFile(input);
  // Wasm binaries start with the magic bytes "\0asm"; anything else is text.
  const source = isBinary(bytes) ? bytes : bytes.toString("utf8");
  const module = () =>
    typeof source === "string" ? Module.fromWat(source) : Module.fromBytes(source);
  const output =
    command === "decompile"
      ? decompile(source, { importPath: values["import-path"] })
      : command === "wat"
        ? module().toWat() + "\n"
        : module().toBytes();
  if (values.output === undefined) process.stdout.write(output);
  else await writeFile(values.output, output);
}

function isBinary(bytes: Uint8Array) {
  return [0x00, 0x61, 0x73, 0x6d].every((byte, i) => bytes[i] === byte);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
