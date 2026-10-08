import { F32, F64 } from "./immediate.ts";
import type { TupleN } from "./util.ts";

export { toV128Bytes, type VectorShape, type ShapeType, type ShapeLength, type V128 };

type VectorShape = "i8x16" | "i16x8" | "i32x4" | "i64x2" | "f32x4" | "f64x2";

const shapeLength = {
  i8x16: 16,
  i16x8: 8,
  i32x4: 4,
  i64x2: 2,
  f32x4: 4,
  f64x2: 2,
} as const satisfies Record<VectorShape, number>;
type ShapeLength = typeof shapeLength;

type ShapeType = {
  i8x16: number;
  i16x8: number;
  i32x4: number;
  i64x2: bigint;
  f32x4: F32;
  f64x2: F64;
};

type V128Generic<Shape extends VectorShape> = [
  shape: Shape,
  value: TupleN<ShapeType[Shape], ShapeLength[Shape]>,
];

type V128 =
  | V128Generic<"i8x16">
  | V128Generic<"i16x8">
  | V128Generic<"i32x4">
  | V128Generic<"i64x2">
  | V128Generic<"f32x4">
  | V128Generic<"f64x2">;

/** The 16 little-endian bytes of a vector given as lanes of a shape. */
function toV128Bytes<T extends V128>(...[shape, value]: T): TupleN<number, 16> {
  type Bytes16 = TupleN<number, 16>;
  if (value.length !== shapeLength[shape])
    throw Error(
      `v128.const: got input of length ${value.length}, but expected length ${shapeLength[shape]} for shape ${shape}.`,
    );
  switch (shape) {
    case "i8x16":
      return value.flatMap((v) => intToBytes(v, 1)) as Bytes16;
    case "i16x8":
      return value.flatMap((v) => intToBytes(v, 2)) as Bytes16;
    case "i32x4":
      return value.flatMap((v) => intToBytes(v, 4)) as Bytes16;
    case "i64x2":
      return value.flatMap((v) => intToBytes(v, 8)) as Bytes16;
    case "f32x4":
      return value.flatMap((v) => [...F32.toBytes(v)]) as Bytes16;
    case "f64x2":
      return value.flatMap((v) => [...F64.toBytes(v)]) as Bytes16;
    default:
      throw Error("unreachable");
  }
}

/** Little-endian bytes of a lane, which may be given in its signed or unsigned range. */
function intToBytes(x: number | bigint, length: number): number[] {
  const bits = BigInt(8 * length);
  const value = BigInt(x);
  if (value < -(1n << (bits - 1n)) || value >= 1n << bits)
    throw Error(`${x} doesn't fit into ${length} bytes.`);
  const unsigned = BigInt.asUintN(Number(bits), value);
  return Array.from({ length }, (_, i) => Number((unsigned >> BigInt(8 * i)) & 0xffn));
}
