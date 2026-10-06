import type { Tuple } from "./util.ts";
import * as C from "./codec.ts";

export {
  Binable,
  tuple,
  record,
  array,
  iso,
  constant,
  withByteCode,
  withPreamble,
  withValidation,
  Byte,
  Bool,
  One,
  Zero,
  Undefined,
  or,
  and,
  orUndefined,
  orDefault,
  byteEnum,
  RemainingBytes,
  sequence,
  interleavedRecord,
  Zero as TODO,
};

type Binable<T> = {
  toBytes(value: T): number[];
  readBytes(bytes: number[], offset: number): [value: T, offset: number];
  fromBytes(bytes: number[] | Uint8Array): T;
  encode(value: T): number[];
  decode(bytes: number[], offset: number): [value: T, offset: number];
};

function Binable<T>({
  toBytes,
  readBytes,
}: {
  toBytes(t: T): number[];
  readBytes(bytes: number[], offset: number): [value: T, offset: number];
}): Binable<T> {
  return {
    toBytes,
    readBytes,
    // spec: fromBytes throws if the input bytes are not all used
    fromBytes([...bytes]) {
      let [value, offset] = readBytes(bytes, 0);
      if (offset < bytes.length) throw Error("fromBytes: input bytes left over");
      return value;
    },
    encode: toBytes,
    decode: readBytes,
  };
}

type Byte = number;
const Byte = Binable<number>({
  toBytes(b) {
    return [b];
  },
  readBytes(bytes, offset) {
    let byte = bytes[offset];
    return [byte, offset + 1];
  },
});

/** Read or write raw bytes without a length prefix. Decoding consumes all remaining input; wrap in withByteLength when followed by other fields. */
const RemainingBytes = Binable<number[]>({
  toBytes(bytes) {
    return bytes;
  },
  readBytes(bytes, offset) {
    return [bytes.slice(offset), bytes.length];
  },
});

/**
 * Encode an array by concatenating element encodings, without the count prefix used by vec. Decoding repeats the element codec until the input ends; each element must consume at least one byte.
 *
 * Wrap in withByteLength to delimit the sequence when it appears before other fields in a record.
 */
function sequence<T>(element: Binable<T>): Binable<T[]> {
  return binary(C.sequence(element));
}

type Bool = boolean;
const Bool = Binable<boolean>({
  toBytes(b) {
    return [Number(b)];
  },
  readBytes(bytes, offset) {
    let byte = bytes[offset];
    if (byte !== 0 && byte !== 1) {
      throw Error("not a valid boolean");
    }
    return [!!byte, offset + 1];
  },
});

function withByteCode<T>(code: number, binable: Binable<T>): Binable<T> {
  return Binable({
    toBytes(t) {
      return [code].concat(binable.toBytes(t));
    },
    readBytes(bytes, offset) {
      if (bytes[offset++] !== code) throw Error("invalid start byte");
      return binable.readBytes(bytes, offset);
    },
  });
}

function withPreamble<T>(preamble: number[], binable: Binable<T>): Binable<T> {
  let length = preamble.length;
  return Binable({
    toBytes(t) {
      return preamble.concat(binable.toBytes(t));
    },
    readBytes(bytes, offset) {
      for (let i = 0; i < length; i++) {
        if (bytes[offset + i] !== preamble[i]) throw Error("invalid preamble");
      }
      return binable.readBytes(bytes, offset + length);
    },
  });
}

function withValidation<T>(binable: Binable<T>, validate: (t: T) => void) {
  return binary(C.withValidation(binable, validate));
}

type Union<T extends Tuple<any>> = T[number];

function record<Types extends Record<string, any>>(binables: {
  [K in keyof Types]-?: Binable<Types[K]>;
}): Binable<Types> {
  return binary(C.record(binables));
}

function tuple<Types extends Tuple<any>>(binables: {
  [K in keyof Types]: Binable<Types[K]>;
}): Binable<Types> {
  return binary(C.tuple(binables));
}

function array<T>(binable: Binable<T>, size: number): Binable<T[]> {
  return binary(C.array(binable, size));
}

function iso<T, S>(
  binable: Binable<T>,
  mapping: { to(value: S): T; from(value: T): S },
): Binable<S> {
  return binary(C.iso(binable, mapping));
}

function constant<const C>(value: C) {
  return binary(C.constant<C, number>(value));
}

