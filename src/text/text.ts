import * as C from "../codec.ts";
import { printTokens, tokenize, TextSyntaxError, type Token } from "./lexer.ts";

export { Text, keyword, list, Atom, Bytes, Name, Identifier, U32, I32, I64, SExpression, Script };
export type { Expression };

type Text<T> = {
  encode(value: T): Token[];
  decode(tokens: Token[], offset: number): [value: T, offset: number];
  toText(value: T): string;
  fromText(source: string): T;
};

/** Give a token codec complete-source parsing and canonical printing entry points. */
function Text<T>(codec: C.Codec<T, Token>): Text<T> {
  return {
    encode: codec.encode,
    decode: codec.decode,
    toText(value) {
      return printTokens(codec.encode(value));
    },
    fromText(source) {
      try {
        const tokens = tokenize(source);
        const [value, offset] = codec.decode(tokens, 0);
        if (offset !== tokens.length) {
          throw new TextSyntaxError("unexpected trailing token", tokens[offset]?.offset);
        }
        return value;
      } catch (error) {
        if (error instanceof TextSyntaxError && error.offset !== undefined) {
          const prefix = source.slice(0, error.offset);
          const lines = prefix.split(/\r\n|[\r\n]/);
          error.message += ` at ${lines.length}:${lines.at(-1)!.length + 1}`;
        }
        throw error;
      }
    },
  };
}

/** A literal grammar keyword. The value contributes no semantic field. */
function keyword(word: string): C.Codec<undefined, Token> {
  return {
    encode: () => [{ kind: "atom", text: word }],
    decode(tokens, offset) {
      if (tokens[offset]?.kind !== "atom" || tokens[offset].text !== word) {
        throw new TextSyntaxError(`expected ${word}`, tokens[offset]?.offset);
      }
      return [undefined, offset + 1];
    },
  };
}

/** Delimit a codec with parentheses. The inner decoder cannot consume following fields. */
function list<T>(inner: C.Codec<T, Token>): C.Codec<T, Token> {
  return {
    encode: (value) => [{ kind: "(", text: "(" }, ...inner.encode(value), { kind: ")", text: ")" }],
    decode(tokens, offset) {
      const start = offset;
      if (tokens[offset]?.kind !== "(") {
        throw new TextSyntaxError("expected opening parenthesis", tokens[offset]?.offset);
      }
      let depth = 1;
      while (++offset < tokens.length) {
        if (tokens[offset].kind === "(") depth++;
        if (tokens[offset].kind === ")" && --depth === 0) break;
      }
      if (depth !== 0) throw new TextSyntaxError("unclosed parenthesis", tokens[start].offset);
      const contents = tokens.slice(start + 1, offset);
      const [value, end] = inner.decode(contents, 0);
      if (end !== contents.length) {
        throw new TextSyntaxError("unexpected token inside parentheses", contents[end]?.offset);
      }
      return [value, offset + 1];
    },
  };
}

const Atom = Text<string>({
  encode: (text) => {
    const tokens = tokenize(text);
    if (tokens.length !== 1 || tokens[0].kind !== "atom" || tokens[0].text !== text) {
      throw Error("expected a single atom");
    }
    return [{ kind: "atom", text }];
  },
  decode(tokens, offset) {
    if (tokens[offset]?.kind !== "atom") {
      throw new TextSyntaxError("expected atom", tokens[offset]?.offset);
    }
    return [tokens[offset].text, offset + 1];
  },
});

