import type { F32, F64 } from "../immediate.ts";
import { TextSyntaxError } from "./lexer.ts";

export { parseU32, parseUnsigned, parseInteger, parseFloat, printFloat };

const digits = "[0-9](?:_?[0-9])*";
const hexDigits = "[0-9a-fA-F](?:_?[0-9a-fA-F])*";
const unsigned = new RegExp(`^(?:${digits}|0x${hexDigits})$`);
const signed = new RegExp(`^[+-]?(?:${digits}|0x${hexDigits})$`);

/** Unsigned 32-bit literal, used for indices, lanes and alignment. */
function parseU32(text: string): number {
  return parseUnsigned(text, 32);
}

/**
 * Unsigned literal of up to `bits` bits. Offsets and limits are u64 in text: whether a value fits
 * a 32-bit memory or table is a matter of validation.
 */
function parseUnsigned(text: string, bits: 32 | 64): number {
  if (!unsigned.test(text)) throw new TextSyntaxError(`expected unsigned integer, got ${text}`);
  const value = BigInt(text.replaceAll("_", ""));
  if (value >= 1n << BigInt(bits))
    throw new TextSyntaxError(`integer ${text} outside u${bits} range`);
  return Number(value);
}

/**
 * An uninterpreted N-bit integer: unsigned spellings take the uN range, signed spellings the sN range.
 * Returns the signed interpretation of the bit pattern.
 */
function parseInteger(text: string, bits: number): bigint {
  if (!signed.test(text)) throw new TextSyntaxError(`expected integer, got ${text}`);
  const negative = text.startsWith("-");
  const magnitude = BigInt(text.replaceAll("_", "").replace(/^[+-]/, ""));
  const value = negative ? -magnitude : magnitude;
  const max = 1n << BigInt(bits);
  const upper = /^[+-]/.test(text) ? max / 2n : max;
  if (value < -max / 2n || value >= upper)
    throw new TextSyntaxError(`integer ${text} outside ${bits}-bit range`);
  return BigInt.asIntN(bits, value);
}

type Format = {
  precision: number;
  minExponent: number;
  maxExponent: number;
  write(view: DataView, value: number): void;
  read(view: DataView): number;
  readBits(view: DataView): bigint;
  writeBits(view: DataView, bits: bigint): void;
};
const formats: Record<32 | 64, Format> = {
  32: {
    precision: 23,
    minExponent: -126,
    maxExponent: 127,
    write: (view, value) => view.setFloat32(0, value),
    read: (view) => view.getFloat32(0),
    readBits: (view) => BigInt(view.getUint32(0)),
    writeBits: (view, bits) => view.setUint32(0, Number(bits)),
  },
  64: {
    precision: 52,
    minExponent: -1022,
    maxExponent: 1023,
    write: (view, value) => view.setFloat64(0, value),
    read: (view) => view.getFloat64(0),
    readBits: (view) => view.getBigUint64(0),
    writeBits: (view, bits) => view.setBigUint64(0, bits),
  },
};
const view = new DataView(new ArrayBuffer(8));

/**
 * Parse a float literal with exactly one ties-to-even rounding to the target width.
 * NaNs keep their exact sign and payload as bits; plain nan is the canonical NaN.
 */