// A byte codec exposes both the shared sequence operations and the concrete binary entry points.
function binary<T>(codec: C.Codec<T, number>): Binable<T> {
  return Binable({ toBytes: codec.encode, readBytes: codec.decode });
}

type Zero = never;
const Zero = Binable<never>({
  toBytes() {
    throw Error("can not write Zero");
  },
  readBytes() {
    throw Error("can not parse Zero");
  },
});
type One = undefined;
const One = constant(undefined);
type Undefined = undefined;
const Undefined = One;

const and = tuple;

function or<Types extends Tuple<any>>(
  binables: { [K in keyof Types]: Binable<Types[K]> },
  distinguish: (
    t: Union<Types>,
  ) => { [K in keyof Types]: Binable<Types[K]> }[number] | number | undefined,
): Binable<Union<Types>> {
  return binary(C.or(binables, distinguish));
}

function orUndefined<T>(binable: Binable<T>): Binable<T | undefined> {
  return binary(C.orUndefined(binable));
}

function orDefault<T>(
  binable: Binable<T>,
  defaultValue: T,
  isDefault: (t: T) => boolean,
): Binable<T> {
  return binary(C.orDefault(binable, defaultValue, isDefault));
}

function byteEnum<Enum extends Record<number, { kind: string; value: any }>>(binables: {
  [b in keyof Enum & number]: {
    kind: Enum[b]["kind"];
    value: Binable<Enum[b]["value"]>;
  };
}): Binable<Enum[keyof Enum & number]> {
  let kindToByte = Object.fromEntries(
    Object.entries(binables).map(([byte, { kind }]) => [kind, Number(byte)]),
  );
  return Binable({
    toBytes({ kind, value }) {
      let byte = kindToByte[kind];
      let binable = binables[byte].value;
      return [byte].concat(binable.toBytes(value));
    },
    readBytes(bytes, offset) {
      let byte = bytes[offset++];
      let entry = binables[byte];
      if (entry === undefined) throw Error(`byte ${byte} matches none of the possible types`);
      let { kind, value: binable } = entry;
      let [value, end] = binable.readBytes(bytes, offset);
      return [{ kind, value }, end];
    },
  });
}

/**
 * Compose an ordered record with extra entries at field boundaries. The result is { value: recordFields, extras: [{ after, value: extraEntry }] }; matches selects the extra codec before each field and after the last field.
 *
 * On encoding, after: undefined places an entry before the first field, a field key places it after that field (even when omitted), and null appends it after all fields. Entries at the same position retain their array order.
 *
 * On decoding, after identifies the last field that consumed bytes, or undefined before the first field. Optional fields use their existing codecs and do not claim a position when absent. This allows custom Wasm sections to interleave with standard sections while retaining their placement.
 */
function interleavedRecord<Types extends Record<string, any>, Extra>(
  binables: { [K in keyof Types]: Binable<Types[K]> },
  extra: { codec: Binable<Extra>; matches(bytes: number[], offset: number): boolean },
): Binable<{
  value: Types;
  extras: { after?: keyof Types | null; value: Extra }[];
}> {
  const keys = Object.keys(binables) as (keyof Types)[];
  return Binable({
    toBytes({ value, extras }) {
      for (const entry of extras) {
        if (entry.after !== undefined && entry.after !== null && !keys.includes(entry.after)) {
          throw Error(`invalid interleaved record position ${String(entry.after)}`);
        }
      }
      const at = (after: keyof Types | null | undefined) =>
        extras
          .filter((entry) => entry.after === after)
          .flatMap((entry) => extra.codec.toBytes(entry.value));
      return [
        at(undefined),
        ...keys.map((key) => [binables[key].toBytes(value[key]), at(key)].flat()),
        at(null),
      ].flat();
    },
    readBytes(bytes, offset) {
      const value = {} as Types;
      const extras: { after?: keyof Types | null; value: Extra }[] = [];
      let after: keyof Types | undefined;
      const readExtras = () => {
        while (offset < bytes.length && extra.matches(bytes, offset)) {
          const [value, end] = extra.codec.readBytes(bytes, offset);
          if (end <= offset || end > bytes.length) throw Error("invalid interleaved entry length");
          extras.push({ after, value });
          offset = end;
        }
      };
      for (const key of keys) {
        readExtras();
        const [field, end] = binables[key].readBytes(bytes, offset);
        value[key] = field;
        if (end > offset) after = key;
        offset = end;
      }
      readExtras();
      return [{ value, extras }, offset];
    },
  });
}