/** Byte strings preserve arbitrary data, including invalid UTF-8. */
const Bytes = Text<number[]>({
  encode(bytes) {
    const text =
      '"' +
      bytes
        .map((byte) => {
          if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw Error("invalid string byte");
          return byte >= 0x20 && byte < 0x7f && byte !== 34 && byte !== 92
            ? String.fromCharCode(byte)
            : "\\" + byte.toString(16).padStart(2, "0");
        })
        .join("") +
      '"';
    return [{ kind: "string", text, bytes }];
  },
  decode(tokens, offset) {
    const token = tokens[offset];
    if (token?.kind !== "string") throw new TextSyntaxError("expected byte string", token?.offset);
    return [token.bytes!, offset + 1];
  },
});

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const Name = Text(
  C.iso(Bytes, {
    to: (name: string) => {
      if (!name.isWellFormed()) throw Error("name is not Unicode scalar text");
      return [...new TextEncoder().encode(name)];
    },
    from: (bytes) => utf8.decode(Uint8Array.from(bytes)),
  }),
);

/** Return the identifier without its dollar prefix; quoted identifiers allow Unicode names. */
const Identifier = Text<string>({
  encode(name) {
    if (name.length === 0) throw Error("empty identifier");
    const bare = /^[0-9A-Za-z!#$%&'*+\-./:<=>?@\\^_`|~]+$/.test(name);
    return [
      {
        kind: "identifier",
        text: "$" + (bare ? name : Name.toText(name)),
        bytes: bare ? undefined : [...new TextEncoder().encode(name)],
      },
    ];
  },
  decode(tokens, offset) {
    const token = tokens[offset];
    if (token?.kind !== "identifier")
      throw new TextSyntaxError("expected identifier", token?.offset);
    const name =
      token.bytes === undefined ? token.text.slice(1) : utf8.decode(Uint8Array.from(token.bytes));
    if (name.length === 0) throw new TextSyntaxError("empty identifier", token.offset);
    return [name, offset + 1];
  },
});

/** Integers are checked before conversion. Uninterpreted constants accept unsigned bit patterns. */
function integer(bits: number, signed: boolean): C.Codec<bigint, Token> {
  const max = 1n << BigInt(bits);
  return C.iso(Atom, {
    to(value: bigint) {
      if (value < (signed ? -max / 2n : 0n) || value >= (signed ? max / 2n : max)) {
        throw Error(`integer outside ${bits}-bit range`);
      }
      return value.toString();
    },
    from(text) {
      const pattern = signed
        ? /^[+-]?(?:[0-9](?:_?[0-9])*|0x[0-9a-fA-F](?:_?[0-9a-fA-F])*)$/
        : /^(?:[0-9](?:_?[0-9])*|0x[0-9a-fA-F](?:_?[0-9a-fA-F])*)$/;
      if (!pattern.test(text)) throw new TextSyntaxError("expected integer");
      const magnitude = BigInt(text.replaceAll("_", "").replace(/^[+-]/, ""));
      const negative = text.startsWith("-");
      const value = negative ? -magnitude : magnitude;
      // Explicit signs select sN; unsigned spelling selects uN.
      const signedSpelling = /^[+-]/.test(text);
      if (value < (signed ? -max / 2n : 0n) || value >= (signedSpelling ? max / 2n : max)) {
        throw new TextSyntaxError(`integer outside ${bits}-bit range`);
      }
      return signed ? BigInt.asIntN(bits, value) : value;
    },
  });
}

const U32 = Text(C.iso(integer(32, false), { to: (value: number) => BigInt(value), from: Number }));
const I32 = Text(C.iso(integer(32, true), { to: (value: number) => BigInt(value), from: Number }));
const I64 = Text(integer(64, true));

/** Syntax-only tree: numeric spellings (including NaN payloads) remain exact until grammar decoding. */
type Expression = Token | Expression[];
const SExpression: Text<Expression> = Text({
  encode(value) {
    return Array.isArray(value) ? list(C.sequence(SExpression)).encode(value) : [value];
  },
  decode(tokens, offset) {
    const token = tokens[offset];
    if (token?.kind === "(") return list(C.sequence(SExpression)).decode(tokens, offset);
    if (token === undefined || token.kind === ")") {
      throw new TextSyntaxError("expected expression", token?.offset);
    }
    return [token, offset + 1];
  },
});
const Script = Text(C.sequence(SExpression));
