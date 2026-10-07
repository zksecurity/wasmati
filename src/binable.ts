import type { Tuple } from "./util.ts";

export {
  Binable,
  Writer,
  lazy,
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
  /** Append the encoding to a writer. */
  write(writer: Writer, value: T): void;
  toBytes(value: T): number[];
  /** The encoding as bytes, written without intermediate arrays. */
  encode(value: T): Uint8Array<ArrayBuffer>;
  readBytes(bytes: number[], offset: number): [value: T, offset: number];
  fromBytes(bytes: number[] | Uint8Array): T;
};

/**
 * A codec, from a function that writes the encoding, or one that returns it. Writing is faster, so
 * codecs of things that are encoded often, like instructions, write.
 */
function Binable<T>(
  codec: (
    | { write(writer: Writer, t: T): void; toBytes?: undefined }
    | { toBytes(t: T): number[]; write?: undefined }
  ) & {
    readBytes(bytes: number[], offset: number): [value: T, offset: number];
  },
): Binable<T> {
  let { readBytes } = codec;
  let write =
    codec.write ??
    ((writer: Writer, t: T) => writer.bytes((codec.toBytes as (t: T) => number[])(t)));
  let encode = (t: T) => {
    let writer = new Writer();
    write(writer, t);
    return writer.result();
  };
  return {
    write,
    toBytes: codec.toBytes ?? ((t) => toArray(encode(t))),
    encode,
    readBytes,
    // spec: fromBytes throws if the input bytes are not all used
    fromBytes([...bytes]) {
      let [value, offset] = readBytes(bytes, 0);
      if (offset < bytes.length) throw Error("fromBytes: input bytes left over");
      return value;
    },
  };
}

/** The bytes as an array, which a loop creates much faster than `Array.from`. */
function toArray(bytes: Uint8Array): number[] {
  let array = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i++) array[i] = bytes[i];
  return array;
}

/** A growable buffer that encodings append to. */
class Writer {
  buffer: Uint8Array<ArrayBuffer>;
  length = 0;

  constructor(capacity = 1 << 12) {
    this.buffer = new Uint8Array(capacity);
  }

  /** Make room for `n` more bytes. */
  reserve(n: number) {
    if (this.length + n <= this.buffer.length) return;
    let buffer = new Uint8Array(Math.max(2 * this.buffer.length, this.length + n));
    buffer.set(this.buffer.subarray(0, this.length));
    this.buffer = buffer;
  }

  byte(b: number) {
    if (this.length === this.buffer.length) this.reserve(1);
    this.buffer[this.length++] = b;
  }

  bytes(bytes: ArrayLike<number>) {
    let n = bytes.length;
    this.reserve(n);
    let { buffer, length } = this;
    if (bytes instanceof Uint8Array) buffer.set(bytes, length);
    else for (let i = 0; i < n; i++) buffer[length + i] = bytes[i];
    this.length = length + n;
  }

  /** Bytes from `from` to `to` of a buffer. */
  copy(source: Uint8Array, from: number, to: number) {
    let n = to - from;
    this.reserve(n);
    this.buffer.set(source.subarray(from, to), this.length);
    this.length += n;
  }

  /** An unsigned LEB128 integer below 2^53. */
  unsigned(x: number) {
    this.reserve(8);
    let { buffer } = this;
    while (x >= 0x80) {
      buffer[this.length++] = (x % 0x80) | 0x80;
      x = Math.floor(x / 0x80);
    }
    buffer[this.length++] = x;
  }

  /** A signed LEB128 integer of 32 bits. */
  signed(x: number) {
    this.reserve(5);
    let { buffer } = this;
    while (true) {
      let byte = x & 0x7f;
      x >>= 7;
      if ((x === 0 && (byte & 0x40) === 0) || (x === -1 && (byte & 0x40) !== 0)) {
        buffer[this.length++] = byte;
        return;
      }
      buffer[this.length++] = byte | 0x80;
    }
  }

  /** A signed LEB128 integer of 64 bits, from its high 32 bits, signed, and its low 32 bits, unsigned. */
  signed64(high: number, low: number) {
    this.reserve(10);
    let { buffer } = this;
    while (true) {
      let byte = low & 0x7f;
      // Shift the 64 bits right by 7, keeping the sign.
      low = ((low >>> 7) | ((high & 0x7f) << 25)) >>> 0;
      high >>= 7;
      let done =
        (high === 0 && low === 0 && (byte & 0x40) === 0) ||
        (high === -1 && low === 0xffffffff && (byte & 0x40) !== 0);
      if (done) {
        buffer[this.length++] = byte;
        return;
      }
      buffer[this.length++] = byte | 0x80;
    }
  }

  /**
   * Write what `body` writes, preceded by its length in bytes as an unsigned LEB128 integer. The
   * length takes at most 5 bytes, which are reserved, and the body moves back if it takes fewer.
   */
  withLength(body: () => void) {
    this.reserve(5);
    let start = this.length;
    this.length += 5;
    body();
    let end = this.length;
    let length = end - start - 5;
    let size = 1;
    while (length >= 0x80 ** size) size++;
    if (size > 5) throw Error("withLength: length beyond 32 bits");
    // The body may have grown the buffer; the prefix needs no more room than was reserved.
    let { buffer } = this;
    if (size < 5) buffer.copyWithin(start + size, start + 5, end);
    for (let i = 0; i < size; i++) {
      buffer[start + i] = (length % 0x80) | (i < size - 1 ? 0x80 : 0);
      length = Math.floor(length / 0x80);
    }
    this.length = end - (5 - size);
  }

  result(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.length);
  }
}

