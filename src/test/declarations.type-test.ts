import {
  declareFunc,
  importFunc,
  params,
  i32,
  i64,
  localArray,
  local,
  call,
  Module,
  type Local,
} from "../index.ts";

// Compile-only assertions: deferred construction keeps the same strict types as func().
async function checkDeclarations() {
  const imported = importFunc(
    { module: "env", field: "identity", in: params({ value: i64 }), out: [i64] },
    (value) => value,
  );
  imported.field satisfies string | undefined;
  // @ts-expect-error the old import-path property has been removed
  imported.string = "identity";
  // @ts-expect-error path overrides do not weaken callback result types
  importFunc({ field: "f", in: params(), out: [i64] }, () => 1);
  const f = declareFunc({
    in: params({ x: i32 }, { y: i64 }, { z: i32 }),
    locals: { limbs: localArray(i64, 2) },
    out: [i64],
  });
  f.define(({ x, y, z }, { limbs }) => {
    x satisfies Local<i32>;
    y satisfies Local<i64>;
    z satisfies Local<i32>;
    limbs satisfies [Local<i64>, Local<i64>];
    // @ts-expect-error parameter types remain strict
    i64.add(x, y);
    // @ts-expect-error fixed local arrays retain bounds
    local.get(limbs[2]);
    call(f, { x, y, z });
    // @ts-expect-error named calls require every parameter
    call(f, { x, y });
    // @ts-expect-error named calls reject the wrong type
    call(f, { x: y, y, z });
  });
  // @ts-expect-error definitions receive only declared parameter names
  f.define(({ missing }) => {});
  const { instance } = await Module({ exports: { f } }).instantiate();
  instance.exports.f(1, 2n, 3) satisfies bigint;
  // @ts-expect-error native calls retain mixed parameter order
  instance.exports.f(1, 2, 3n);
  // @ts-expect-error native calls retain arity
  instance.exports.f(1, 2n);
}
