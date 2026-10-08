import type { Tuple } from "./util.ts";

export {
  Binable,
  type ByteCursor,
  byteCursor,
  writtenBytes,
  readByte,
  reserve,
  writeByte,
  writeByteArray,
  writeUnsignedLEB,
  writeSignedLEB,
  writeSigned64LEB,
  writeWithLength,
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

/**
 * A codec. `toBytes()` and `fromBytes()` encode and decode values; `writeBytes()` and `readBytes()` are
 * the hooks of composed codecs, which write and read at the offset of a cursor and advance it.
 */
type Binable<T> = {
  /** Bytes of their own buffer, which Wasm compiles; shared buffers it doesn't. */
  toBytes(value: T): Uint8Array<ArrayBuffer>;
  /** Any bytes, also of a shared buffer. */
  fromBytes(bytes: Uint8Array): T;
  readBytes(input: ByteCursor): T;
  writeBytes(output: ByteCursor, value: T): void;
};

function Binable<T>({
  writeBytes,
  readBytes,
}: {
  writeBytes(output: ByteCursor, value: T): void;
  readBytes(input: ByteCursor): T;
}): Binable<T> {
  return {
    toBytes(value) {
      let output = byteCursor();
      writeBytes(output, value);
      return writtenBytes(output);
    },
    // spec: fromBytes throws if the input bytes are not all used
    fromBytes(bytes) {
      let input: ByteCursor = { bytes, offset: 0 };
      let value = readBytes(input);
      if (input.offset < bytes.length) throw Error("fromBytes: input bytes left over");
      return value;
    },
    readBytes,
    writeBytes,
  };
}

/**
 * Bytes and an offset into them, where codecs read and write. Writing advances the offset, and when
 * the bytes are full, replaces them by larger ones.
 */
type ByteCursor = { bytes: Uint8Array; offset: number };

/** A cursor to write into, at the start of empty bytes. */
function byteCursor(capacity = 1 << 12): ByteCursor {
  return { bytes: new Uint8Array(capacity), offset: 0 };
}

/** The bytes written so far. */
function writtenBytes({ bytes, offset }: ByteCursor): Uint8Array<ArrayBuffer> {
  return bytes.slice(0, offset);
}

/** The byte at the offset, which it advances past. */
function readByte(input: ByteCursor): number {
  if (input.offset >= input.bytes.length) throw Error("unexpected end");
  return input.bytes[input.offset++];
}

/** Make room for `n` more bytes. */
function reserve(output: ByteCursor, n: number) {
  let { bytes, offset } = output;
  if (offset + n <= bytes.length) return;
  let larger = new Uint8Array(Math.max(2 * bytes.length, offset + n));
  larger.set(bytes.subarray(0, offset));
  output.bytes = larger;
}

function writeByte(output: ByteCursor, byte: number) {
  if (output.offset === output.bytes.length) reserve(output, 1);
  output.bytes[output.offset++] = byte;
}

function writeByteArray(output: ByteCursor, array: ArrayLike<number>) {
  let n = array.length;
  reserve(output, n);
  let { bytes, offset } = output;
  if (array instanceof Uint8Array) bytes.set(array, offset);
  else for (let i = 0; i < n; i++) bytes[offset + i] = array[i];
  output.offset = offset + n;
}

/** An unsigned LEB128 integer below 2^53. */
function writeUnsignedLEB(output: ByteCursor, x: number) {
  reserve(output, 8);
  let { bytes } = output;
  while (x >= 0x80) {
    bytes[output.offset++] = (x % 0x80) | 0x80;
    x = Math.floor(x / 0x80);
  }
  bytes[output.offset++] = x;
}

/** A signed LEB128 integer of 32 bits. */
function writeSignedLEB(output: ByteCursor, x: number) {
  reserve(output, 5);
  let { bytes } = output;
  while (true) {
    let byte = x & 0x7f;
    x >>= 7;
    if ((x === 0 && (byte & 0x40) === 0) || (x === -1 && (byte & 0x40) !== 0)) {
      bytes[output.offset++] = byte;
      return;
    }
    bytes[output.offset++] = byte | 0x80;
  }
}

/** A signed LEB128 integer of 64 bits, from its high 32 bits, signed, and its low 32 bits, unsigned. */
function writeSigned64LEB(output: ByteCursor, high: number, low: number) {
  reserve(output, 10);
  let { bytes } = output;
  while (true) {
    let byte = low & 0x7f;
    // Shift the 64 bits right by 7, keeping the sign.
    low = ((low >>> 7) | ((high & 0x7f) << 25)) >>> 0;
    high >>= 7;
    let done =
      (high === 0 && low === 0 && (byte & 0x40) === 0) ||
      (high === -1 && low === 0xffffffff && (byte & 0x40) !== 0);
    if (done) {
      bytes[output.offset++] = byte;
      return;
    }
    bytes[output.offset++] = byte | 0x80;
  }
}

/**
 * Write what `body` writes, preceded by its length in bytes as an unsigned LEB128 integer. The length
 * takes at most 5 bytes, which are reserved, and the body moves back if it takes fewer.
 */
function writeWithLength(output: ByteCursor, body: () => void) {
  reserve(output, 5);
  let start = output.offset;
  output.offset += 5;
  body();
  let end = output.offset;
  let length = end - start - 5;
  let size = 1;
  while (length >= 0x80 ** size) size++;
  if (size > 5) throw Error("writeWithLength: length beyond 32 bits");
  // The body may have replaced the bytes; the prefix needs no more room than was reserved.
  let { bytes } = output;
  if (size < 5) bytes.copyWithin(start + size, start + 5, end);
  for (let i = 0; i < size; i++) {
    bytes[start + i] = (length % 0x80) | (i < size - 1 ? 0x80 : 0);
    length = Math.floor(length / 0x80);
  }
  output.offset = end - (5 - size);
}

type Byte = number;
const Byte = Binable<number>({
  writeBytes(output, b) {
    writeByte(output, b);
  },
  readBytes: readByte,
});

/** Read or write raw bytes without a length prefix. Decoding consumes all remaining input; wrap in withByteLength when followed by other fields. */
const RemainingBytes = Binable<Uint8Array>({
  writeBytes(output, bytes) {
    writeByteArray(output, bytes);
  },
  readBytes(input) {
    let bytes = input.bytes.slice(input.offset);
    input.offset = input.bytes.length;
    return bytes;
  },
});

/**
 * Encode an array by concatenating element encodings, without the count prefix used by vec. Decoding repeats the element codec until the input ends; each element must consume at least one byte.
 *
 * Wrap in withByteLength to delimit the sequence when it appears before other fields in a record.
 */
function sequence<T>(element: Binable<T>): Binable<T[]> {
  return Binable({
    writeBytes(output, values) {
      for (let value of values) element.writeBytes(output, value);
    },
    readBytes(input) {
      const values: T[] = [];
      while (input.offset < input.bytes.length) {
        let start = input.offset;
        values.push(element.readBytes(input));
        if (input.offset <= start || input.offset > input.bytes.length)
          throw Error("invalid sequence element length");
      }
      return values;
    },
  });
}

type Bool = boolean;
const Bool = Binable<boolean>({
  writeBytes(output, b) {
    writeByte(output, Number(b));
  },
  readBytes(input) {
    let byte = input.bytes[input.offset++];
    if (byte !== 0 && byte !== 1) {
      throw Error("not a valid boolean");
    }
    return !!byte;
  },
});

function withByteCode<T>(code: number, binable: Binable<T>): Binable<T> {
  return Binable({
    writeBytes(output, t) {
      writeByte(output, code);
      binable.writeBytes(output, t);
    },
    readBytes(input) {
      if (input.bytes[input.offset++] !== code) throw Error("invalid start byte");
      return binable.readBytes(input);
    },
  });
}

function withPreamble<T>(preamble: number[], binable: Binable<T>): Binable<T> {
  let length = preamble.length;
  return Binable({
    writeBytes(output, t) {
      writeByteArray(output, preamble);
      binable.writeBytes(output, t);
    },
    readBytes(input) {
      for (let i = 0; i < length; i++) {
        if (input.bytes[input.offset + i] !== preamble[i]) throw Error("invalid preamble");
      }
      input.offset += length;
      return binable.readBytes(input);
    },
  });
}

function withValidation<T>(binable: Binable<T>, validate: (t: T) => void) {
  return Binable<T>({
    writeBytes(output, t) {
      validate(t);
      binable.writeBytes(output, t);
    },
    readBytes(input) {
      let t = binable.readBytes(input);
      validate(t);
      return t;
    },
  });
}

type Union<T extends Tuple<any>> = T[number];

function record<Types extends Record<string, any>>(binables: {
  [i in keyof Types]-?: Binable<Types[i]>;
}): Binable<Types> {
  let keys = Object.keys(binables);
  let binablesTuple = keys.map((key) => binables[key]) as Tuple<Binable<any>>;
  return Binable({
    writeBytes(output, t) {
      for (let i = 0; i < keys.length; i++) binablesTuple[i].writeBytes(output, t[keys[i]]);
    },
    readBytes(input) {
      let value: any = {};
      for (let i = 0; i < keys.length; i++) value[keys[i]] = binablesTuple[i].readBytes(input);
      return value;
    },
  });
}

function tuple<Types extends Tuple<any>>(binables: {
  [i in keyof Types]: Binable<Types[i]>;
}): Binable<Types> {
  let n = (binables as any[]).length;
  return Binable({
    writeBytes(output, t) {
      for (let i = 0; i < n; i++) binables[i].writeBytes(output, t[i]);
    },
    readBytes(input) {
      let values: Types[number] = [];
      for (let i = 0; i < n; i++) values.push(binables[i].readBytes(input));
      return values as Types;
    },
  });
}

function array<T>(binable: Binable<T>, size: number): Binable<T[]> {
  return Binable({
    writeBytes(output, ts) {
      if (ts.length !== size) throw Error("array length mismatch");
      for (let i = 0; i < size; i++) binable.writeBytes(output, ts[i]);
    },
    readBytes(input) {
      let values: T[] = [];
      for (let i = 0; i < size; i++) values.push(binable.readBytes(input));
      return values;
    },
  });
}

function iso<T, S>(binable: Binable<T>, { to, from }: { to(s: S): T; from(t: T): S }): Binable<S> {
  return Binable({
    writeBytes(output, s: S) {
      binable.writeBytes(output, to(s));
    },
    readBytes(input) {
      return from(binable.readBytes(input));
    },
  });
}

function constant<const C>(c: C) {
  return Binable<C>({
    writeBytes() {},
    readBytes() {
      return c;
    },
  });
}

type Zero = never;
const Zero = Binable<never>({
  writeBytes() {
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
  binables: {
    [i in keyof Types]: Binable<Types[i]>;
  },
  distinguish: (t: Union<Types>) =>
    | {
        [i in keyof Types]: Binable<Types[i]>;
      }[number]
    | number
    | undefined,
): Binable<Union<Types>> {
  return Binable({
    writeBytes(output, value) {
      let result = distinguish(value);
      if (result === undefined) throw Error("or: input matches no allowed type");
      let binable = typeof result === "number" ? binables[result] : result;
      binable.writeBytes(output, value);
    },
    readBytes(input) {
      let n = (binables as any[]).length;
      let start = input.offset;
      for (let i = 0; i < n; i++) {
        try {
          let value = binables[i].readBytes(input);
          let selected = distinguish(value);
          if (selected === binables[i] || selected === i) return value;
        } catch {}
        input.offset = start;
      }
      throw Error("or: could not parse any of the possible types");
    },
  });
}

function orUndefined<T>(binable: Binable<T>): Binable<T | undefined> {
  return or([binable, One], (value) => (value === undefined ? One : binable));
}

function orDefault<T>(
  binable: Binable<T>,
  defaultValue: T,
  isDefault: (t: T) => boolean,
): Binable<T> {
  return iso(orUndefined(binable), {
    to: (t: T) => (isDefault(t) ? undefined : t),
    from: (t: T | undefined) => t ?? defaultValue,
  });
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
    writeBytes(output, { kind, value }) {
      let byte = kindToByte[kind];
      writeByte(output, byte);
      binables[byte].value.writeBytes(output, value);
    },
    readBytes(input) {
      let byte = input.bytes[input.offset++];
      let entry = binables[byte];
      if (entry === undefined) throw Error(`byte ${byte} matches none of the possible types`);
      let { kind, value: binable } = entry;
      return { kind, value: binable.readBytes(input) };
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
  extra: { codec: Binable<Extra>; matches(input: ByteCursor): boolean },
): Binable<{
  value: Types;
  extras: { after?: keyof Types | null; value: Extra }[];
}> {
  const keys = Object.keys(binables) as (keyof Types)[];
  return Binable({
    writeBytes(output, { value, extras }) {
      for (const entry of extras) {
        if (entry.after !== undefined && entry.after !== null && !keys.includes(entry.after)) {
          throw Error(`invalid interleaved record position ${String(entry.after)}`);
        }
      }
      const at = (after: keyof Types | null | undefined) => {
        for (const entry of extras)
          if (entry.after === after) extra.codec.writeBytes(output, entry.value);
      };
      at(undefined);
      for (const key of keys) {
        binables[key].writeBytes(output, value[key]);
        at(key);
      }
      at(null);
    },
    readBytes(input) {
      const value = {} as Types;
      const extras: { after?: keyof Types | null; value: Extra }[] = [];
      let after: keyof Types | undefined;
      const readExtras = () => {
        while (input.offset < input.bytes.length && extra.matches(input)) {
          let start = input.offset;
          const entry = extra.codec.readBytes(input);
          if (input.offset <= start || input.offset > input.bytes.length)
            throw Error("invalid interleaved entry length");
          extras.push({ after, value: entry });
        }
      };
      for (const key of keys) {
        readExtras();
        let start = input.offset;
        value[key] = binables[key].readBytes(input);
        if (input.offset > start) after = key;
      }
      readExtras();
      return { value, extras };
    },
  });
}
