import {
  Const,
  Dependency,
  Module,
  atomic,
  block,
  br,
  br_if,
  call,
  call_indirect,
  control,
  data,
  declareFunc,
  drop,
  elem,
  f64,
  f64x2,
  funcref,
  global,
  i32,
  i32x4,
  i64,
  importFunc,
  importGlobal,
  importMemory,
  local,
  loop,
  memory,
  ref,
  select,
  table,
  v128,
} from "../src/index.ts";

export default function createModule(imports: WebAssembly.Imports = {}) {
  const consoleLog64 = importFunc(
    { module: "", field: "f0", name: "consoleLog64", in: [{ value: i64 }], out: [] },
    imports[""]?.["f0"] as (arg0: bigint) => void,
  );
  const consoleLog = importFunc(
    { module: "", field: "f1", name: "consoleLog", in: [{ value: i32 }], out: [] },
    imports[""]?.["f1"] as (arg0: number) => void,
  );
  const consoleLogFunc = importFunc(
    { module: "", field: "f2", name: "consoleLogFunc", in: [{ value: funcref }], out: [] },
    imports[""]?.["f2"] as (arg0: Function | null) => void,
  );
  const consoleLogF64 = importFunc(
    { module: "", field: "f3", name: "consoleLogF64", in: [{ value: f64 }], out: [] },
    imports[""]?.["f3"] as (arg0: number) => void,
  );
  const f4 = importFunc(
    { module: "", field: "f4", name: "f4", in: [], out: [] },
    imports[""]?.["f4"] as () => void,
  );
  const importedGlobal = importGlobal(i64, imports[""]?.["g0"] as WebAssembly.Global, {
    mutable: false,
    module: "",
    field: "g0",
  });
  const memory_1 = importMemory(
    { min: 1, max: 65536, shared: true, module: "", field: "m0" },
    imports[""]?.["m0"] as WebAssembly.Memory,
  );
  const exportedFunc = declareFunc({
    name: "exportedFunc",
    in: [{ x: i32 }, { doLog: i32 }],
    locals: { ["vectors[0]"]: v128, ["vectors[1]"]: v128, y: i32 },
    out: [i32],
  });
  const myFunc = declareFunc({
    name: "myFunc",
    in: [{ x: i32 }, { y: i32 }],
    locals: { tmp: i32, i: i32 },
    out: [i32],
  });
  const fma = declareFunc({ name: "fma", in: [{ x: f64 }, { y: f64 }, { z: f64 }], out: [f64] });
  const global1 = global(Const.refFunc(myFunc), { mutable: false });
  const global2 = global(Const.f64(0), { mutable: true });
  const table0 = table({ type: funcref, ...{ min: 4, shared: false } });
  const data0 = data(
    { memory: memory_1, offset: Const.i32(0) },
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  const elem0 = elem({ type: funcref, mode: { table: table0, offset: Const.i32(0) } }, [
    Const.refFunc(consoleLogFunc),
    Const.refFunc(myFunc),
    Const.refNull(funcref),
    Const.refNull(funcref),
  ]);
  exportedFunc.define(({ x, doLog }, { "vectors[0]": vectors_0_, "vectors[1]": vectors_1_, y }) => {
    ref.func(myFunc);
    call(consoleLogFunc);
    global.get(global1);
    i32.const(0);
    call_indirect(table0, { in: [funcref], out: [] });
    f64.const(1.001);
    global.set(global2);
    f64.const(1.01);
    global.get(global2);
    f64.mul();
    call(consoleLogF64);
    local.get(x);
    local.get(doLog);
    control.if({ in: [], out: [] }, () => {
      local.get(x);
      call(consoleLog);
    });
    i32.const(2147483647);
    i32.const(-2147483648);
    local.get(doLog);
    select();
    call(consoleLog);
    local.set(y);
    local.get(y);
    i32.const(5);
    call(myFunc);
    i32.const(10);
    memory.grow();
    drop();
    i32.const(0);
    i32.const(0);
    i32.load({ offset: 4, align: 4 });
    i32.store({ offset: 0, align: 4 });
    i64.const(64n);
    call(consoleLog64);
    v128.const("i8x16", [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
    v128.const("i8x16", [3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0]);
    i32x4.add();
    local.set(vectors_1_);
    v128.const(
      "i8x16",
      [154, 153, 153, 153, 153, 153, 185, 63, 154, 153, 153, 153, 153, 153, 201, 63],
    );
    f64.const(6.25);
    f64x2.splat();
    f64x2.mul();
    f64x2.extract_lane(1);
    call(consoleLogF64);
    ref.null(funcref);
    i32.const(10);
    table.grow(table0);
    drop();
    i32.const(0);
    i32.const(4);
    i32.atomic.rmw.add({ offset: 0, align: 4 });
    i32.const(0);
    i32.const(0);
    memory.atomic.notify({ offset: 0, align: 4 });
    drop();
    drop();
    atomic.fence();
  });
  myFunc.define(({ x, y }, { tmp, i }) => {
    f64.const(1.125);
    i64.trunc_sat_f64_s();
    call(consoleLog64);
    local.get(y);
    local.get(x);
    i32.const(0);
    i32.add();
    i32.add();
    block({ in: [i32], out: [i32] }, () => {
      local.tee(tmp);
      call(consoleLog);
      loop({ in: [], out: [] }, () => {
        local.get(i);
        call(consoleLog);
        local.get(i);
        i32.const(1);
        i32.add();
        local.tee(i);
        i32.const(5);
        i32.eq();
        control.if({ in: [], out: [] }, () => {
          local.get(tmp);
          control.return();
          call(consoleLog);
        });
        br(0);
        local.get(i);
        i32.ne();
        br_if(0);
      });
      local.get(tmp);
      local.get(tmp);
      drop();
    });
  });
  fma.define(({ x, y, z }) => {
    local.get(x);
    f64x2.splat();
    local.get(y);
    f64x2.splat();
    local.get(z);
    f64x2.splat();
    f64x2.relaxed_madd();
    f64x2.extract_lane(0);
  });
  return Module({
    name: "example",
    exports: { exportedFunc, fma, importedGlobal, memory: memory_1 },
    start: f4,
    dependencies: [
      consoleLog64,
      consoleLog,
      consoleLogFunc,
      consoleLogF64,
      f4,
      importedGlobal,
      memory_1,
      exportedFunc,
      myFunc,
      fma,
      global1,
      global2,
      table0,
      data0,
      elem0,
      Dependency.type({ args: ["i64"], results: [] }),
      Dependency.type({ args: ["i32"], results: [] }),
      Dependency.type({ args: ["funcref"], results: [] }),
      Dependency.type({ args: ["f64"], results: [] }),
      Dependency.type({ args: [], results: [] }),
      Dependency.type({ args: ["i32", "i32"], results: ["i32"] }),
      Dependency.type({ args: ["f64", "f64", "f64"], results: ["f64"] }),
      Dependency.type({ args: ["i32"], results: ["i32"] }),
    ],
  });
}
