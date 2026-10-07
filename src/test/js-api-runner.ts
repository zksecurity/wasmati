import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { runInThisContext } from "node:vm";
import * as wasmati from "../index.ts";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { placeholders, type Result } from "./wast-runner.ts";

export { runJsApi };

const loaded = new Set<string>();

/**
 * Run a JS API test of the spec (`test/js-api/**\/*.any.js`) through wasmati. Every module the test
 * compiles is decoded, decompiled to builder code, rebuilt, and compiled from the rebuilt bytes. Where a
 * test compares builtins with a JS polyfill, wasmati's JS string imports replace the polyfill.
 */
function runJsApi(path: string): Result {
  const result: Result = { passed: 0, failures: [], skipped: [] };
  const source = readFileSync(path, "utf8");
  let current = "";
  const run = (name: string, body: () => void) => {
    try {
      body();
      result.passed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({
        command: result.passed + result.failures.length + 1,
        line: 0,
        kind: name,
        message,
      });
    }
  };
  const Original = WebAssembly.Module;
  const harness = {
    test: (body: () => void, name = `test ${result.passed + result.failures.length + 1}`) =>
      run(`${current}${name}`, body),
    setup: (body: () => void) => run("setup", body),
    assert_true: (value: unknown, message = "") => {
      if (value !== true) throw Error(`expected true ${message}`);
    },
    assert_equals: (actual: unknown, expected: unknown, message = "") => {
      if (!Object.is(actual, expected))
        throw Error(`expected ${String(expected)}, got ${String(actual)} ${message}`);
    },
    assert_throws_js: (constructor: Function, body: () => void, message = "") => {
      try {
        body();
      } catch (error) {
        if ((error as Error).constructor === constructor) return;
        throw Error(`expected ${constructor.name}, got ${error} ${message}`);
      }
      throw Error(`expected ${constructor.name}, but nothing was thrown ${message}`);
    },
  };
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(harness).map((key) => [key, globals[key]]));
  Object.assign(globals, harness);
  WebAssembly.Module = class extends Original {
    constructor(bytes: BufferSource, options?: WebAssembly.CompileOptions) {
      super(throughWasmati(bytes), options as any);
    }
  } as typeof WebAssembly.Module;
  try {
    // Scripts listed in `// META: script=/wasm/jsapi/...` run first, in the same global scope.
    const root = join(dirname(path), path.includes("/js-string/") ? ".." : ".");
    for (const [, script] of source.matchAll(/^\/\/ META: script=\/wasm\/jsapi\/(.*)$/gm)) {
      // Scripts declare global constants, so they run once per process.
      if (!loaded.has(script))
        runInThisContext(readFileSync(join(root, script), "utf8"), { filename: script });
      loaded.add(script);
      if (script.endsWith("polyfill.js")) globals.polyfillImports = jsStringImports();
    }
    current = "";
    runInThisContext(source, { filename: path });
  } catch (error) {
    run("script", () => {
      throw error;
    });
  } finally {
    WebAssembly.Module = Original;
    Object.assign(globals, saved);
  }
  return result;
}

/** The module's bytes after decoding, decompiling, and building them with wasmati. */
function throughWasmati(bytes: BufferSource): Uint8Array<ArrayBuffer> {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const module = BinaryModule.fromBytes(view);
  const source = decompileModule(module, { importPath: "wasmati" });
  // Evaluate the generated module synchronously, with wasmati in scope instead of imported.
  const body = stripTypeScriptTypes(source)
    .replace(/^import \{([^}]*)\} from "wasmati";/, "const {$1} = wasmati;")
    .replace("export default function", "return function");
  const factory = new Function("wasmati", body)(wasmati) as (imports: object) => wasmati.Module;
  return Uint8Array.from(factory(placeholders(module, {})).toBytes());
}

/** wasmati's JS functions of the JS string builtins, in place of a polyfill. */
function jsStringImports() {
  return Object.fromEntries(
    Object.entries(wasmati.jsString).flatMap(([name, value]) =>
      "kind" in value && value.kind === "importFunction" ? [[name, value.value]] : [],
    ),
  );
}
