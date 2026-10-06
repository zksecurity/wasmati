import assert from "node:assert/strict";
import { test } from "node:test";
import wabtFactory from "wabt";
import { Module, NameSection, func, i32 } from "../index.ts";
import { Name, U32 } from "../immediate.ts";

const add = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  i32.add(x, y);
});

test("public Module API emits readable module, function and local names", async () => {
  const names: NameSection = {
    module: "arithmetic",
    functions: { 0: "sum" },
    locals: { 0: { 0: "left", 1: "right" } },
  };
  const module = Module({ exports: { add }, names });
  const bytes = module.toBytes();
  const compiled = new WebAssembly.Module(bytes);
  const sections = WebAssembly.Module.customSections(compiled, "name");
  assert.equal(sections.length, 1);
  assert.deepEqual([...new Uint8Array(sections[0])], NameSection.toBytes(names));
  assert.deepEqual(Module.fromBytes(bytes).module.names, names);
  const { instance } = await module.instantiate();
  assert.equal(instance.exports.add(20, 22), 42);
  const wabt = await wabtFactory();
  const decoded = wabt.readWasm(bytes, { readDebugNames: true });
  try {
    const wat = decoded.toText({ foldExprs: false, inlineExport: false });
    assert.match(wat, /\$arithmetic/);
    assert.match(wat, /\$sum/);
    assert.match(wat, /\$left/);
    assert.match(wat, /\$right/);
  } finally {
    decoded.destroy();
  }
});

test("decodes WABT names, including imported functions, parameters and locals", async () => {
  const wabt = await wabtFactory();
  const parsed = wabt.parseWat("named.wat", `
    (module $named
      (import "env" "id" (func $id (param i32) (result i32)))
      (func $add (export "add") (param $x i32) (param $y i32) (result i32)
        (local $tmp i32)
        local.get $x local.get $y i32.add
        local.set $tmp local.get $tmp call $id))
  `);
  try {
    const { buffer } = parsed.toBinary({ write_debug_names: true });
    const module = Module.fromBytes<{ add: typeof add }>(buffer, { env: { id: (x: number) => x } });
    assert.deepEqual(module.module.names, {
      module: "named", functions: { 0: "id", 1: "add" },
      locals: { 0: {}, 1: { 0: "x", 1: "y", 2: "tmp" } },
    });
    assert.deepEqual(Module.fromBytes(module.toBytes()).module.names, module.module.names);
    const { instance } = await module.instantiate();
    assert.equal(instance.exports.add(20, 22), 42);
  } finally {
    parsed.destroy();
  }
});

test("supports all standard and extended name maps and preserves unknown subsections", () => {
  const names: NameSection = {
    module: "", functions: { 7: "same", 2: "same" },
    locals: { 7: { 100: "local", 0: "param" } },
    labels: { 7: { 0: "loop" } }, types: { 3: "type" },
    tables: { 2: "table" }, memories: { 1: "memory" }, globals: { 0: "global" },
    elements: { 0: "element" }, data: { 0: "data" },
    fields: { 3: { 1: "field" } }, tags: { 0: "exception" },
    unknown: [{ id: 127, data: [0, 255, 42] }],
  };
  assert.deepEqual(NameSection.fromBytes(NameSection.toBytes(names)), names);
  assert.deepEqual(NameSection.fromBytes([]), {});
  assert.deepEqual(NameSection.toBytes({ functions: { 1: "x" } }), [1, 4, 1, 1, 1, 120]);
});

test("custom sections survive before, between and after standard sections", async () => {
  const customSections = [
    { name: "前", data: [0, 255], after: 0 },
    { name: "middle", data: [1, 2, 3], after: 1 },
    { name: "last", data: [4], after: 10 },
  ];
  const module = Module({ exports: { add }, customSections, names: { functions: { 0: "add" } } });
  const recovered = Module.fromBytes<{ add: typeof add }>(module.toBytes());
  assert.deepEqual(recovered.module.customSections, customSections);
  assert.deepEqual(recovered.toBytes(), module.toBytes());
  const { instance } = await recovered.instantiate();
  assert.equal(instance.exports.add(20, 22), 42);
  assert.throws(() => Module({ exports: {}, customSections: [{ name: "x", data: [], after: 5 }] }).toBytes(), /position/);
});

