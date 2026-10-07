import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  i32,
  i64,
  local,
  refType,
  struct,
  array,
  funcType,
  rec,
  mut,
  i8,
  anyref,
  eqref,
  structref,
  table,
  funcref,
  call_indirect,
  elem,
  Const,
  Dependency,
} from "../index.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { buildTextModule } from "./text-helpers.ts";
import { isSubtype } from "../types.ts";

test("recursive types refer to their group by name, and keys name the types and fields", () => {
  const { node } = rec((types) => ({
    node: struct({ value: mut(i32), next: refType(types.node, { nullable: true }) }),
  }));
  const keep = func(
    { in: [{ n: refType(node, { nullable: true }) }], out: [refType(node, { nullable: true })] },
    ({ n }) => local.get(n),
  );
  const { module } = Module({ exports: { keep } });
  assert.deepEqual(module.types[0], {
    struct: [
      { type: "i32", mutable: true },
      { type: { ref: 0, nullable: true }, mutable: false },
    ],
  });
  assert.equal(module.recGroups, undefined);
  assert.deepEqual(module.names?.types, { 0: "node" });
  assert.deepEqual(module.names?.fields, { 0: { 0: "value", 1: "next" } });
});

test("equivalent recursion groups are one group, and groups precede the types referring to them", () => {
  const group = () =>
    rec((types) => ({
      even: struct({ next: refType(types.odd, { nullable: true }) }),
      odd: struct({ next: refType(types.even, { nullable: true }) }),
    }));
  const a = group();
  const b = group();
  const bytes = array(mut(i8));
  const pair = struct({ first: refType(a.even), second: refType(b.even), data: refType(bytes) });
  const { module } = Module({ exports: {}, dependencies: [pair] });
  assert.deepEqual(module.recGroups, [2, 1, 1]);
  assert.deepEqual(
    (module.types[3] as { struct: { type: unknown }[] }).struct.map((f) => f.type),
    [
      { ref: 0, nullable: false },
      { ref: 0, nullable: false },
      { ref: 2, nullable: false },
    ],
  );
});

test("declared supertypes and the abstract hierarchy define subtyping", () => {
  const base = struct({ x: i32 }, { final: false });
  const derived = struct({ x: i32, y: i64 }, { supertype: base });
  const other = struct({ x: i32 });
  const ref = (type: Dependency.Type, nullable = false) => refType(type, { nullable }).kind;
  assert.ok(isSubtype(ref(derived), ref(base)));
  assert.ok(isSubtype(ref(derived), structref.kind));
  assert.ok(isSubtype(ref(derived), eqref.kind));
  assert.ok(isSubtype(ref(derived), anyref.kind));
  assert.ok(isSubtype("nullref", ref(derived, true)));
  assert.ok(!isSubtype(ref(base), ref(derived)));
  assert.ok(!isSubtype(ref(other), ref(base)));
  assert.ok(!isSubtype(ref(derived, true), ref(base)));
  assert.ok(!isSubtype("funcref", anyref.kind));
  const upcast = func({ in: [{ d: refType(derived) }], out: [refType(base)] }, ({ d }) =>
    local.get(d),
  );
  assert.throws(() =>
    func({ in: [{ b: refType(base) }], out: [refType(derived)] }, ({ b }) => local.get(b)),
  );
  Module({ exports: { upcast } });
});

test("functions and indirect calls may use defined function types", async () => {
  const base = funcType({ in: [i32], out: [i32] }, { final: false });
  const sub = funcType({ in: [i32], out: [i32] }, { supertype: base });
  const double = func({ in: [{ x: i32 }], out: [i32], type: sub }, ({ x }) => i32.add(x, x));
  const t = table({ type: funcref, min: 1 });
  elem({ type: funcref, mode: { table: t, offset: Const.i32(0) } }, [Const.refFunc(double)]);
  const call = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
    local.get(x);
    i32.const(0);
    call_indirect(t, base);
  });
  const module = Module({ exports: { call } });
  const types = module.module.types;
  const baseIndex = types.findIndex((t) => t.final === false);
  assert.deepEqual(types[baseIndex], { args: ["i32"], results: ["i32"], final: false });
  assert.ok(types.some((t) => t.supertype === baseIndex));
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.call(21), 42);
  assert.throws(() => func({ in: [], out: [], type: sub }, () => {}), /does not match/);
});

test("GC types roundtrip through text, binary and decompiled builders", async () => {
  const parsed = parseWat(`(module
    (rec
      (type $list (sub (struct (field $head i32) (field $tail (ref null $list)))))
      (type $labeled (sub final $list (struct (field i32 (ref null $list)) (field $label (mut i16))))))
    (type $bytes (array (mut i8)))
    (type $f (sub (func (param (ref $labeled)) (result anyref))))
    (func $id (export "id") (type $f) (local.get 0)))`);
  assert.deepEqual(parsed.recGroups, [2, 1, 1]);
  assert.deepEqual(parsed.types[1], {
    struct: [
      { type: "i32", mutable: false },
      { type: { ref: 0, nullable: true }, mutable: false },
      { type: "i16", mutable: true },
    ],
    supertype: 0,
  });
  assert.deepEqual(parsed.names?.fields, { 0: { 0: "head", 1: "tail" }, 1: { 2: "label" } });
  assert.match(printWat(parsed), /\(rec \(type \$list \(sub \(struct \(field \$head i32\)/);
  assert.deepEqual(parseWat(printWat(parsed)), parsed);
  const bytes = BinaryModule.toBytes(parsed);
  assert.deepEqual(BinaryModule.toBytes(BinaryModule.fromBytes(bytes)), bytes);
  assert.match(decompileModule(parsed), /const \{ list, labeled \} = rec\(\(types\) => \(\{/);
  const rebuilt = await buildTextModule(parsed);
  assert.deepEqual(rebuilt.module.types, parsed.types);
  assert.deepEqual(rebuilt.module.recGroups, parsed.recGroups);
  await rebuilt.instantiate();
});
