import assert from "node:assert/strict";
import test from "node:test";
import { Module, func, i32 } from "../index.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { decompileModule } from "../decompile.ts";
import { buildTextModule } from "./text-helpers.ts";
import { TextSyntaxError, UnsupportedTextError } from "../text/lexer.ts";

async function instantiate(source: string, imports: WebAssembly.Imports = {}) {
  const parsed = parseWat(source);
  const rebuilt = await buildTextModule(parsed, imports);
  const { instance } = await rebuilt.instantiate();
  return { parsed, rebuilt, instance };
}

test("WAT reaches named wasmati builders directly, with folded operands in stack order", async () => {
  const { parsed, rebuilt, instance } = await instantiate(`(module $arithmetic
    (func $subtract (export "subtract") (param $x i32) (param $y i32) (result i32)
      (i32.sub (local.get $x) (local.get $y)))
    (func $mix (export "mix") (param $x i64) (result i64) (local $tmp i64)
      local.get $x i64.const 7 i64.add local.tee $tmp local.get $tmp i64.mul)
    (export "alias" (func $subtract)))`);
  assert.equal((instance.exports.subtract as Function)(10, 3), 7);
  assert.equal((instance.exports.mix as Function)(2n), 81n);
  assert.equal(instance.exports.alias, instance.exports.subtract);
  const generated = decompileModule(parsed);
  assert.match(generated, /in: \[\{ x: i32 \}, \{ y: i32 \}\]/);
  assert.match(generated, /local.get\(x\)/);
  assert.doesNotMatch(generated, /fromBytes|resolveArgs/);
  const canonical = parseWat(printWat(parsed));
  assert.deepEqual(canonical, parsed);
  assert.equal(rebuilt.module.names?.module, "arithmetic");
});

test("flat and folded control flow resolve labels, forward calls and recursion", async () => {
  const { instance } = await instantiate(`(module
    (func $entry (export "factorial") (param $n i32) (result i32) local.get $n call $factorial)
    (func $factorial (param $n i32) (result i32)
      (if $done (result i32) (i32.eqz (local.get $n))
        (then (i32.const 1))
        (else (i32.mul (local.get $n) (call $factorial (i32.sub (local.get $n) (i32.const 1)))))))
    (func (export "sum") (param $n i32) (result i32) (local $i i32) (local $acc i32)
      block $exit loop $again
        local.get $i local.get $n i32.ge_u br_if $exit
        local.get $acc local.get $i i32.add local.set $acc
        local.get $i i32.const 1 i32.add local.set $i br $again
      end $again end $exit local.get $acc)
    (func (export "shadow") (result i32)
      block $same (result i32) block $same (result i32) i32.const 42 br $same end end)
    (func (export "table") (param i32) (result i32)
      block $outer (result i32) block $inner (result i32)
        i32.const 9 local.get 0 br_table $inner $outer
      end end))`);
  assert.equal((instance.exports.factorial as Function)(5), 120);
  assert.equal((instance.exports.sum as Function)(10), 45);
  assert.equal((instance.exports.shadow as Function)(), 42);
  assert.equal((instance.exports.table as Function)(1), 9);
});

test("type uses inherit unnamed parameters and resolve later type declarations", async () => {
  const { parsed, instance } = await instantiate(`(module
    (func $id (export "id") (type $identity) local.get 0)
    (func (export "multi") (param i64) (result i64 i32)
      local.get 0 block (param i64) (result i64 i32) i32.const 7 end)
    (type $identity (func (param i64) (result i64))))`);
  assert.equal((instance.exports.id as Function)(-11n), -11n);
  assert.deepEqual((instance.exports.multi as Function)(10n), [10n, 7]);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
});

test("function imports, inline imports, exports, and start preserve native callbacks", async () => {
  let starts = 0;
  const plus = (x: number) => x + 1;
  const { rebuilt, instance } = await instantiate(
    `(module
    (import "env" "tick" (func $tick))
    (func $plus (export "plus") (import "env" "plus") (param $x i32) (result i32))
    (func $start call $tick) (start $start)
    (func (export "twice") (param $x i32) (result i32)
      (call $plus (call $plus (local.get $x)))))`,
    { env: { tick: () => starts++, plus } },
  );
  assert.equal(starts, 1);
  assert.equal(rebuilt.importMap.env.plus, plus);
  assert.equal((instance.exports.twice as Function)(5), 7);
});

