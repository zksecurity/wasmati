import assert from "node:assert/strict";
import test from "node:test";
import {
  Module,
  func,
  global,
  constant,
  i32,
  local,
  block,
  br_if,
  call,
  control,
  drop,
  struct,
  ref,
  refType,
  type Func,
} from "../index.ts";
import { Module as BinaryModule } from "../module-binable.ts";

/**
 * Built modules encode their linked code; once their bodies are read, they encode from the
 * instructions, through the reference encoder, which also computes branch hint offsets anew.
 */
function bothEncodings(exports: Record<string, Func<any, any>>) {
  const linked = Module({ exports }).toBytes();
  const module = Module({ exports });
  for (const func of module.module.funcs) func.body;
  return { linked, decoded: module.toBytes() };
}

const counter = global(
  constant(() => i32.const(5)),
  { mutable: true },
);
const identity = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => local.get(x));
const point = struct({ x: i32 });

const holes = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  block((done) => {
    // Holes for indices: calls, globals, types, and a global.get inserted before an operand.
    call(identity, { x });
    drop();
    const one = i32.const(1);
    i32.sub(counter, one);
    br_if(done, { likely: false });
    ref.null(refType(point, { nullable: true }));
    drop();
    i32.const(0);
    br_if(done, { likely: true });
  });
  local.get(x);
  control.if(
    { out: [i32], likely: false },
    () => i32.const(1),
    () => call(identity, { x }),
  );
});

test("linked code encodes like its instructions, with branch hints after holes", async () => {
  const { linked, decoded } = bothEncodings({ holes });
  assert.deepEqual(linked, decoded);
  const hints = (body: { name: string; likely?: boolean; immediate: any }[]): unknown[] =>
    body.flatMap(({ name, likely, immediate }) => [
      ...(Array.isArray(immediate?.instructions) ? hints(immediate.instructions) : []),
      ...(immediate?.instructions?.if ? hints(immediate.instructions.if) : []),
      ...(immediate?.instructions?.else ? hints(immediate.instructions.else) : []),
      ...(likely === undefined ? [] : [[name, likely]]),
    ]);
  const funcs = BinaryModule.fromBytes(linked).funcs;
  const body = funcs.find(({ body }) => body.length > 2)!.body;
  assert.deepEqual(hints(body), [
    ["br_if", false],
    ["br_if", true],
    ["if", false],
  ]);
  const { instance } = await Module({ exports: { holes } }).instantiate();
  assert.equal(instance.exports.holes(7), 1);
});

test("bodies of built modules decode where they are read, and encode as changed", () => {
  const seven = func({ in: [], out: [i32] }, () => i32.const(7));
  const module = Module({ exports: { seven } });
  const [{ body }] = module.module.funcs;
  assert.deepEqual(body, [{ name: "i32.const", immediate: 7 }]);
  body[0].immediate = 8;
  const [changed] = BinaryModule.fromBytes(module.toBytes()).funcs;
  assert.deepEqual(changed.body, [{ name: "i32.const", immediate: 8 }]);
});
