import * as C from "../codec.ts";
import { TextSyntaxError, UnsupportedTextError, type Token } from "./lexer.ts";
import { Atom, Identifier, U32, type Expression } from "./text.ts";

export { token, form, word, head, optional, repeated, Index, ValueType, position, record, isIndex };
export type { Index as IndexValue };
import { valueTypeSet, type ValueType as ValueTypeValue } from "../types.ts";

/** Adapt a single-token codec to the syntax tree; lists stay bounded without rescanning parentheses. */
function token<T>(codec: C.Codec<T, Token>): C.Codec<T, Expression> {
  return {
    encode: codec.encode,
    decode(input, offset) {
      const node = input[offset];
      if (node === undefined || Array.isArray(node)) {
        throw new TextSyntaxError("expected token", position(node));
      }
      const [value, end] = codec.decode([node], 0);
      if (end !== 1) throw new TextSyntaxError("expected exactly one token", node.offset);
      return [value, offset + 1];
    },
  };
}

function position(node: Expression | undefined): number | undefined {
  return Array.isArray(node) ? position(node[0]) : node?.offset;
}

/** Read the head keyword of a parenthesized form, for explicit alternative selection. */
function head(node: Expression | undefined): string | undefined {
  return Array.isArray(node) && !Array.isArray(node[0]) ? node[0]?.text : undefined;
}

function word(node: Expression | undefined): string | undefined {
  return node !== undefined && !Array.isArray(node) && node.kind === "atom" ? node.text : undefined;
}

/** A keyword-headed parenthesized form, with every inner field composed by its supplied codec. */
function form<T>(name: string, contents: C.Codec<T, Expression>): C.Codec<T, Expression> {
  return {
    encode: (value) => [[{ kind: "atom", text: name }, ...contents.encode(value)]],
    decode(input, offset) {
      const node = input[offset];
      if (!Array.isArray(node) || head(node) !== name) {
        if (
          name === "func" &&
          ["struct", "array", "sub", "rec", "global", "memory", "table", "tag"].includes(
            head(node) ?? "",
          )
        ) {
          throw new UnsupportedTextError(`text grammar for ${head(node)} is not implemented here`);
        }
        throw new TextSyntaxError(`expected (${name} ...)`, position(node));
      }
      const [value, end] = contents.decode(node, 1);
      if (end !== node.length)
        throw new TextSyntaxError(`unexpected field in ${name}`, position(node[end]));
      return [value, offset + 1];
    },
  };
}

/** Optional syntax with explicit lookahead: malformed present fields must not be treated as absent. */
function optional<T>(
  codec: C.Codec<T, Expression>,
  matches: (node: Expression | undefined) => boolean,
): C.Codec<T | undefined, Expression> {
  return {
    encode: (value) => (value === undefined ? [] : codec.encode(value)),
    decode: (input, offset) =>
      matches(input[offset]) ? codec.decode(input, offset) : [undefined, offset],
  };
}

function repeated<T>(codec: C.Codec<T, Expression>, name: string): C.Codec<T[], Expression> {
  return C.repeatWhile(codec, (input, offset) => head(input[offset]) === name);
}

type Index = number | string;
function isIndex(node: Expression | undefined): boolean {
  return (
    !Array.isArray(node) &&
    node !== undefined &&
    (node.kind === "identifier" || /^[0-9]/.test(node.text))
  );
}
const Index = C.or<[number, string], Expression>([token(U32), token(Identifier)], (value) =>
  typeof value === "number" ? 0 : 1,
);
const extendedTypes = new Set([
  "anyref",
  "eqref",
  "i31ref",
  "structref",
  "arrayref",
  "nullref",
  "nullfuncref",
  "nullexternref",
  "exnref",
  "nullexnref",
]);
const ValueType: C.Codec<ValueTypeValue, Expression> = {
  encode: token(Atom).encode,
  decode(input, offset) {
    if (head(input[offset]) === "ref")
      throw new UnsupportedTextError("typed reference syntax is not implemented");
    const [type, end] = token(Atom).decode(input, offset);
    if (extendedTypes.has(type))
      throw new UnsupportedTextError(`value type ${type} is not implemented`);
    if (!valueTypeSet.has(type as ValueTypeValue))
      throw new TextSyntaxError(`unknown value type ${type}`, position(input[offset]));
    return [type as ValueTypeValue, end];
  },
};

/** Specialize the shared record combinator to syntax nodes, retaining field type inference. */
function record<Fields extends Record<string, any>>(fields: {
  [K in keyof Fields]-?: C.Codec<Fields[K], Expression>;
}): C.Codec<Fields, Expression> {
  return C.record<Fields, Expression>(fields);
}
