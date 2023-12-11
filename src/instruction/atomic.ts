import { Byte } from "../binable.js";
import { i32t, i64t } from "../types.js";
import { baseInstruction } from "./base.js";
import { memoryInstruction as mi } from "./memory.js";

export {
  memoryAtomicOps,
  atomicOps,
  i32AtomicOps,
  i32AtomicRmwOps,
  i32AtomicRmw8Ops,
  i32AtomicRmw16Ops,
  i64AtomicOps,
  i64AtomicRmwOps,
  i64AtomicRmw8Ops,
  i64AtomicRmw16Ops,
  i64AtomicRmw32Ops,
};

// memory.atomic.X
const memoryAtomicOps = {
  notify: mi("memory.atomic.notify", 32, [i32t, i32t], [i32t]),
  wait32: mi("memory.atomic.wait32", 32, [i32t, i32t, i32t], [i32t]),
  wait64: mi("memory.atomic.wait64", 64, [i32t, i64t, i64t], [i32t]),
};

// atomic.X
const atomicOps = {
  fence: baseInstruction("atomic.fence", Byte, {
    create() {
      return { in: [], out: [], deps: [], resolveArgs: [0] };
    },
  }),
};

// i32.atomic.X
const i32AtomicOps = {
  load: mi("i32.atomic.load", 32, [i32t], [i32t]),
  load8_u: mi("i32.atomic.load8_u", 8, [i32t], [i32t]),
  load16_u: mi("i32.atomic.load16_u", 16, [i32t], [i32t]),
  store: mi("i32.atomic.store", 32, [i32t, i32t], []),
  store8: mi("i32.atomic.store8", 8, [i32t, i32t], []),
  store16: mi("i32.atomic.store16", 16, [i32t, i32t], []),
};

// i32.atomic.rmw.X
const i32AtomicRmwOps = {
  add: mi("i32.atomic.rmw.add", 32, [i32t, i32t], [i32t]),
  sub: mi("i32.atomic.rmw.sub", 32, [i32t, i32t], [i32t]),
  and: mi("i32.atomic.rmw.and", 32, [i32t, i32t], [i32t]),
  or: mi("i32.atomic.rmw.or", 32, [i32t, i32t], [i32t]),
  xor: mi("i32.atomic.rmw.xor", 32, [i32t, i32t], [i32t]),
  xchg: mi("i32.atomic.rmw.xchg", 32, [i32t, i32t], [i32t]),
  cmpxchg: mi("i32.atomic.rmw.cmpxchg", 32, [i32t, i32t, i32t], [i32t]),
};

// i32.atomic.rmw8.X
const i32AtomicRmw8Ops = {
  add_u: mi("i32.atomic.rmw8.add_u", 8, [i32t, i32t], [i32t]),
  sub_u: mi("i32.atomic.rmw8.sub_u", 8, [i32t, i32t], [i32t]),
  and_u: mi("i32.atomic.rmw8.and_u", 8, [i32t, i32t], [i32t]),
  or_u: mi("i32.atomic.rmw8.or_u", 8, [i32t, i32t], [i32t]),
  xor_u: mi("i32.atomic.rmw8.xor_u", 8, [i32t, i32t], [i32t]),
  xchg_u: mi("i32.atomic.rmw8.xchg_u", 8, [i32t, i32t], [i32t]),
  cmpxchg_u: mi("i32.atomic.rmw8.cmpxchg_u", 8, [i32t, i32t, i32t], [i32t]),
};

// i32.atomic.rmw16.X
const i32AtomicRmw16Ops = {
  add_u: mi("i32.atomic.rmw16.add_u", 16, [i32t, i32t], [i32t]),
  sub_u: mi("i32.atomic.rmw16.sub_u", 16, [i32t, i32t], [i32t]),
  and_u: mi("i32.atomic.rmw16.and_u", 16, [i32t, i32t], [i32t]),
  or_u: mi("i32.atomic.rmw16.or_u", 16, [i32t, i32t], [i32t]),
  xor_u: mi("i32.atomic.rmw16.xor_u", 16, [i32t, i32t], [i32t]),
  xchg_u: mi("i32.atomic.rmw16.xchg_u", 16, [i32t, i32t], [i32t]),
  cmpxchg_u: mi("i32.atomic.rmw16.cmpxchg_u", 16, [i32t, i32t, i32t], [i32t]),
};

