import { i32, func, Local, if_, return_, Module, memory, local } from "wasmati";

const n = 9; // number of limbs

const isGreater = func(
  { in: [i32, i32], locals: [i32, i32], out: [i32] },
  ([x, y], [xi, yi]) => {
    for (let i = n - 1; i >= 0; i--) {
      // set xi = x[i] and yi = y[i]
      local.set(xi, loadLimb(x, i));
      local.set(yi, loadLimb(y, i));

      // return true if (xi > yi)
      i32.gt_u(xi, yi);
      if_(null, () => {
        i32.const(1);
        return_();
      });

      // return false if (xi != yi)
      i32.ne(xi, yi);
      if_(null, () => {
        i32.const(0);
        return_();
      });
    }

    // fall-through case: return false if x = y
    i32.const(0);
  }
);

function loadLimb(x: Local<i32>, i: number) {
  return i32.load({ offset: 4 * i }, x);
}

// compile and use wasm code

let module = Module({ exports: { isGreater, memory: memory({ min: 1 }) } });
let {
  instance: { exports: wasm },
} = await module.instantiate();

let offset = 0;
let w = 32n;
let wordMax = (1n << w) - 1n;

function fromBigint(x0: bigint) {
  let x = offset;
  offset += 4 * n;
  let arr = new Uint32Array(wasm.memory.buffer, x, n);
  for (let i = 0; i < n; i++) {
    arr[i] = Number(x0 & wordMax);
    x0 >>= w;
  }
  return x;
}

let x = fromBigint(20n);
let y = fromBigint(19n);

let isXGreater = wasm.isGreater(x, y);

console.log({ isXGreater });
