import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Module as BinaryModule } from "../module-binable.ts";
import { parseWat } from "../text/wat.ts";
import {
  decompile,
  Module,
  declareFunc,
  i32,
  i64,
  local,
  call,
  constant,
  data,
  elem,
  func,
  funcref,
  memory,
  table,
} from "../index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const importPath = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Rebuild a module in the text format, by default with the names of its identifiers. */
async function rebuild(wat: string, imports: WebAssembly.Imports = {}, debugNames = true) {
  const { names, ...module } = parseWat(wat);
  const parsed = debugNames && names !== undefined ? { ...module, names } : module;
  return rebuildBytes(Uint8Array.from(BinaryModule.toBytes(parsed)), imports);
}

async function rebuildBytes(bytes: Uint8Array, imports: WebAssembly.Imports = {}) {
  const source = decompile(bytes, { importPath });
  assert.equal(source, decompile(bytes, { importPath }), "source is deterministic");
  assert.doesNotMatch(source, /fromBytes|resolveArgs|defaultCtx|as any/);
  const directory = await mkdtemp(join(tmpdir(), "wasmati-decompile-"));
  try {
    const path = join(directory, "generated.mts");
    await writeFile(path, source);
    const check = spawnSync(
      join(root, "node_modules/.bin/tsc"),
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--target",
        "esnext",
        "--module",
        "nodenext",
        "--allowImportingTsExtensions",
        "--erasableSyntaxOnly",
        "--verbatimModuleSyntax",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        join(root, "node_modules/@types"),
        path,
      ],
      { encoding: "utf8", cwd: root },
    );
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}\n${source}`);
    const generated = await import(pathToFileURL(path).href);
    const module = generated.default(imports) as Module;
    const compiled = await WebAssembly.instantiate(module.toBytes(), imports);
    const original = await WebAssembly.instantiate(Uint8Array.from(bytes), imports);
    return { source, module, instance: compiled.instance, original: original.instance };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function invoke(instance: WebAssembly.Instance, name: string, ...args: unknown[]) {
  return (instance.exports[name] as Function)(...args);
}

test("decompiles forward calls, self recursion, mutual recursion and unused functions", async () => {
  const result = await rebuild(`(module $recursive
    (func $entry (export "factorial") (param $n i32) (result i32) local.get $n call $factorial)
    (func $factorial (param $n i32) (result i32)
      local.get $n i32.eqz
      if (result i32) i32.const 1
      else local.get $n local.get $n i32.const 1 i32.sub call $factorial i32.mul end)
    (func $even (export "even") (param i32) (result i32)
      local.get 0 i32.eqz if (result i32) i32.const 1
      else local.get 0 i32.const 1 i32.sub call $odd end)
    (func $odd (param i32) (result i32)
      local.get 0 i32.eqz if (result i32) i32.const 0
      else local.get 0 i32.const 1 i32.sub call $even end)
    (func $unused (result i32) i32.const 42))`);
  assert.match(result.source, /declareFunc\(/);
  assert.match(result.source, /local.get\(n/);
  assert.match(result.source, /call\(factorial\)/);
  assert.equal(result.module.module.funcs.length, 5);
  for (let n = 0; n < 9; n++) {
    assert.equal(invoke(result.instance, "factorial", n), invoke(result.original, "factorial", n));
    assert.equal(invoke(result.instance, "even", n), invoke(result.original, "even", n));
  }
});

test("decompiles mixed local indices, loops, branches, multi-value blocks and br_table", async () => {
  const result = await rebuild(`(module
    (func (export "sum") (param $n i32) (result i32)
      (local $acc i32) (local $wide i64) (local $i i32)
      i64.const -7 local.set $wide
      block loop
        local.get $i local.get $n i32.ge_u br_if 1
        local.get $acc local.get $i i32.add local.set $acc
        local.get $i i32.const 1 i32.add local.set $i br 0
      end end local.get $acc)
    (func (export "multi") (param i64) (result i64 i32)
      local.get 0 block (param i64) (result i64 i32) i32.const 7 end)
    (func (export "branch") (param i32) (result i32)
      block (result i32) block (result i32)
        i32.const 42 local.get 0 br_table 0 1
      end end))`);
  for (const n of [0, 1, 5, 25])
    assert.equal(invoke(result.instance, "sum", n), invoke(result.original, "sum", n));
  assert.deepEqual(invoke(result.instance, "multi", -10n), [-10n, 7]);
  for (const n of [0, 1, 100]) assert.equal(invoke(result.instance, "branch", n), 42);
});

test("retains imports, imported object identity, globals, start and aliases", async () => {
  let starts = 0;
  const counter = new WebAssembly.Global({ value: "i32", mutable: true }, 10);
  const imports = {
    env: {
      counter,
      tick: () => {
        starts++;
      },
      plus: (x: number) => x + 1,
    },
  };
  const result = await rebuild(
    `(module
    (import "env" "counter" (global $counter (mut i32)))
    (import "env" "tick" (func $tick))
    (import "env" "plus" (func $plus (param i32) (result i32)))
    (start $tick)
    (global $answer (export "answer") i64 (i64.const -42))
    (func $increment (export "increment") (param i32) (result i32)
      local.get 0 global.get $counter i32.add call $plus global.set $counter global.get $counter)
    (export "alias" (func $increment)))`,
    imports,
  );
  assert.equal(starts, 2);
  assert.equal(result.module.importMap.env.counter, counter);
  assert.equal(result.module.importMap.env.plus, imports.env.plus);
  assert.equal(result.instance.exports.increment, result.instance.exports.alias);
  assert.equal(invoke(result.instance, "increment", 5), 16);
  assert.equal(counter.value, 16);
  assert.equal((result.instance.exports.answer as WebAssembly.Global).value, -42n);
  counter.value = 10;
  assert.equal(invoke(result.original, "increment", 5), 16);
});

test("decompiles active/passive data, imported memory and bulk memory instructions", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const result = await rebuild(
    `(module
    (import "env" "memory" (memory 1))
    (data (i32.const 8) "abc") (data $passive "XYZ")
    (func (export "read") (result i32) i32.const 8 i32.load8_u)
    (func (export "init")
      i32.const 20 i32.const 0 i32.const 3 memory.init $passive data.drop $passive
      i32.const 24 i32.const 20 i32.const 3 memory.copy
      i32.const 27 i32.const 33 i32.const 2 memory.fill)
    (export "memory" (memory 0)))`,
    { env: { memory } },
  );
  assert.equal(result.instance.exports.memory, memory);
  assert.equal(invoke(result.instance, "read"), 97);
  invoke(result.instance, "init");
  assert.equal(new TextDecoder().decode(new Uint8Array(memory.buffer, 20, 9)), "XYZ\0XYZ!!");
  assert.throws(() => invoke(result.instance, "init"), WebAssembly.RuntimeError);
  // The active data-only case has no data-count section in WABT output.
  const active = await rebuild(`(module (memory (export "memory") 1) (data (i32.const 0) "abc"))`);
  assert.equal(
    new Uint8Array((active.instance.exports.memory as WebAssembly.Memory).buffer)[1],
    98,
  );
});

test("decompiles imported tables, element segments, indirect calls and table.copy", async () => {
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 3 });
  const result = await rebuild(
    `(module
    (type $op (func (param i32) (result i32)))
    (import "env" "table" (table 3 funcref))
    (func $double (type $op) local.get 0 i32.const 2 i32.mul)
    (elem (i32.const 0) $double)
    (elem $passive func $double)
    (func (export "indirect") (param i32) (result i32)
      local.get 0 i32.const 0 call_indirect (type $op))
    (func (export "init") i32.const 1 i32.const 0 i32.const 1 table.init $passive elem.drop $passive
      i32.const 2 i32.const 1 i32.const 1 table.copy)
    (func (export "size") (result i32) table.size)
    (export "table" (table 0)))`,
    { env: { table } },
  );
  assert.equal(result.instance.exports.table, table);
  assert.equal(invoke(result.instance, "indirect", 21), 42);
  invoke(result.instance, "init");
  assert.equal(table.get(2)(5), 10);
  assert.equal(invoke(result.instance, "size"), 3);
});

test("decompiles SIMD immediates, floats, missing names and hostile debug/export names", async () => {
  const result = await rebuild(
    `(module
    (memory 1)
    (func $vector (export "vector") (result i32)
      v128.const i32x4 1 2 3 4 v128.const i32x4 5 6 7 8
      i8x16.shuffle 0 1 2 3 16 17 18 19 8 9 10 11 24 25 26 27
      i32x4.extract_lane 1)
    (func (export "float") (result f64) f64.const -0)
    (func (export "inf") (result f64) f64.const inf)
    (func (export "nan") (result f32) f32.const nan)
    (func (export "__proto__") (param i32) (result i32) local.get 0))`,
    {},
    false,
  );
  assert.equal(invoke(result.instance, "vector"), 5);
  assert.equal(Object.is(invoke(result.instance, "float"), -0), true);
  assert.equal(invoke(result.instance, "inf"), Infinity);
  assert.ok(Number.isNaN(invoke(result.instance, "nan")));
  assert.equal(invoke(result.instance, "__proto__", 42), 42);
  const f = declareFunc({
    name: 'bad-name"\n',
    in: [{ ["__proto__"]: i32 }, { ["i32"]: i32 }],
    locals: { ["x-y"]: i64 },
    out: [i32],
  });
  f.define(({ __proto__: x, i32: y }, { "x-y": z }) => {
    i64.const(1n);
    local.set(z);
    local.get(x);
    local.get(y);
    i32.add();
  });
  const named = await rebuildBytes(
    Module({
      exports: { 'strange"\n': f },
      customSections: [{ name: "opaque", data: new Uint8Array([0, 255]) }],
    }).toBytes(),
  );
  assert.equal(invoke(named.instance, 'strange"\n', 20, 22), 42);
  assert.equal(named.module.module.names?.functions?.[0], 'bad-name"\n');
  assert.deepEqual(named.module.module.customSections?.[0].data, new Uint8Array([0, 255]));
});

test("decompiles wide arithmetic through the public API", async () => {
  const f = declareFunc({ in: [{ low: i64 }, { high: i64 }], out: [i64, i64] });
  f.define(({ low, high }) => {
    local.get(low);
    local.get(high);
    i64.const(1n);
    i64.const(0n);
    i64.add128();
  });
  const result = await rebuildBytes(Module({ exports: { add: f } }).toBytes());
  assert.match(result.source, /i64.add128\(\)/);
  assert.deepEqual(invoke(result.instance, "add", -1n, 0n), [0n, 1n]);
});

test("function declarations require a definition, preserve identity and cannot be redefined", () => {
  const f = declareFunc({ name: "pending", in: [{ x: i32 }], out: [i32] });
  assert.throws(() => Module({ exports: { f } }), /not defined/);
  f.define(({ x }) => {
    local.get(x);
  });
  assert.throws(() => f.define(() => {}), /already defined/);
  const g = declareFunc({ in: [{ x: i32 }], out: [i32] });
  g.define(({ x }) => {
    local.get(x);
    call(f);
  });
  assert.equal(g.deps[0], f);
  assert.equal(Module({ exports: {}, dependencies: [f, g] }).module.funcs.length, 2);
});

test("decompiles memory alignment, SIMD memory lanes, reference selects and atomic RMW", async () => {
  const result = await rebuild(`(module
    (memory (export "memory") 1 1 shared)
    (func (export "lanes") (result i32)
      i32.const 8 i32.const 42 i32.store offset=4 align=2
      i32.const 12 v128.const i32x4 0 0 0 0 v128.load32_lane 1
      i32x4.extract_lane 1)
    (func (export "add") (param i32) (result i32)
      i32.const 0 local.get 0 i32.atomic.rmw.add atomic.fence)
    (func (export "choose") (param externref externref i32) (result externref)
      local.get 0 local.get 1 local.get 2 select (result externref)))`);
  assert.equal(invoke(result.instance, "lanes"), 42);
  assert.equal(invoke(result.instance, "add", 3), 0);
  assert.equal(invoke(result.instance, "add", 4), 3);
  assert.equal(invoke(result.instance, "choose", "a", "b", 1), "a");
  assert.equal(invoke(result.instance, "choose", "a", "b", 0), "b");
});

test("segment offsets with arithmetic decompile to TypeScript that type-checks", async () => {
  const offset = constant(() => i32.add(1, 2));
  const mem = memory({ min: 1 });
  data({ memory: mem, offset }, [42]);
  const load = func({ in: [], out: [i32] }, () => i32.load8_u({}, 3));
  const t = table({ type: funcref, min: 4 });
  elem({ type: funcref, mode: { table: t, offset } }, [load]);
  const bytes = Module({ exports: { load, mem, t } }).toBytes();
  const { source, instance } = await rebuildBytes(bytes);
  assert.match(source, /i32\.add/);
  assert.equal(invoke(instance, "load"), 42);
});