type Byte = number;
const Byte = Binable<number>({
  write(writer, b) {
    writer.byte(b);
  },
  readBytes(bytes, offset) {
    if (offset >= bytes.length) throw Error("unexpected end");
    return [bytes[offset], offset + 1];
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
  return Binable({
    write(writer, values) {
      for (let i = 0; i < values.length; i++) element.write(writer, values[i]);
    },
    readBytes(bytes, offset) {
      const values: T[] = [];
      while (offset < bytes.length) {
        const [value, end] = element.readBytes(bytes, offset);
        if (end <= offset || end > bytes.length) throw Error("invalid sequence element length");
        values.push(value);
        offset = end;
      }
      return [values, offset];
    },
  });
}

type Bool = boolean;
const Bool = Binable<boolean>({
  write(writer, b) {
    writer.byte(Number(b));
  },
  readBytes(bytes, offset) {
    let byte = bytes[offset];
    if (byte !== 0 && byte !== 1) {
      throw Error("not a valid boolean");
    }
    return [!!byte, offset + 1];
  },
});

/** A codec that is defined later, for codecs that refer to each other through modules. */
function lazy<T>(get: () => Binable<T>): Binable<T> {
  let codec: Binable<T> | undefined;
  return Binable({
    write: (writer, t) => (codec ??= get()).write(writer, t),
    readBytes: (bytes, offset) => (codec ??= get()).readBytes(bytes, offset),
  });
}

function withByteCode<T>(code: number, binable: Binable<T>): Binable<T> {
  return Binable({
    write(writer, t) {
      writer.byte(code);
      binable.write(writer, t);
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
    write(writer, t) {
      writer.bytes(preamble);
      binable.write(writer, t);
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
  return Binable<T>({
    write(writer, t) {
      validate(t);
      binable.write(writer, t);
    },
    readBytes(bytes, offset) {
      let [t, end] = binable.readBytes(bytes, offset);
      validate(t);
      return [t, end];
    },
  });
}

type Union<T extends Tuple<any>> = T[number];

function record<Types extends Record<string, any>>(binables: {
  [i in keyof Types]-?: Binable<Types[i]>;
}): Binable<Types> {
  let keys = Object.keys(binables);
  let binablesTuple = keys.map((key) => binables[key]) as Tuple<Binable<any>>;
  let tupleBinable = tuple<Tuple<any>>(binablesTuple);
  return Binable({
    write(writer, t) {
      for (let i = 0; i < keys.length; i++) binablesTuple[i].write(writer, t[keys[i]]);
    },
    readBytes(bytes, start) {
      let [tupleValue, end] = tupleBinable.readBytes(bytes, start);
      let value = Object.fromEntries(keys.map((key, i) => [key, tupleValue[i]])) as any;
      return [value, end];
    },
  });
}

function tuple<Types extends Tuple<any>>(binables: {
  [i in keyof Types]: Binable<Types[i]>;
}): Binable<Types> {
  let n = (binables as any[]).length;
  return Binable({
    write(writer, t) {
      for (let i = 0; i < n; i++) binables[i].write(writer, t[i]);
    },
    readBytes(bytes, offset) {
      let values: Types[number] = [];
      for (let i = 0; i < n; i++) {
        let [value, newOffset] = binables[i].readBytes(bytes, offset);
        offset = newOffset;
        values.push(value);
      }
      return [values as Types, offset];
    },
  });
}

function array<T>(binable: Binable<T>, size: number): Binable<T[]> {
  return Binable({
    write(writer, ts) {
      if (ts.length !== size) throw Error("array length mismatch");
      for (let i = 0; i < size; i++) binable.write(writer, ts[i]);
    },
    readBytes(bytes, offset) {
      let values: T[] = [];
      for (let i = 0; i < size; i++) {
        let [value, newOffset] = binable.readBytes(bytes, offset);
        offset = newOffset;
        values.push(value);
      }
      return [values, offset];
    },
  });
}

function iso<T, S>(binable: Binable<T>, { to, from }: { to(s: S): T; from(t: T): S }): Binable<S> {
  return Binable({
    write(writer, s: S) {
      binable.write(writer, to(s));
    },
    readBytes(bytes, offset) {
      let [value, end] = binable.readBytes(bytes, offset);
      return [from(value), end];
    },
  });
}

function constant<const C>(c: C) {
  return Binable<C>({
    write() {},
    readBytes(_bytes, offset) {
      return [c, offset];
    },
  });
}

type Zero = never;
const Zero = Binable<never>({
  write() {
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
    write(writer, value) {
      let result = distinguish(value);
      if (result === undefined) throw Error("or: input matches no allowed type");
      let binable = typeof result === "number" ? binables[result] : result;
      binable.write(writer, value);
    },
    readBytes(bytes, offset) {
      let n = (binables as any[]).length;
      for (let i = 0; i < n; i++) {
        try {
          let [value, end] = binables[i].readBytes(bytes, offset);
          let selected = distinguish(value);
          if (selected === binables[i] || selected === i) return [value, end];
        } catch {}
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
    write(writer, { kind, value }) {
      let byte = kindToByte[kind];
      writer.byte(byte);
      binables[byte].value.write(writer, value);
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
    write(writer, { value, extras }) {
      for (const entry of extras) {
        if (entry.after !== undefined && entry.after !== null && !keys.includes(entry.after)) {
          throw Error(`invalid interleaved record position ${String(entry.after)}`);
        }
      }
      const at = (after: keyof Types | null | undefined) => {
        for (const entry of extras)
          if (entry.after === after) extra.codec.write(writer, entry.value);
      };
      at(undefined);
      for (const key of keys) {
        binables[key].write(writer, value[key]);
        at(key);
      }
      at(null);
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