test("stack-invalid WAT parses, then fails in wasmati's builder", async () => {
  const parsed = parseWat('(module (func (export "bad") (result i32) i64.const 1))');
  assert.equal(parsed.funcs[0].body[0].name, "i64.const");
  await assert.rejects(buildTextModule(parsed), /expected i32|type mismatch/);
});

test("memory accesses, global references, and table abbreviations reach the public API", async () => {
  const { instance } = await instantiate(`(module
    (type $sig (func (param i32) (result i32)))
    (func $double (type $sig) (param $x i32) (result i32) (i32.mul (local.get $x) (i32.const 2)))
    (table $dispatch (export "dispatch") funcref (elem $double))
    (memory $heap (export "heap") 1 2)
    (global $counter (export "counter") (mut i32) (i32.const 4))
    (func (export "compute") (param $x i32) (result i32)
      i32.const 0 local.get $x i32.store offset=8 align=4
      i32.const 0 i32.load offset=8 align=4 i32.const 0 call_indirect $dispatch (type $sig)
      global.get $counter i32.add)
    (func (export "pages") (result i32) memory.size $heap))`);
  assert.equal((instance.exports.compute as Function)(5), 14);
  assert.equal((instance.exports.pages as Function)(), 1);
  assert.equal((instance.exports.counter as WebAssembly.Global).value, 4);
  assert.equal((instance.exports.dispatch as WebAssembly.Table).length, 1);
  assert.equal(
    new DataView((instance.exports.heap as WebAssembly.Memory).buffer).getInt32(8, true),
    5,
  );
});

test("WAT printers retain memory immediates, floats, and unnamed module abbreviations", async () => {
  const parsed = parseWat(`(memory 1) (global $g f64 (f64.const -0))
    (func $load (export "load") (result f32) i32.const 0 f32.load offset=12 align=4)
    (func (export "rounded") (result f32) f32.const 1.0000000596046447753906250000000001)`);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  const rebuilt = await buildTextModule(parsed);
  const { instance } = await rebuilt.instantiate();
  assert.equal((instance.exports.rounded as Function)(), 1 + 2 ** -23);
});

test("present but malformed fields, duplicate names and unresolved labels reject", () => {
  for (const source of [
    "(module (func (param $x i32 i64)))",
    "(module (func (param $x i32) (local $x i32)))",
    "(module (func $x) (func $x))",
    "(module (func (param i32) (result i32) local.get $missing))",
    "(module (func block $a br $missing end))",
    "(module (func block $a end $b))",
    "(module (func block $a else end))",
    "(module (func i32.const))",
    "(module (func (result))) garbage",
    '(module (func) (import "m" "f" (func)))',
    "(module (type $t (func (param i32))) (func (type $t) (param i64)))",
    "(module (func (if (then) (then))))",
    "(module (func (i32.const 1 2)))",
  ])
    assert.throws(() => parseWat(source), source);
  assert.throws(() => parseWat("(module (func rethrow 0))"), UnsupportedTextError);
});

test("NaN constants keep exact bits through generated builder code", async () => {
  const { parsed, instance } = await instantiate(`(module
    (func (export "f32") (result i32) (i32.reinterpret_f32 (f32.const -nan:0x200001)))
    (func (export "f64") (result i64) (i64.reinterpret_f64 (f64.const nan:0x4000000000001))))`);
  assert.equal((instance.exports.f32 as Function)(), 0xffa00001 | 0);
  assert.equal((instance.exports.f64 as Function)(), 0x7ff4000000000001n);
  assert.match(decompileModule(parsed), /f32\.const\(\{ bits: 0xffa00001 \}\)/);
  assert.match(printWat(parsed), /f32\.const -nan:0x200001$/m);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
});

test("WAT prints readable, indented modules with names as identifiers", () => {
  const source = `(module $m
  (type $t (func (param i32) (result i32)))
  (import "env" "f" (func $f (type $t) (param $x i32) (result i32)))
  (func $g (type $t) (param $y i32) (result i32)
    (local $z i64)
    local.get $y
    if (result i32)
      i32.const 1
    else
      local.get $y
      call $f
    end)
  (memory $mem 1)
  (export "g" (func $g)))
`;
  const parsed = parseWat(source);
  assert.equal(printWat(parsed), source);
  assert.deepEqual(parsed.names?.locals, { 0: { 0: "x" }, 1: { 0: "y", 1: "z" } });
});

