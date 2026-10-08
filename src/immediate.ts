import {
  Binable,
  type ByteCursor,
  readByte,
  reserve,
  writeByte,
  writeByteArray,
  writeSigned64LEB,
  writeSignedLEB,
  writeUnsignedLEB,
  writeWithLength,
} from "./binable.ts";

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
    writeBytes(output, vec) {
      writeUnsignedLEB(output, vec.length);
      for (let i = 0; i < vec.length; i++) Element.writeBytes(output, vec[i]);
    },
    readBytes(input) {
      let length = U32.readBytes(input);
      let elements: T[] = [];
      for (let i = 0; i < length; i++) elements.push(Element.readBytes(input));
      return elements;
    },
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const utf8Encoder = new TextEncoder();

const Name = Binable<string>({
  writeBytes(output, string: string) {
    let n = string.length;
    let ascii = true;
    for (let i = 0; i < n && ascii; i++) ascii = string.charCodeAt(i) < 0x80;
    if (!ascii) {
      let bytes = utf8Encoder.encode(string);
      writeUnsignedLEB(output, bytes.length);
      writeByteArray(output, bytes);
      return;
    }
    // ASCII strings are their own UTF-8 encoding.
    writeUnsignedLEB(output, n);
    reserve(output, n);
    let { bytes, offset } = output;
    for (let i = 0; i < n; i++) bytes[offset + i] = string.charCodeAt(i);
    output.offset = offset + n;
  },
  readBytes(input) {
    let length = U32.readBytes(input);
    let start = input.offset;
    let end = start + length;
    if (end > input.bytes.length) throw Error("unexpected end");
    input.offset = end;
    try {
      return utf8.decode(input.bytes.subarray(start, end));
    } catch {
      throw Error("malformed UTF-8 encoding");
    }
  },
});

function withByteLength<T>(binable: Binable<T>): Binable<T> {
  return Binable({
    writeBytes(output, t) {
      writeWithLength(output, () => binable.writeBytes(output, t));
    },
    readBytes(input) {
      let length = U32.readBytes(input);
      let start = input.offset;
      let end = start + length;
      if (end > input.bytes.length) throw Error("invalid length encoding");
      // The value ends where its length says, which codecs that read to the end rely on.
      let inner: ByteCursor = { bytes: input.bytes.subarray(start, end), offset: 0 };
      let value = binable.readBytes(inner);
      if (inner.offset !== length) throw Error("invalid length encoding");
      input.offset = end;
      return value;
    },
  });
}

/** A single byte, used for lane indices. */
const U8 = Binable<U8>({
  writeBytes(output, x: U8) {
    if (!Number.isInteger(x) || x < 0 || x > 255) throw Error(`invalid byte ${x}`);
    writeByte(output, x);
  },
  readBytes: readByte,
});

const U32 = Binable<U32>({
  writeBytes: writeUnsigned,
  readBytes(input) {
    return Number(readLEB128(input, 32, false));
  },
});

/** 64-bit sizes and offsets. */
const U64 = Binable<U64>({
  writeBytes: writeUnsigned,
  readBytes(input) {
    return uint64(readLEB128(input, 64, false));
  },
});

/** The canonical form of a 64-bit size or offset, so that equal values compare equal. */
function uint64(x: bigint): U64 {
  return x <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x;
}

// Constants accept unsigned bit patterns too; their encoding is the signed interpretation.
const I32 = Binable<I32>({
  writeBytes(output, x: I32) {
    // `| 0` is the signed interpretation of 32-bit integers, also of unsigned bit patterns.
    if (Number.isInteger(x) && x >= -(2 ** 31) && x < 2 ** 32) writeSignedLEB(output, x | 0);
    else writeByteArray(output, toSLEB128(BigInt.asIntN(32, BigInt(x))));
  },
  readBytes(input) {
    return Number(readLEB128(input, 32, true));
  },
});

const int64View = new DataView(new ArrayBuffer(8));

const I64 = Binable<I64>({
  writeBytes(output, x: I64) {
    // The low 64 bits, as two 32-bit halves.
    int64View.setBigInt64(0, x, true);
    let low = int64View.getUint32(0, true);
    let high = int64View.getInt32(4, true);
    if ((high === 0 && low < 0x8000_0000) || (high === -1 && low >= 0x8000_0000))
      writeSignedLEB(output, low | 0);
    else writeSigned64LEB(output, high, low);
  },
  readBytes(input) {
    return readLEB128(input, 64, true);
  },
});

const S33 = Binable<U32>({
  writeBytes(output, x: U32) {
    if (x >= -(2 ** 31) && x < 2 ** 31) writeSignedLEB(output, x);
    else writeByteArray(output, toSLEB128(x));
  },
  readBytes(input) {
    return Number(readLEB128(input, 33, true));
  },
});

// https://en.wikipedia.org/wiki/LEB128

/** Unsigned integers, which are numbers up to 2^53 and bigints beyond. */
function writeUnsigned(output: ByteCursor, x: number | bigint) {
  if (typeof x === "number" && Number.isSafeInteger(x) && x >= 0) writeUnsignedLEB(output, x);
  else writeByteArray(output, toULEB128(x));
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
function readLEB128(input: ByteCursor, bits: number, signed: boolean): bigint {
  const maxBytes = Math.ceil(bits / 7);
  let x = 0n;
  for (let i = 0; i < maxBytes; i++) {
    const byte = readByte(input);
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
      return signed ? BigInt.asIntN(Math.min(Number(width), bits), x) : x;
    }
  }
  throw Error("unreachable");
}

// float

const floatView = new DataView(new ArrayBuffer(8));

const floatBytes = new Uint8Array(floatView.buffer);

const F32 = Binable<F32>({
  writeBytes(output, value) {
    if (typeof value === "number") floatView.setFloat32(0, value, true);
    else floatView.setUint32(0, value.bits, true);
    writeByteArray(output, floatBytes.subarray(0, 4));
  },
  readBytes(input) {
    let { bytes, offset } = input;
    if (offset + 4 > bytes.length) throw Error("f32: unexpected end of input");
    for (let i = 0; i < 4; i++) floatView.setUint8(i, bytes[offset + i]);
    input.offset = offset + 4;
    const value = floatView.getFloat32(0, true);
    return Number.isNaN(value) ? { bits: floatView.getUint32(0, true) } : value;
  },
});

const F64 = Binable<F64>({
  writeBytes(output, value) {
    if (typeof value === "number") floatView.setFloat64(0, value, true);
    else floatView.setBigUint64(0, value.bits, true);
    writeByteArray(output, floatBytes);
  },
  readBytes(input) {
    let { bytes, offset } = input;
    if (offset + 8 > bytes.length) throw Error("f64: unexpected end of input");
    for (let i = 0; i < 8; i++) floatView.setUint8(i, bytes[offset + i]);
    input.offset = offset + 8;
    const value = floatView.getFloat64(0, true);
    return Number.isNaN(value) ? { bits: floatView.getBigUint64(0, true) } : value;
  },
});
