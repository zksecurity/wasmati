import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decompileModule } from "../decompile.ts";
import type { Module as ModuleValue } from "../module-binable.ts";
import type { Module } from "../index.ts";

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
