import {
  i32,
  func,
  Local,
  if_,
  return_,
  Module,
  memory,
  local,
  block,
  br,
  Input,
  $,
} from "wasmati";

let p = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001n;

let w = 29; // limb size
let wordMax = (1 << w) - 1;
let n = Math.ceil(p.toString(2).length / w); // number of limbs

// bigints
let wn = BigInt(w);
let wordMaxn = BigInt(wordMax);

let P = bigintToLimbs(p);

/**
 * add two field elements stored in memory
 */
const add = func(
  {
    in: [i32, i32, i32],
    locals: [i32],
    out: [],
  },
  ([z, x, y], [zi]) => {
    // z = x + y
    for (let i = 0; i < n; i++) {
      // zi = x[i] + y[i] + carry
      i32.add(loadLimb(x, i), loadLimb(y, i));
      if (i > 0) i32.add(); // add carry
      local.set(zi);

      // perform carry on zi and store in z[i];
      // carry bit is left on the stack for next i
      if (i < n - 1) i32.shr_s(zi, w);
      storeLimb(z, i, i32.and(zi, wordMax));
    }

    // if (z < p) return;
    isLower(z, zi, P);
    if_(null, () => return_());

    // z -= p
    for (let i = 0; i < n; i++) {
      // zi = z[i] - p[i] + carry
      i32.sub(loadLimb(z, i), P[i]);
      if (i > 0) i32.add(); // add carry
      local.set(zi);

      // perform carry on zi and store in z[i];
      // carry "bit" (0 or -1) is left on the stack for next i
      if (i < n - 1) i32.shr_s(zi, w);
      storeLimb(z, i, i32.and(zi, wordMax));
    }
  }
);

function loadLimb(x: Local<i32>, i: number) {
  return i32.load({ offset: 4 * i }, x);
}

function storeLimb(x: Local<i32>, i: number, s: Input<i32>) {
  return i32.store({ offset: 4 * i }, x, s);
}

// compile and use wasm code

let module = Module({
  exports: { add, memory: memory({ min: 1 }) },
});
let { instance } = await module.instantiate();
let wasm = instance.exports;

wasm.add satisfies (z: number, x: number, y: number) => void;

let offset = 0;

let x = randomField();
let N = 1e7;

// warm up
for (let i = 0; i < 5; i++) {
  benchWasm(x, N);
  benchBigint(x, N);
}

// benchmark
console.time("wasm");
let z0 = benchWasm(x, N);
console.timeEnd("wasm");

console.time("bigint");
let z1 = benchBigint(x, N);
console.timeEnd("bigint");

// make sure that results are the same
if (z0 !== z1) throw Error("wrong result");

function addBigint(x: bigint, y: bigint, p: bigint) {
  let z = x + y;
  return z < p ? z : z - p;
}

function benchWasm(x0: bigint, N: number) {
  let z = fromBigint(0n);
  let x = fromBigint(x0);
  for (let i = 0; i < N; i++) {
    wasm.add(z, z, x);
  }
  return toBigint(z);
}

function benchBigint(x: bigint, N: number) {
  let z = 0n;
  for (let i = 0; i < N; i++) {
    z = addBigint(z, x, p);
  }
  return z;
}

// helpers

function bigintToLimbs(x: bigint, limbs = new Uint32Array(n)) {
  for (let i = 0; i < n; i++) {
    limbs[i] = Number(x & wordMaxn);
    x >>= wn;
  }
  return limbs;
}
function bigintFromLimbs(limbs: Uint32Array) {
  let x0 = 0n;
  let bitPosition = 0n;
  for (let i = 0; i < n; i++) {
    x0 += BigInt(limbs[i]) << bitPosition;
    bitPosition += wn;
  }
  return x0;
}

function fromBigint(x0: bigint) {
  let x = offset;
  offset += 4 * n;
  bigintToLimbs(x0, new Uint32Array(wasm.memory.buffer, x, n));
  return x;
}
function toBigint(x: number) {
  return bigintFromLimbs(new Uint32Array(wasm.memory.buffer, x, n));
}

function randomField() {
  while (true) {
    let arr = new Uint32Array(n);
    let limbs = crypto.getRandomValues(arr);
    let x = bigintFromLimbs(limbs);
    if (x < p) return x;
  }
}

/**
 * helper for checking that x < y, where x is stored in memory and y is
 * a constant stored as an array of 32-bit limbs
 */
function isLower(x: Local<i32>, xi: Local<i32>, y: Uint32Array) {
  block({ out: [i32] }, (block) => {
    for (let i = n - 1; i >= 0; i--) {
      // set xi = x[i]
      local.set(xi, loadLimb(x, i));

      // return true if (xi < yi)
      i32.lt_s(xi, y[i]);
      if_(null, () => {
        i32.const(1);
        br(block);
      });

      // return false if (xi != yi)
      i32.ne(xi, y[i]);
      if_(null, () => {
        i32.const(0);
        br(block);
      });
    }

    // fall-through case: return false if z = p
    i32.const(0);
  });
}
