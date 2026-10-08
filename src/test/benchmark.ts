// Time building a module like those of field arithmetic libraries, and instantiating it: unrolled multiplication
// of limbs in locals, loads and stores, and loops.
// node src/test/benchmark.ts [runs]
import { Module, block, br_if, func, i32, i64, local, localArray, loop, memory } from "../index.ts";

const runs = Number(process.argv[2] ?? 10);
const limbs = 16;
// About as much code as montgomery's field module, of 245 KB
const functions = 30;
const mem = memory({ min: 1 });

/** A product of two numbers of limbs in memory, written to memory, unrolled. */
function multiply(name: string) {
  return func(
    {
      name,
      in: [{ out: i32 }, { x: i32 }, { y: i32 }],
      locals: { xs: localArray(i64, limbs), t: localArray(i64, 2 * limbs), carry: i64 },
      out: [],
    },
    ({ out, x, y }, { xs, t, carry }) => {
      for (let i = 0; i < limbs; i++) local.set(xs[i], i64.load({ offset: 8 * i }, x));
      for (let j = 0; j < limbs; j++) {
        local.set(carry, 0n);
        local.set(t[2 * limbs - 1], i64.load({ offset: 8 * j }, y));
        for (let i = 0; i < limbs; i++) {
          // t[i + j] + x[i] * y[j] + carry, split into 32-bit halves
          let sum = i64.add(i64.add(i64.mul(xs[i], t[2 * limbs - 1]), t[i + j]), carry);
          local.set(carry, i64.shr_u(local.tee(t[i + j], sum), 32n));
          local.set(t[i + j], i64.and(local.get(t[i + j]), 0xffff_ffffn));
        }
      }
      for (let i = 0; i < 2 * limbs; i++) i64.store({ offset: 8 * i }, out, t[i]);
    },
  );
}

/** A countdown loop. */
function countdown() {
  return func({ in: [{ x: i32 }, { n: i32 }], out: [] }, ({ x, n }) => {
    block((done) =>
      loop((next) => {
        i32.eqz(n);
        br_if(done);
        local.set(n, i32.sub(n, 1));
        i32.const(1);
        br_if(next);
      }),
    );
    local.set(x, i32.add(local.get(x), 1));
  });
}

function build() {
  let exports = Object.fromEntries(
    Array.from({ length: functions }, (_, i) => [`mul${i}`, multiply(`mul${i}`)]),
  );
  return Module({ exports: { ...exports, countdown: countdown() }, memory: mem });
}

// The build, from builder code to bytes, next to what the engine takes to instantiate the bytes.
let builds: number[] = [];
let instantiations: number[] = [];
let size = 0;
for (let run = 0; run < runs; run++) {
  let start = performance.now();
  let module = build();
  builds.push(performance.now() - start);
  size = module.toBytes().length;
  start = performance.now();
  await module.instantiate();
  instantiations.push(performance.now() - start);
}
const median = (times: number[]) => [...times].sort((a, b) => a - b)[times.length >> 1];
const ms = (time: number) => `${time.toFixed(1)} ms`;
console.log(`module of ${size} bytes, ${runs} runs`);
console.log(`build: first ${ms(builds[0])}, median ${ms(median(builds.slice(1)))}`);
console.log(
  `WebAssembly.instantiate: first ${ms(instantiations[0])}, median ${ms(median(instantiations.slice(1)))}`,
);
