import type { Tuple } from "./util.ts";

export {
  Codec,
  tuple,
  record,
  array,
  sequence,
  repeatWhile,
  iso,
  constant,
  or,
  orUndefined,
  orDefault,
  withValidation,
};

/** A bidirectional codec over a sequence of items: bytes, lexical tokens, or other symbols. */
type Codec<T, Item> = {
  encode(value: T): Item[];
  decode(input: Item[], offset: number): [value: T, offset: number];
};

/** Construct a codec without selecting a concrete input format. */
function Codec<T, Item>(codec: Codec<T, Item>): Codec<T, Item> {
  return codec;
}

/** Concatenate fixed ordered fields; decoding advances through the same fields. */
function tuple<Types extends Tuple<any>, Item>(codecs: {
  [K in keyof Types]: Codec<Types[K], Item>;
}): Codec<Types, Item> {
  return {
    encode(values) {
      return codecs.flatMap((codec, i) => codec.encode(values[i]));
    },
    decode(input, offset) {
      const values: unknown[] = [];
      for (const codec of codecs) {
        const [value, end] = codec.decode(input, offset);
        values.push(value);
        offset = end;
      }
      return [values as Types, offset];
    },
  };
}

/** Compose named fields in declaration order, without interpreting their names as input syntax. */
function record<Types extends Record<string, any>, Item>(codecs: {
  [K in keyof Types]-?: Codec<Types[K], Item>;
}): Codec<Types, Item> {
  const keys = Object.keys(codecs) as (keyof Types)[];
  return {
    encode(value) {
      return keys.flatMap((key) => codecs[key].encode(value[key]));
    },
    decode(input, offset) {
      const entries: [keyof Types, unknown][] = [];
      for (const key of keys) {
        const [value, end] = codecs[key].decode(input, offset);
        entries.push([key, value]);
        offset = end;
      }
      return [Object.fromEntries(entries) as Types, offset];
    },
  };
}

/** Repeat a codec exactly size times; the encoded array must have that size. */
function array<T, Item>(element: Codec<T, Item>, size: number): Codec<T[], Item> {
  return {
    encode(values) {
      if (values.length !== size) throw Error("array length mismatch");
      return values.flatMap((value) => element.encode(value));
    },
    decode(input, offset) {
      const values: T[] = [];
      for (let i = 0; i < size; i++) {
        const [value, end] = element.decode(input, offset);
        values.push(value);
        offset = end;
      }
      return [values, offset];
    },
  };
}

/** Repeat until the input ends. Use a format-specific delimiter when more input follows the sequence. */
function sequence<T, Item>(element: Codec<T, Item>): Codec<T[], Item> {
  return repeatWhile(element, (input, offset) => offset < input.length);
}

/** Repeat while lookahead matches. A matching but malformed element propagates its error; it does not silently end the sequence. */
function repeatWhile<T, Item>(
  element: Codec<T, Item>,
  matches: (input: Item[], offset: number) => boolean,
): Codec<T[], Item> {
  return {
    encode(values) {
      return values.flatMap((value) => element.encode(value));
    },
    decode(input, offset) {
      const values: T[] = [];
      while (matches(input, offset)) {
        const [value, end] = element.decode(input, offset);
        if (end <= offset || end > input.length) throw Error("invalid sequence element length");
        values.push(value);
        offset = end;
      }
      return [values, offset];
    },
  };
}

/** Map the codec's value type in both directions while retaining its input representation. */
function iso<T, S, Item>(
  codec: Codec<T, Item>,
  { to, from }: { to(value: S): T; from(value: T): S },
): Codec<S, Item> {
  return {
    encode(value) {
      return codec.encode(to(value));
    },
    decode(input, offset) {
      const [value, end] = codec.decode(input, offset);
      return [from(value), end];
    },
  };
}

/** Supply a value without consuming or emitting input. */
function constant<const T, Item>(value: T): Codec<T, Item> {
  return { encode: () => [], decode: (_, offset) => [value, offset] };
}

/** Check the decoded or supplied value; validation happens in both directions. */
function withValidation<T, Item>(
  codec: Codec<T, Item>,
  validate: (value: T) => void,
): Codec<T, Item> {
  return {
    encode(value) {
      validate(value);
      return codec.encode(value);
    },
    decode(input, offset) {
      const [value, end] = codec.decode(input, offset);
      validate(value);
      return [value, end];
    },
  };
}

/** Try alternatives in order. distinguish selects the representation when printing and confirms it when parsing. */
function or<Types extends Tuple<any>, Item>(
  codecs: { [K in keyof Types]: Codec<Types[K], Item> },
  distinguish: (value: Types[number]) => Codec<Types[number], Item> | number | undefined,
): Codec<Types[number], Item> {
  const select = (value: Types[number]) => {
    const selected = distinguish(value);
    return typeof selected === "number" ? codecs[selected] : selected;
  };
  return {
    encode(value) {
      const codec = select(value);
      if (codec === undefined) throw Error("or: input matches no allowed type");
      return codec.encode(value);
    },
    decode(input, offset) {
      for (const codec of codecs) {
        try {
          const [value, end] = codec.decode(input, offset);
          if (select(value) === codec) return [value, end];
        } catch {}
      }
      throw Error("or: could not parse any of the possible types");
    },
  };
}

/** Omit undefined values; a failed parse leaves input untouched and returns undefined. */
function orUndefined<T, Item>(codec: Codec<T, Item>): Codec<T | undefined, Item> {
  const empty = constant<undefined, Item>(undefined);
  return or([codec, empty], (value) => (value === undefined ? empty : codec));
}

/** Omit default values, substituting the same default when the optional codec is absent. */
function orDefault<T, Item>(
  codec: Codec<T, Item>,
  defaultValue: T,
  isDefault: (value: T) => boolean,
): Codec<T, Item> {
  return iso(orUndefined(codec), {
    to: (value: T) => (isDefault(value) ? undefined : value),
    from: (value) => value ?? defaultValue,
  });
}
