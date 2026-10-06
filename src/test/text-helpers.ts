import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule, type Module as ModuleValue } from "../module-binable.ts";
import type { Module } from "../index.ts";
import { TextSyntaxError, type List, type Node } from "../text/lexer.ts";
import type { Expression } from "../text/text.ts";
import { ModuleSyntax, Wat } from "../text/module.ts";
import type { ModuleSource } from "../text/wast.ts";

/** Exercise generated wasmati builders, rather than feeding the parsed module straight to its binary codec. */
export async function buildTextModule(
  module: ModuleValue,
  imports: WebAssembly.Imports = {},
): Promise<Module> {
  return (await loadTextFactory(module))(imports);
}

/** Loading and generation must succeed before an assert_invalid test checks builder validation. */
export async function loadTextFactory(
  module: ModuleValue,
): Promise<(imports?: WebAssembly.Imports) => Module> {
  const source = decompileModule(module, {
    importPath: fileURLToPath(new URL("../index.ts", import.meta.url)),
  });
  const directory = await mkdtemp(join(tmpdir(), "wasmati-text-"));
  try {
    const path = join(directory, "module.mts");
    await writeFile(path, source);
    const generated = await import(pathToFileURL(path).href);
    return generated.default;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Decode a script module: text through the WAT parser, binary through wasmati's binary decoder. */
export function readModule(source: ModuleSource): ModuleValue {
  if (source.kind === "binary") return BinaryModule.fromBytes(source.bytes);
  if (source.kind === "quote") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    } catch {
      throw new TextSyntaxError("malformed UTF-8 encoding");
    }
    return Wat.fromText(text);
  }
  return ModuleSyntax.decode([expression(source.list)], 0)[0];
}

function expression(node: Node): Expression {
  return node.kind === "list" ? (node as List).items.map(expression) : node;
}
