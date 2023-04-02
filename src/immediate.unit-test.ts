import { I32, I64, U32 } from "./immediate.js";
import { equal } from "node:assert/strict";

function roundtrip(x: number) {
  try {
    equal(I32.fromBytes(I32.toBytes(x)), x);
  } catch {
    console.log(
      "failing roundtrip",
      x,
      I32.fromBytes(I32.toBytes(x)),
      Math.log2(Math.abs(x))
    );
    console.log(I32.toBytes(x));
    equal(I32.fromBytes(I32.toBytes(x)), x);
  }
}
function roundtripU(x: number) {
  try {
    equal(U32.fromBytes(U32.toBytes(x)), x);
  } catch {
    console.log(
      "failing roundtrip",
      x,
      U32.fromBytes(U32.toBytes(x)),
      Math.log2(Math.abs(x))
    );
    console.log(U32.toBytes(x));
    equal(U32.fromBytes(U32.toBytes(x)), x);
  }
}

roundtrip(0);
roundtrip(1);
roundtrip(10);
roundtrip(9999);
roundtrip(2187698);
roundtrip(2 ** 30 + 2 ** 16);
roundtrip(2 ** 31 - 1);
roundtrip(2 ** 27);
roundtripU(2 ** 27);
roundtrip(2 ** 6);
roundtripU(2 ** 6);

roundtrip(63);
roundtrip(64);
roundtrip(127);
roundtrip(-1);
roundtrip(-2);
roundtrip(-10);
roundtrip(-999);
roundtrip(-(2 ** 21));
roundtrip(-(2 ** 28));
roundtrip(-(2 ** 29));
roundtrip(-(2 ** 31));
roundtrip(-(2 ** 40) + 1);