function parseFloat(text: string, bits: 32): F32;
function parseFloat(text: string, bits: 64): F64;
function parseFloat(text: string, bits: 32 | 64): F32 | F64;
function parseFloat(text: string, bits: 32 | 64): F32 | F64 {
  const { precision, minExponent, maxExponent } = formats[bits];
  const negative = text.startsWith("-");
  const magnitude = text.replace(/^[+-]/, "");
  if (magnitude.startsWith("nan")) {
    const match = magnitude.match(new RegExp(`^nan(?::0x(${hexDigits}))?$`));
    if (match === null) throw new TextSyntaxError(`expected f${bits} NaN, got ${text}`);
    const canonical = 1n << BigInt(precision - 1);
    const payload =
      match[1] === undefined ? canonical : BigInt("0x" + match[1].replaceAll("_", ""));
    if (payload === 0n || payload >= 1n << BigInt(precision))
      throw new TextSyntaxError(`f${bits} NaN payload out of range in ${text}`);
    const exponent = BigInt(2 * maxExponent + 1) << BigInt(precision);
    const sign = negative ? 1n << BigInt(bits - 1) : 0n;
    const value = sign | exponent | payload;
    return bits === 32 ? { bits: Number(value) } : { bits: value };
  }
  if (magnitude === "inf") return negative ? -Infinity : Infinity;
  const hex = magnitude.startsWith("0x");
  const pattern = new RegExp(
    hex
      ? `^0x(${hexDigits})(?:\\.(${hexDigits})?)?(?:[pP]([+-]?${digits}))?$`
      : `^(${digits})(?:\\.(${digits})?)?(?:[eE]([+-]?${digits}))?$`,
  );
  const match = magnitude.match(pattern);
  if (match === null) throw new TextSyntaxError(`expected f${bits} literal, got ${text}`);
  const fraction = (match[2] ?? "").replaceAll("_", "");
  const coefficient = BigInt((hex ? "0x" : "") + match[1].replaceAll("_", "") + fraction);
  const zero = negative ? -0 : 0;
  if (coefficient === 0n) return zero;
  const power = Number((match[3] ?? "0").replaceAll("_", "")) - fraction.length * (hex ? 4 : 1);
  const bitLength = (value: bigint) => value.toString(2).length;
  // Cheap bounds before exact arithmetic, so huge exponents cannot allocate huge integers.
  const estimated = bitLength(coefficient) - 1 + power * (hex ? 1 : Math.log2(10));
  if (estimated > maxExponent + 2) throw new TextSyntaxError(`f${bits} literal ${text} overflows`);
  if (estimated < minExponent - precision - 2) return zero;
  const scale = BigInt(hex ? 2 : 10) ** BigInt(Math.abs(power));
  const numerator = power >= 0 ? coefficient * scale : coefficient;
  const denominator = power < 0 ? scale : 1n;
  let exponent = bitLength(numerator) - bitLength(denominator);
  const atLeastPower =
    exponent >= 0
      ? numerator >= denominator << BigInt(exponent)
      : numerator << BigInt(-exponent) >= denominator;
  if (!atLeastPower) exponent--;
  const unitExponent = Math.max(exponent, minExponent) - precision;
  const n = unitExponent < 0 ? numerator << BigInt(-unitExponent) : numerator;
  const d = unitExponent > 0 ? denominator << BigInt(unitExponent) : denominator;
  let rounded = n / d;
  const twiceRemainder = 2n * (n % d);
  if (twiceRemainder > d || (twiceRemainder === d && rounded % 2n !== 0n)) rounded++;
  const value = Number(rounded) * 2 ** unitExponent;
  if (!Number.isFinite(value) || (bits === 32 && !Number.isFinite(Math.fround(value))))
    throw new TextSyntaxError(`f${bits} literal ${text} overflows`);
  return negative ? -value : value;
}

/** Print the shortest decimal that parses back to the same value; NaNs print their exact payload. */
function printFloat(value: F32 | F64, bits: 32 | 64): string {
  const format = formats[bits];
  if (typeof value !== "number") {
    format.writeBits(view, BigInt(value.bits));
    const number = format.read(view);
    if (!Number.isNaN(number)) return printFloat(number, bits);
    const raw = format.readBits(view);
    const sign = raw >> BigInt(bits - 1) ? "-" : "";
    const payload = raw & ((1n << BigInt(format.precision)) - 1n);
    const canonical = payload === 1n << BigInt(format.precision - 1);
    return canonical ? `${sign}nan` : `${sign}nan:0x${payload.toString(16)}`;
  }
  if (Number.isNaN(value)) return "nan";
  if (Object.is(value, -0)) return "-0";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  if (bits === 32) {
    for (let digits = 1; digits < 9; digits++) {
      const text = Number(value.toPrecision(digits)).toString();
      if (Math.fround(Number(text)) === value && roundsTo(text, value)) return text;
    }
  }
  return value.toString();
}

/** Shorter decimal candidates may round differently, or even overflow, at f32 precision. */
function roundsTo(text: string, value: number): boolean {
  try {
    return parseFloat(text, 32) === value;
  } catch {
    return false;
  }
}
