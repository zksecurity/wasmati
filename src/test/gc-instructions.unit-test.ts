import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  i32,
  local,
  refType,
  struct,
  array,
  mut,
  i8,
  ref,
  i31,
  any,
  extern,
  anyref,
  externref,
  structref,
  br_on_cast,
  br_on_cast_fail,
  block,
  drop,
  data,
  memory,
  constant,
  global,
  return_,
} from "../index.ts";
import { parseWat } from "../text/wat.ts";
import { printWat } from "../text/print.ts";
import { decompileModule } from "../decompile.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { buildTextModule } from "./text-helpers.ts";

test("structs are created and accessed with fields by name", async () => {
  const point = struct({ x: mut(i32), y: i32 });
  const sum = func(
    { in: [{ x: i32 }], out: [i32], locals: { p: refType(point) } },
    ({ x }, { p }) => {
      local.get(x);
      i32.const(2);
      struct.new(point);
      local.set(p);
      local.get(p);
      local.get(x);
      i32.const(1);
      i32.add();
      struct.set(point, "x");
      local.get(p);
      struct.get(point, "x");
      local.get(p);
      struct.get(point, "y");
      i32.add();
    },
  );
  const { module, instantiate } = Module({ exports: { sum } });
  assert.deepEqual(module.funcs[0].body.slice(0, 1), [{ name: "local.get", immediate: 0 }]);
  assert.ok(module.funcs[0].body.some((i) => i.name === "struct.get" && i.immediate[1] === 1));
  const { instance } = await instantiate();
  assert.equal(instance.exports.sum(5), 8);
  assert.throws(() => struct.get(point, "z"), /no field z/);
  assert.throws(() => struct.get_s(point, "x"), /not packed/);
});

test("arrays of packed elements read as signed or unsigned i32", async () => {
  const bytes = array(mut(i8));
  memory({ min: 1 });
  const segment = data("passive", [0xff, 1, 2]);
  const read = func({ in: [{ i: i32 }], out: [i32] }, ({ i }) => {
    i32.const(0);
    i32.const(3);
    array.new_data(bytes, segment);
    local.get(i);
    array.get_s(bytes);
  });
  const length = func({ in: [], out: [i32] }, () => {
    i32.const(0);
    i32.const(1);
    i32.const(2);
    array.new_fixed(bytes, 3);
    array.len();
    i32.const(7);
    i32.add();
  });
  const { instance } = await Module({ exports: { read, length } }).instantiate();
  assert.equal(instance.exports.read(0), -1);
  assert.equal(instance.exports.read(2), 2);
  assert.equal(instance.exports.length(), 10);
});

test("tests, casts and branches on casts follow the reference's type", async () => {
  const point = struct({ x: i32 });
  const p = global(constant(() => struct.new_default(point)));
  const classify = func({ in: [{ a: anyref }], out: [i32] }, ({ a }) => {
    local.get(a);
    ref.test(refType(point));
    local.get(a);
    ref.test(refType("i31", { nullable: true }));
    i32.const(1);
    i32.shl();
    i32.or();
  });
  const make = func({ in: [{ kind: i32 }], out: [anyref] }, ({ kind }) => {
    local.get(kind);
    ref.i31();
  });
  const point_ = func({ in: [], out: [anyref] }, () => global.get(p));
  const field = func({ in: [{ a: anyref }], out: [i32] }, ({ a }) => {
    block({ in: [], out: [structref] }, (l) => {
      local.get(a);
      br_on_cast(l, anyref, structref);
      drop();
      i32.const(-1);
      ref.i31();
      i31.get_s();
      return_();
    });
    ref.cast(refType(point));
    struct.get(point, "x");
  });
  const roundtrip = func({ in: [{ e: externref }], out: [externref] }, ({ e }) => {
    local.get(e);
    any.convert_extern();
    extern.convert_any();
  });
  const { instance } = await Module({
    exports: { classify, make, point: point_, field, roundtrip },
  }).instantiate();
  const e = instance.exports as any;
  assert.equal(e.classify(e.point()), 1);
  assert.equal(e.classify(e.make(3)), 2);
  assert.equal(e.classify(null), 2);
  assert.equal(e.field(e.point()), 0);
  assert.equal(e.field(e.make(3)), -1);
  const host = {};
  assert.equal(e.roundtrip(host), host);
  assert.throws(() => br_on_cast_fail(0, structref, anyref), /not a subtype/);
});

test("GC instructions roundtrip through text, binary and decompiled builders", async () => {
  const parsed = parseWat(`(module
    (type $point (struct (field $x (mut i32)) (field $y i32)))
    (type $bytes (array (mut i8)))
    (data $d "\\01\\02")
    (func (export "f") (param $a anyref) (result i32) (local $p (ref null $point))
      (local.set $p
        (block $l (result (ref null $point))
          (br_on_cast $l anyref (ref $point) (local.get $a))
          (drop)
          (struct.new_default $point)))
      (drop (ref.cast (ref null $point) (ref.null none)))
      (struct.set $point $x (local.get $p) (i32.const 3))
      (drop (block $m (result anyref) (br_on_cast_fail $m anyref (ref $point) (local.get $a))))
      (drop (array.new_data $bytes $d (i32.const 0) (i32.const 2)))
      (drop (ref.test (ref $bytes) (array.new_fixed $bytes 2 (i32.const 1) (i32.const 2))))
      (ref.eq (ref.i31 (i32.const 1)) (ref.i31 (i32.const 1)))))`);
  const printed = printWat(parsed);
  assert.match(printed, /struct\.set \$point \$x/);
  assert.match(printed, /br_on_cast_fail 0 anyref \(ref \$point\)/);
  assert.match(printed, /br_on_cast 0 anyref \(ref \$point\)/);
  assert.match(printed, /ref\.cast \(ref null \$point\)/);
  assert.deepEqual(parseWat(printed), parsed);
  const bytes = BinaryModule.toBytes(parsed);
  assert.deepEqual(BinaryModule.toBytes(BinaryModule.fromBytes(bytes)), bytes);
  const source = decompileModule(parsed);
  assert.match(source, /struct\.set\(point, "x"\)/);
  assert.match(source, /ref\.cast\(refType\(point, \{ nullable: true \}\)\)/);
  const rebuilt = await buildTextModule(parsed);
  const { instance } = await rebuilt.instantiate();
  assert.equal((instance.exports as any).f(null), 1);
});

test("GC instructions take operands as arguments, and struct fields by name", async () => {
  const point = struct({ x: i32, y: mut(i32) });
  const bytes = array(mut(i8));
  const origin = global(constant(() => struct.new(point, { y: 2, x: 1 })));
  const f = func(
    { in: [{ v: i32 }], out: [i32], locals: { a: refType(bytes) } },
    ({ v }, { a }) => {
      local.set(a, array.new_fixed(bytes, [v, 2, 3]));
      array.set(bytes, a, 1, i32.add(v, 1));
      struct.set(point, "y", global.get(origin), array.get_s(bytes, a, 1));
      i32.add(struct.get(point, "y", global.get(origin)), ref.test(refType(point), ref.i31(0)));
    },
  );
  const { instance } = await Module({ exports: { f } }).instantiate();
  assert.equal(instance.exports.f(-2), -1);
  assert.throws(() => struct.new(point, { x: 1 }), /Unsupported input|Expected/);
});
