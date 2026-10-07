import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import * as wasmati from "../index.ts";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { placeholders, type Result } from "./wast-runner.ts";

export { runJsApi };

const loaded = new Set<string>();

/** A feature that wasmati does not support, whose tests are skipped. */
class Unsupported extends Error {}

/**
 * Run a JS API test of the spec (`test/js-api/**\/*.any.js`) through wasmati. Every module the test
 * compiles is decoded, decompiled to builder code, rebuilt, and compiled from the rebuilt bytes. Where a
 * test compares builtins with a JS polyfill, wasmati's JS string imports replace the polyfill. Promise
 * tests run after the script, in order.
 */
async function runJsApi(path: string): Promise<Result> {
  const result: Result = { passed: 0, failures: [], skipped: [] };
  const source = readFileSync(path, "utf8");
  const fail = (name: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Unsupported) {
      result.skipped.push({
        command: result.passed + result.failures.length + 1,
        line: 0,
        kind: name,
        message,
      });
      return;
    }
    result.failures.push({
      command: result.passed + result.failures.length + 1,
      line: 0,
      kind: name,
      message,
    });
  };
  const run = (name: string, body: () => void) => {
    try {
      body();
      result.passed++;
    } catch (error) {
      fail(name, error);
    }
  };
  const nextName = () => `test ${result.passed + result.failures.length + promiseTests.length + 1}`;
  const promiseTests: [name: string, body: (t: object) => Promise<void>][] = [];
  // Checks that tests start without awaiting them, like `promise_rejects`, belong to the running test.
  let pending: Promise<void>[] = [];
  const throwsLike = (expected: unknown, error: unknown, message: string) => {
    const constructor =
      typeof expected === "function" ? expected : (expected as object).constructor;
    if (!(error instanceof (constructor as Function)))
      throw Error(`expected ${(constructor as Function).name}, got ${error} ${message}`);
  };
  const assertThrows = (expected: unknown, body: () => void, message = "") => {
    try {
      body();
    } catch (error) {
      return throwsLike(expected, error, message);
    }
    throw Error(`expected an exception, but nothing was thrown ${message}`);
  };
  const harness = {
    test: (body: () => void, name = nextName()) => run(name, body),
    promise_test: (body: (t: object) => Promise<void>, name = nextName()) => {
      promiseTests.push([name, body]);
    },
    setup: (body: () => void) => run("setup", body),
    assert_true: (value: unknown, message = "") => {
      if (value !== true) throw Error(`expected true ${message}`);
    },
    assert_false: (value: unknown, message = "") => {
      if (value !== false) throw Error(`expected false ${message}`);
    },
    assert_equals: (actual: unknown, expected: unknown, message = "") => {
      if (!Object.is(actual, expected))
        throw Error(`expected ${String(expected)}, got ${String(actual)} ${message}`);
    },
    assert_unreached: (message = "") => {
      throw Error(`reached unreachable code ${message}`);
    },
    // The legacy form takes the expected constructor, or an instance of it, then the body.
    assert_throws: assertThrows,
    assert_throws_js: (constructor: Function, body: () => void, message = "") => {
      try {
        body();
      } catch (error) {
        if ((error as Error).constructor === constructor) return;
        throw Error(`expected ${constructor.name}, got ${error} ${message}`);
      }
      throw Error(`expected ${constructor.name}, but nothing was thrown ${message}`);
    },
    promise_rejects: (_t: object, expected: unknown, promise: Promise<unknown>, message = "") => {
      const check = promise.then(
        () => {
          throw Error(`expected a rejection ${message}`);
        },
        (error) => throwsLike(expected, error, message),
      );
      pending.push(check);
      return check;
    },
  };
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(harness).map((key) => [key, globals[key]]));
  Object.assign(globals, harness);
  const original = {
    Module: WebAssembly.Module,
    compile: WebAssembly.compile,
    instantiate: WebAssembly.instantiate,
  };
  WebAssembly.Module = class extends original.Module {
    constructor(bytes: BufferSource, options?: WebAssembly.CompileOptions) {
      super(throughWasmati(bytes), options as any);
    }
  } as typeof WebAssembly.Module;
  WebAssembly.compile = ((bytes: BufferSource, options?: WebAssembly.CompileOptions) =>
    original.compile(throughWasmati(bytes), options as any)) as typeof WebAssembly.compile;
  WebAssembly.instantiate = ((source: BufferSource | WebAssembly.Module, ...rest: any[]) =>
    (original.instantiate as Function)(
      source instanceof original.Module ? source : throughWasmati(source),
      ...rest,
    )) as typeof WebAssembly.instantiate;
  try {
    // Scripts listed in `// META: script=/wasm/jsapi/...` run first, in the same global scope. They
    // are in the test suite's `js-api` directory.
    const root = path.slice(0, path.lastIndexOf("/js-api/") + "/js-api".length);
    for (const [, script] of source.matchAll(/^\/\/ META: script=\/wasm\/jsapi\/(.*)$/gm)) {
      // Scripts declare global constants, so they run once per process.
      if (!loaded.has(script))
        runInThisContext(readFileSync(join(root, script), "utf8"), { filename: script });
      loaded.add(script);
      if (script.endsWith("polyfill.js")) globals.polyfillImports = jsStringImports();
    }
    runInThisContext(source, { filename: path });
  } catch (error) {
    fail("script", error);
  }
  try {
    for (const [name, body] of promiseTests) {
      pending = [];
      try {
        await body({});
        await Promise.all(pending);
        result.passed++;
      } catch (error) {
        fail(name, error);
      }
    }
  } finally {
    Object.assign(WebAssembly, original);
    Object.assign(globals, saved);
  }
  return result;
}

/** The module's bytes after decoding, decompiling, and building them with wasmati. */
function throughWasmati(bytes: BufferSource): Uint8Array<ArrayBuffer> {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  let module: BinaryModule;
  try {
    module = BinaryModule.fromBytes(view);
  } catch (error) {
    // try, catch, rethrow, delegate and catch_all
    if (/^invalid opcode "(6|7|9|24|25)"$/.test(String((error as Error).message)))
      throw new Unsupported("legacy exception handling (try, catch) is not supported");
    throw error;
  }
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
