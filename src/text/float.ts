import * as C from "../codec.ts";
import { Atom, Text } from "./text.ts";
import { TextSyntaxError } from "./lexer.ts";
import { UnsupportedTextError } from "./lexer.ts";

export { F32, F64 };

/** Parse finite decimal/hex literals with one ties-to-even rounding, including f32 double-rounding cases. */
function float(bits: 32 | 64): Text<number> {
  const precision = bits === 32 ? 23 : 52;
  const minExponent = bits === 32 ? -126 : -1022;
  const maxExponent = bits === 32 ? 127 : 1023;
  return Text(
    C.iso(Atom, {
      to(value: number) {
        if (Number.isNaN(value))
          throw new UnsupportedTextError("NaN payload representation is not implemented");
        if (Object.is(value, -0)) return "-0";
        if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
        return value.toString();
      },
      from(text) {
        const negative = text.startsWith("-");
        const magnitude = text.replace(/^[+-]/, "");
        if (magnitude.startsWith("nan"))
          throw new UnsupportedTextError("NaN payload representation is not implemented");
        if (magnitude === "inf") return negative ? -Infinity : Infinity;
        const hex = magnitude.startsWith("0x");
        const digits = "[0-9](?:_?[0-9])*";
        const hexDigits = "[0-9a-fA-F](?:_?[0-9a-fA-F])*";
        const pattern = new RegExp(
          hex
            ? `^0x(${hexDigits})(?:\\.(${hexDigits})?)?(?:[pP]([+-]?${digits}))?$`
            : `^(${digits})(?:\\.(${digits})?)?(?:[eE]([+-]?${digits}))?$`,
        );
        const match = magnitude.match(pattern);
        if (match === null) throw new TextSyntaxError(`expected f${bits} literal`);
        const fraction = (match[2] ?? "").replaceAll("_", "");
        const coefficient = BigInt((hex ? "0x" : "") + match[1].replaceAll("_", "") + fraction);
        if (coefficient === 0n) return negative ? -0 : 0;
        const power =
          Number((match[3] ?? "0").replaceAll("_", "")) - fraction.length * (hex ? 4 : 1);
        const bitLength = (value: bigint) => value.toString(2).length;
        const estimated = bitLength(coefficient) - 1 + power * (hex ? 1 : Math.log2(10));
        if (estimated > maxExponent + 2) throw new TextSyntaxError(`f${bits} literal overflows`);
        if (estimated < minExponent - precision - 2) return negative ? -0 : 0;
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
        if (!Number.isFinite(value) || (bits === 32 && !Number.isFinite(Math.fround(value)))) {
          throw new TextSyntaxError(`f${bits} literal overflows`);
        }
        return negative ? -value : value;
      },
    }),
  );
}

const F32 = float(32);
const F64 = float(64);
