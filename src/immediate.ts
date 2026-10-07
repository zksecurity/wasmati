import { Binable, type Writer } from "./binable.ts";

export { vec, withByteLength, Name, U8, U32, U64, I32, I64, S33, F32, F64, uint64 };

type U8 = number;
type U32 = number;
/** A 64-bit size or offset: a number where exact, a bigint only beyond 2^53. */
type U64 = number | bigint;
type I32 = number;
type I64 = bigint;
/**
 * Floats are numbers, or exact bits for NaNs. Engines set the quiet bit of signaling NaNs whenever
 * they pass through a JS number, so decoding returns NaNs as bits; encoding accepts both forms.
 */
type F32 = number | { bits: number };
type F64 = number | { bits: bigint };

function vec<T>(Element: Binable<T>) {
  return Binable<T[]>({
    write(writer, vec) {
      writer.unsigned(vec.length);
      for (let i = 0; i < vec.length; i++) Element.write(writer, vec[i]);
    },
    readBytes(bytes, start) {
      let [length, offset] = U32.readBytes(bytes, start);
      let elements: T[] = [];
      for (let i = 0; i < length; i++) {
        let element: T;
        [element, offset] = Element.readBytes(bytes, offset);
        elements.push(element);
      }
      return [elements, offset];
    },
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const utf8Encoder = new TextEncoder();

const Name = Binable<string>({
  write(writer, string: string) {
    let n = string.length;
    let ascii = true;
    for (let i = 0; i < n && ascii; i++) ascii = string.charCodeAt(i) < 0x80;
    if (!ascii) {
      let bytes = utf8Encoder.encode(string);
      writer.unsigned(bytes.length);
      writer.bytes(bytes);
      return;
    }
    // ASCII strings are their own UTF-8 encoding.
    writer.unsigned(n);
    writer.reserve(n);
    let { buffer, length } = writer;
    for (let i = 0; i < n; i++) buffer[length + i] = string.charCodeAt(i);
    writer.length = length + n;
  },
  readBytes(bytes, start) {
    let [length, offset] = U32.readBytes(bytes, start);
    let end = offset + length;
    if (end > bytes.length) throw Error("unexpected end");
    try {
      return [utf8.decode(Uint8Array.from(bytes.slice(offset, end))), end];
    } catch {
      throw Error("malformed UTF-8 encoding");
    }
  },
});

function withByteLength<T>(binable: Binable<T>): Binable<T> {
  return Binable({
    write(writer, t) {
      writer.withLength(() => binable.write(writer, t));
    },
    readBytes(bytes, offset) {
      let [length, start] = U32.readBytes(bytes, offset);
      let end = start + length;
      if (end > bytes.length) throw Error("invalid length encoding");
      let [value, consumed] = binable.readBytes(bytes.slice(start, end), 0);
      if (consumed !== length) throw Error("invalid length encoding");
      return [value, end];
    },
  });
}

/** A single byte, used for lane indices. */
const U8 = Binable<U8>({
  write(writer, x: U8) {
    if (!Number.isInteger(x) || x < 0 || x > 255) throw Error(`invalid byte ${x}`);
    writer.byte(x);
  },
  readBytes(bytes, offset): [U8, number] {
    if (offset >= bytes.length) throw Error("unexpected end");
    return [bytes[offset], offset + 1];
  },
});

const U32 = Binable<U32>({
  write: writeUnsigned,
  readBytes(bytes, offset): [U32, number] {
    let [x, end] = fromLEB128(bytes, offset, 32, false);
    return [Number(x), end];
  },
});

/** 64-bit sizes and offsets. */
const U64 = Binable<U64>({
  write: writeUnsigned,
  readBytes(bytes, offset): [U64, number] {
    let [x, end] = fromLEB128(bytes, offset, 64, false);
    return [uint64(x), end];
  },
});

/** The canonical form of a 64-bit size or offset, so that equal values compare equal. */
function uint64(x: bigint): U64 {
  return x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x;
}

// Constants accept unsigned bit patterns too; their encoding is the signed interpretation.
const I32 = Binable<I32>({
  write(writer, x: I32) {
    // `| 0` is the signed interpretation of 32-bit integers, also of unsigned bit patterns.
    if (Number.isInteger(x) && x >= -(2 ** 31) && x < 2 ** 32) writer.signed(x | 0);
    else writer.bytes(toSLEB128(BigInt.asIntN(32, BigInt(x))));
  },
  readBytes(bytes, offset): [I32, number] {
    let [x, end] = fromLEB128(bytes, offset, 32, true);
    return [Number(x), end];
  },
});

const int64View = new DataView(new ArrayBuffer(8));

const I64 = Binable<I64>({
  write(writer, x: I64) {
    // The low 64 bits, as two 32-bit halves.
    int64View.setBigInt64(0, x, true);
    let low = int64View.getUint32(0, true);
    let high = int64View.getInt32(4, true);
    if ((high === 0 && low < 0x8000_0000) || (high === -1 && low >= 0x8000_0000))
      writer.signed(low | 0);
    else writer.signed64(high, low);
  },
  readBytes(bytes, offset): [I64, number] {
    return fromLEB128(bytes, offset, 64, true);
  },
});

const S33 = Binable<U32>({
  write(writer, x: U32) {
    if (x >= -(2 ** 31) && x < 2 ** 31) writer.signed(x);
    else writer.bytes(toSLEB128(x));
  },
  readBytes(bytes, offset): [U32, number] {
    let [x, end] = fromLEB128(bytes, offset, 33, true);
    return [Number(x), end];
  },
});

// https://en.wikipedia.org/wiki/LEB128

/** Unsigned integers, which are numbers up to 2^53 and bigints beyond. */
function writeUnsigned(writer: Writer, x: number | bigint) {
  if (typeof x === "number" && Number.isSafeInteger(x) && x >= 0) writer.unsigned(x);
  else writer.bytes(toULEB128(x));
}

function toULEB128(x0: bigint | number) {
  let x = BigInt(x0);
  let bytes: number[] = [];
  while (true) {
    let byte = Number(x & 0b0111_1111n); // low 7 bits
    x >>= 7n;
    if (x !== 0n) byte |= 0b1000_0000;
    bytes.push(byte);
    if (x === 0n) break;
  }
  return bytes;
}
function toSLEB128(x0: bigint | number): number[] {
  let x = BigInt(x0);
  let bytes: number[] = [];
  while (true) {
    let byte = Number(x & 0b0111_1111n);
    x >>= 7n;
    if ((x === 0n && (byte & 0b0100_0000) === 0) || (x === -1n && (byte & 0b0100_0000) !== 0)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0b1000_0000);
  }
}

/**
 * Decode an N-bit LEB128 integer strictly: at most ceil(N / 7) bytes, and the unused bits of the last
 * byte must be zero, or for signed integers copies of the sign bit.
 */
function fromLEB128(bytes: number[], offset: number, bits: number, signed: boolean) {
  const maxBytes = Math.ceil(bits / 7);
  let x = 0n;
  for (let i = 0; i < maxBytes; i++) {
    if (offset >= bytes.length) throw Error("unexpected end");
    const byte = bytes[offset++];
    x |= BigInt(byte & 0x7f) << BigInt(7 * i);
    const last = (byte & 0x80) === 0;
    if (i === maxBytes - 1) {
      if (!last) throw Error("integer representation too long");
      // Bits of the last byte above the integer's width, plus its top bit if signed.
      const used = bits - 7 * i;
      const rest = (byte & 0x7f) >> (signed ? used - 1 : used);
      if (rest !== 0 && !(signed && rest === 0x7f >> (used - 1))) throw Error("integer too large");
    }
    if (last) {
      const width = BigInt(7 * (i + 1));
      return [signed ? BigInt.asIntN(Math.min(Number(width), bits), x) : x, offset] as [
        bigint,
        number,
      ];
    }
  }
  throw Error("unreachable");
}

// float

const floatView = new DataView(new ArrayBuffer(8));

const floatBytes = new Uint8Array(floatView.buffer);

const F32 = Binable<F32>({
  write(writer, value) {
    if (typeof value === "number") floatView.setFloat32(0, value, true);
    else floatView.setUint32(0, value.bits, true);
    writer.bytes(floatBytes.subarray(0, 4));
  },
  readBytes(bytes, offset) {
    if (offset + 4 > bytes.length) throw Error("f32: unexpected end of input");
    for (let i = 0; i < 4; i++) floatView.setUint8(i, bytes[offset + i]);
    const value = floatView.getFloat32(0, true);
    return [Number.isNaN(value) ? { bits: floatView.getUint32(0, true) } : value, offset + 4];
  },
});

const F64 = Binable<F64>({
  write(writer, value) {
    if (typeof value === "number") floatView.setFloat64(0, value, true);
    else floatView.setBigUint64(0, value.bits, true);
    writer.bytes(floatBytes);
  },
  readBytes(bytes, offset) {
    if (offset + 8 > bytes.length) throw Error("f64: unexpected end of input");
    for (let i = 0; i < 8; i++) floatView.setUint8(i, bytes[offset + i]);
    const value = floatView.getFloat64(0, true);
    return [Number.isNaN(value) ? { bits: floatView.getBigUint64(0, true) } : value, offset + 8];
  },
});