test("opaque custom sections can be large or repeated", () => {
  const data = new Array<number>(200_000).fill(42);
  const module = Module({ exports: {}, customSections: [
    { name: "x", data }, { name: "x", data: [] },
  ] });
  const bytes = module.toBytes();
  assert.equal(WebAssembly.validate(bytes), true);
  const decoded = Module.fromBytes(bytes);
  assert.deepEqual(decoded.module.customSections?.map(({ name, data }) => ({ name, data })), [
    { name: "x", data }, { name: "x", data: [] },
  ]);
});

test("UTF-8 names use byte lengths and preserve leading BOM characters", () => {
  for (const name of ["", "🍚", "λ", "\uFEFFname", "a\0b"]) {
    assert.equal(Name.fromBytes(Name.toBytes(name)), name);
  }
  assert.deepEqual(Name.toBytes("🍚"), [4, 240, 159, 141, 154]);
  assert.throws(() => Name.fromBytes([1, 255]), /encoded data/);
  assert.throws(() => Name.fromBytes([3, 97]), /past end/);
  const names = { module: "算術 🍚", functions: { 0: "加算" }, locals: { 0: { 0: "左", 1: "右" } } };
  const bytes = Module({ exports: { "加算": add }, names }).toBytes();
  const compiled = new WebAssembly.Module(bytes);
  assert.equal(WebAssembly.Module.exports(compiled)[0].name, "加算");
  assert.deepEqual(Module.fromBytes(bytes).module.names, names);
});

test("malformed optional name metadata is preserved without invalidating the module", () => {
  const badPayloads = [
    [0, 1, 2], // truncated module-name string
    [1, 1, 128], // truncated name-map count
    [1, 7, 2, 0, 1, 97, 0, 1, 98], // duplicate indices
    [0, 1, 0, 0, 1, 0], // duplicate subsections
    [0, 2, 1, 255], // invalid UTF-8
  ];
  for (const data of badPayloads) {
    assert.throws(() => NameSection.fromBytes(data));
    const bytes = Module({ exports: {}, customSections: [{ name: "name", data }] }).toBytes();
    assert.equal(WebAssembly.validate(bytes), true);
    const module = Module.fromBytes(bytes);
    assert.equal(module.module.names, undefined);
    assert.deepEqual(module.module.customSections?.[0].data, data);
    assert.equal(WebAssembly.validate(module.toBytes()), true);
  }
});

test("duplicate name sections remain opaque and are preserved", () => {
  const data = NameSection.toBytes({ module: "first" });
  const bytes = Module({ exports: {}, customSections: [
    { name: "name", data }, { name: "name", data: [] },
  ] }).toBytes();
  const module = Module.fromBytes(bytes);
  assert.equal(module.module.names, undefined);
  assert.equal(module.module.customSections?.length, 2);
  assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(module.toBytes()), "name").length, 2);
});

test("rejects invalid metadata on encoding and truncated custom-section framing", () => {
  assert.throws(() => NameSection.toBytes({ functions: { [-1]: "x" } }), /index/);
  assert.throws(() => NameSection.toBytes({ unknown: [{ id: 1, data: [] }] }), /subsection id/);
  assert.throws(() => NameSection.toBytes({ unknown: [{ id: 12, data: [] }, { id: 12, data: [] }] }), /duplicate/);
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  for (const section of [[0], [0, 128], [0, 5, 1, 120], [0, 255, 255, 255, 255, 16]]) {
    assert.throws(() => Module.fromBytes(Uint8Array.from([...header, ...section])));
  }
  const payload = [...Name.toBytes("x"), 1, 2];
  assert.doesNotThrow(() => Module.fromBytes(Uint8Array.from([
    ...header, 0, ...U32.toBytes(payload.length), ...payload,
  ])));
});