test("segments, imports of every kind and their abbreviations", async () => {
  const table = new WebAssembly.Table({ initial: 4, element: "anyfunc" });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const global = new WebAssembly.Global({ value: "i32" }, 1);
  const { parsed, instance } = await instantiate(
    `(module
    (import "env" "table" (table $imported 4 funcref))
    (memory $mem (import "env" "memory") 1)
    (global $base (import "env" "base") i32)
    (table $own funcref (elem $one $two))
    (func $one (result i32) i32.const 1)
    (func $two (result i32) i32.const 2)
    (elem (table $imported) (global.get $base) func $two)
    (elem $passive funcref (ref.func $one) (item ref.null func))
    (elem declare func $one)
    (data (i32.const 16) "\\01\\02" "\\03")
    (data $later "\\2a")
    (func (export "call") (param i32) (result i32) (call_indirect $own (result i32) (local.get 0)))
    (func (export "init") (result i32)
      (memory.init $later (i32.const 0) (i32.const 0) (i32.const 1))
      (table.init $imported $passive (i32.const 0) (i32.const 0) (i32.const 2))
      (i32.load8_u (i32.const 18)))
    (func (export "copied") (result i32) (call_indirect $imported (result i32) (i32.const 0))))`,
    { env: { table, memory, base: global } },
  );
  assert.equal((instance.exports.call as Function)(1), 2);
  assert.equal((table.get(1) as Function)(), 2);
  assert.equal((instance.exports.init as Function)(), 3);
  assert.equal(new Uint8Array(memory.buffer)[0], 0x2a);
  assert.equal((instance.exports.copied as Function)(), 1);
  assert.equal(table.get(1), null);
  assert.deepEqual(
    parsed.elems.map((elem) => (typeof elem.mode === "string" ? elem.mode : elem.mode.table)),
    [1, 0, "passive", "declarative"],
  );
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
});

test("malformed text is distinguished from invalid modules", () => {
  // Invalid: well-formed text whose module fails validation later.
  for (const source of ["(module (func (type 4)))", "(module (func i32.load offset=4294967296))"])
    assert.doesNotThrow(() => parseWat(source), source);
  for (const source of [
    "(module (type (func)) (func (type 1) (param i32)))",
    "(module (func (i32.load align=3)))",
    "(module (func i32.wrong))",
    "(module (func (call_indirect (param $x i32))))",
    "(module (func (block (param $x i32))))",
  ])
    assert.throws(() => parseWat(source), TextSyntaxError, source);
});

test("unreachable code has unknown operand types, which still constrain known ones", async () => {
  const { instance } = await instantiate(`(module
    (func (export "select") (result i32) unreachable select drop i32.const 1)
    (func (export "meet") (result i32)
      (block (result f64)
        (block (result f32) (unreachable) (br_table 0 1 1 (i32.const 1)))
        (drop) (f64.const 0))
      (drop) (i32.const 2))
    (func (export "is_null") (result i32) unreachable ref.is_null))`);
  assert.throws(() => (instance.exports.select as Function)(), WebAssembly.RuntimeError);
  for (const source of [
    "(module (func unreachable i64.const 0 select i32.eqz drop))",
    "(module (func unreachable i32.const 0 ref.is_null drop))",
  ])
    await assert.rejects(buildTextModule(parseWat(source)), /expected|reference/, source);
});

test("repeated export names survive decompilation, so the engine can reject them", async () => {
  const parsed = parseWat('(module (func $f) (export "a" (func $f)) (export "a" (func $f)))');
  assert.match(decompileModule(parsed), /exportEntries: \[\["a", f\], \["a", f\]\]/);
  const rebuilt = await buildTextModule(parsed);
  assert.deepEqual(
    rebuilt.module.exports.map((e) => e.name),
    ["a", "a"],
  );
  await assert.rejects(WebAssembly.compile(rebuilt.toBytes()), /Duplicate export name/);
});

test("modules convert from and to the text format", async () => {
  const module = Module.fromWat(`(module
    (func $double (export "double") (param $x i32) (result i32)
      (i32.mul (local.get $x) (i32.const 2))))`);
  const { instance } = await module.instantiate();
  assert.equal((instance.exports.double as (x: number) => number)(21), 42);
  assert.deepEqual(Module.fromWat(module.toWat()).module, module.module);
  const add = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => i32.add(x, y));
  assert.match(Module({ exports: { add } }).toWat(), /\(export "add" \(func \$add\)\)/);
});

test("custom sections print as @custom annotations", () => {
  const f = func({ in: [], out: [i32] }, () => i32.const(42));
  const module = Module({
    exports: { f },
    customSections: [{ name: "producers", data: [1, 2], after: 0 }],
  });
  assert.match(module.toWat(), /\(@custom "producers" \(before first\) "\\01\\02"\)\)\n$/);
});