// i64.atomic.X
const i64AtomicOps = {
  load: mi("i64.atomic.load", 64, [i32t], [i64t]),
  load8_u: mi("i64.atomic.load8_u", 8, [i32t], [i64t]),
  load16_u: mi("i64.atomic.load16_u", 16, [i32t], [i64t]),
  load32_u: mi("i64.atomic.load32_u", 32, [i32t], [i64t]),
  store: mi("i64.atomic.store", 64, [i32t, i64t], []),
  store8: mi("i64.atomic.store8", 8, [i32t, i64t], []),
  store16: mi("i64.atomic.store16", 16, [i32t, i64t], []),
  store32: mi("i64.atomic.store32", 32, [i32t, i64t], []),
};

// i64.atomic.rmw.X
const i64AtomicRmwOps = {
  add: mi("i64.atomic.rmw.add", 64, [i32t, i64t], [i64t]),
  sub: mi("i64.atomic.rmw.sub", 64, [i32t, i64t], [i64t]),
  and: mi("i64.atomic.rmw.and", 64, [i32t, i64t], [i64t]),
  or: mi("i64.atomic.rmw.or", 64, [i32t, i64t], [i64t]),
  xor: mi("i64.atomic.rmw.xor", 64, [i32t, i64t], [i64t]),
  xchg: mi("i64.atomic.rmw.xchg", 64, [i32t, i64t], [i64t]),
  cmpxchg: mi("i64.atomic.rmw.cmpxchg", 64, [i32t, i64t, i64t], [i64t]),
};

// i64.atomic.rmw8.X
const i64AtomicRmw8Ops = {
  add_u: mi("i64.atomic.rmw8.add_u", 8, [i32t, i64t], [i64t]),
  sub_u: mi("i64.atomic.rmw8.sub_u", 8, [i32t, i64t], [i64t]),
  and_u: mi("i64.atomic.rmw8.and_u", 8, [i32t, i64t], [i64t]),
  or_u: mi("i64.atomic.rmw8.or_u", 8, [i32t, i64t], [i64t]),
  xor_u: mi("i64.atomic.rmw8.xor_u", 8, [i32t, i64t], [i64t]),
  xchg_u: mi("i64.atomic.rmw8.xchg_u", 8, [i32t, i64t], [i64t]),
  cmpxchg_u: mi("i64.atomic.rmw8.cmpxchg_u", 8, [i32t, i64t, i64t], [i64t]),
};

// i64.atomic.rmw16.X
const i64AtomicRmw16Ops = {
  add_u: mi("i64.atomic.rmw16.add_u", 16, [i32t, i64t], [i64t]),
  sub_u: mi("i64.atomic.rmw16.sub_u", 16, [i32t, i64t], [i64t]),
  and_u: mi("i64.atomic.rmw16.and_u", 16, [i32t, i64t], [i64t]),
  or_u: mi("i64.atomic.rmw16.or_u", 16, [i32t, i64t], [i64t]),
  xor_u: mi("i64.atomic.rmw16.xor_u", 16, [i32t, i64t], [i64t]),
  xchg_u: mi("i64.atomic.rmw16.xchg_u", 16, [i32t, i64t], [i64t]),
  cmpxchg_u: mi("i64.atomic.rmw16.cmpxchg_u", 16, [i32t, i64t, i64t], [i64t]),
};

// i64.atomic.rmw32.X
const i64AtomicRmw32Ops = {
  add_u: mi("i64.atomic.rmw32.add_u", 32, [i32t, i64t], [i64t]),
  sub_u: mi("i64.atomic.rmw32.sub_u", 32, [i32t, i64t], [i64t]),
  and_u: mi("i64.atomic.rmw32.and_u", 32, [i32t, i64t], [i64t]),
  or_u: mi("i64.atomic.rmw32.or_u", 32, [i32t, i64t], [i64t]),
  xor_u: mi("i64.atomic.rmw32.xor_u", 32, [i32t, i64t], [i64t]),
  xchg_u: mi("i64.atomic.rmw32.xchg_u", 32, [i32t, i64t], [i64t]),
  cmpxchg_u: mi("i64.atomic.rmw32.cmpxchg_u", 32, [i32t, i64t, i64t], [i64t]),
};
