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
} from "wasmati";

let p = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001n;

let w = 29; // limb size
let wordMax = (1 << w) - 1;
let n = Math.ceil(p.toString(2).length / w); // number of limbs

console.log({ n });

// bigints
let wn = BigInt(w);
let wordMaxn = BigInt(wordMax);

type Field = {
  get(i: number): Input<i32>;
};

class ConstantField implements Field {
  limbs: Uint32Array;

  constructor(x: bigint) {
    this.limbs = bigintToLimbs(x);
  }

  get(i: number) {
    return this.limbs[i];
  }
}

class MemoryField implements Field {
  x: Local<i32>;
  xi: Local<i32>;

  constructor(x: Local<i32>, xi: Local<i32>) {
    this.x = x;
    this.xi = xi;
  }

  get(i: number) {
    i32.load({ offset: 4 * i }, this.x);
    local.set(this.xi);
    return this.xi;
  }
  set(i: number, xi: Input<i32>) {
    i32.store({ offset: 4 * i }, this.x, xi);
  }
}

function isLower(x: Field, y: Field) {
  block({ out: [i32] }, (block) => {
    for (let i = n - 1; i >= 0; i--) {
      // set xi = x[i] and yi = y[i]
      let xi = x.get(i);
      let yi = y.get(i);

      // return true if (xi < yi)
      i32.lt_u(xi, yi);
      if_(null, () => {
        i32.const(1);
        br(block);
      });

      // return false if (xi != yi)
      i32.ne(xi, yi);
      if_(null, () => {
        i32.const(0);
        br(block);
      });
    }

    // fall-through case: return false if z = p
    i32.const(0);
  });
}

const add = func(
  {
    in: [i32, i32, i32],
    locals: [i32, i32, i32],
    out: [],
  },
  ([zPtr, xPtr, yPtr], [xi, yi, zi]) => {
    let x = new MemoryField(xPtr, xi);
    let y = new MemoryField(yPtr, yi);
    let z = new MemoryField(zPtr, zi);
    let P = new ConstantField(p);

    // z = x + y
    for (let i = 0; i < n; i++) {
      i32.add(x.get(i), y.get(i));
      if (i > 0) i32.add();
      local.set(zi);

      if (i < n - 1) i32.shr_u(zi, w);
      z.set(i, i32.and(zi, wordMax));
    }

    // if (z < p) return;
    isLower(z, P);
    if_(null, () => return_());

    // z -= p
    for (let i = 0; i < n; i++) {
      i32.sub(z.get(i), P.get(i));
      if (i > 0) i32.add();
      local.set(zi);

      if (i < n - 1) i32.shr_s(zi, w);
      z.set(i, i32.and(zi, wordMax));
    }
  }
);

// compile and use wasm code

let module = Module({
  exports: { add, memory: memory({ min: 1 }) },
});
let {
  instance: { exports: wasm },
} = await module.instantiate();

let offset = 0;

let x = randomField();
let N = 1e7;

// warm up
for (let i = 0; i < 5; i++) {
  benchWasm(x, N);
  benchBigint(x, N);
}

for (let i = 0; i < 5; i++) {
  console.time("wasm");
  let z0 = benchWasm(x, N);
  console.timeEnd("wasm");

  console.time("bigint");
  let z1 = benchBigint(x, N);
  console.timeEnd("bigint");

  if (z0 !== z1) throw Error("wrong result");
}

function addBigint(x: bigint, y: bigint) {
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
    z = addBigint(z, x);
  }
  return z;
}

// helpers

function bigintToLimbs(x0: bigint, limbs = new Uint32Array(n)) {
  for (let i = 0; i < n; i++) {
    limbs[i] = Number(x0 & wordMaxn);
    x0 >>= wn;
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
