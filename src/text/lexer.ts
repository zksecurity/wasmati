export { tokenize, printTokens, TextSyntaxError };
export type { Token };

/** Source offsets use JavaScript string indices. Generated tokens have no source offset. */
type Token = {
  kind: "atom" | "string" | "identifier" | "(" | ")";
  text: string;
  bytes?: number[];
  offset?: number;
};

class TextSyntaxError extends SyntaxError {
  offset: number | undefined;

  constructor(message: string, offset?: number) {
    super(message);
    this.offset = offset;
  }
}

const idchar = /^[0-9A-Za-z!#$%&'*+\-./:<=>?@\\^_`|~]$/;
const digits = "[0-9](?:_?[0-9])*";
const hexDigits = "[0-9a-fA-F](?:_?[0-9a-fA-F])*";
const numeric = new RegExp(
  `^[+-]?(?:${digits}(?:\\.(?:${digits})?)?(?:[eE][+-]?${digits})?` +
    `|0x${hexDigits}(?:\\.(?:${hexDigits})?)?(?:[pP][+-]?${digits})?` +
    `|inf|nan(?::0x${hexDigits})?)$`,
);
const encoder = new TextEncoder();

/** Tokenize WAT/WAST, discarding whitespace, nested comments, and unrecognized annotations. */
function tokenize(source: string): Token[] {
  // JavaScript strings can contain unpaired surrogates, unlike the spec's source character set.
  if (!source.isWellFormed()) throw new TextSyntaxError("source is not Unicode scalar text");
  let offset = 0;
  const fail = (message: string, start = offset): never => {
    throw new TextSyntaxError(message, start);
  };

  function string(): number[] {
    const start = offset++;
    const bytes: number[] = [];
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') return bytes;
      if (char === "\\") {
        const escape = source[offset++];
        const simple: Record<string, number> = { t: 9, n: 10, r: 13, '"': 34, "'": 39, "\\": 92 };
        if (Object.hasOwn(simple, escape)) {
          bytes.push(simple[escape]);
        } else if (/^[0-9a-fA-F]$/.test(escape ?? "")) {
          const second = source[offset++];
          if (!/^[0-9a-fA-F]$/.test(second ?? "")) fail("invalid byte escape", offset - 2);
          bytes.push(parseInt(escape + second, 16));
        } else if (escape === "u" && source[offset] === "{") {
          const match = source.slice(++offset).match(new RegExp(`^(${hexDigits})\\}`));
          if (match === null) return fail("invalid Unicode escape");
          const codepoint = Number(BigInt("0x" + match[1].replaceAll("_", "")));
          if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
            fail("invalid Unicode scalar value");
          }
          bytes.push(...encoder.encode(String.fromCodePoint(codepoint)));
          offset += match[0].length;
        } else {
          fail("invalid string escape", offset - 2);
        }
      } else {
        const codepoint = source.codePointAt(offset - 1)!;
        if (codepoint < 0x20 || codepoint === 0x7f) fail("control character in string", offset - 1);
        const scalar = String.fromCodePoint(codepoint);
        bytes.push(...encoder.encode(scalar));
        offset += scalar.length - 1;
      }
    }
    return fail("unterminated string", start);
  }

  function comment(): boolean {
    if (source.startsWith(";;", offset)) {
      offset += 2;
      while (offset < source.length && !/[\r\n]/.test(source[offset])) offset++;
      return true;
    }
    if (!source.startsWith("(;", offset)) return false;
    const start = offset;
    offset += 2;
    let depth = 1;
    while (offset < source.length) {
      if (source.startsWith("(;", offset)) {
        depth++;
        offset += 2;
      } else if (source.startsWith(";)", offset)) {
        offset += 2;
        if (--depth === 0) return true;
      } else offset++;
    }
    return fail("unterminated block comment", start);
  }

  function annotation() {
    const start = offset;
    offset += 2;
    if (source[offset] === '"') {
      const bytes = string();
      if (bytes.length === 0) fail("missing annotation identifier", start);
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
      } catch {
        fail("annotation name is not UTF-8", start);
      }
    } else {
      const idStart = offset;
      while (idchar.test(source[offset] ?? "")) offset++;
      if (offset === idStart) fail("missing annotation identifier", start);
    }
    let depth = 1;
    while (offset < source.length) {
      if (comment()) continue;
      const char = source[offset];
      if (char === '"') string();
      else if (char === "(") {
        depth++;
        offset++;
      } else if (char === ")") {
        offset++;
        if (--depth === 0) return;
      } else if (/[ \t\r\n]/.test(char) || idchar.test(char) || /[,;\[\]{}]/.test(char)) {
        offset++;
      } else fail("invalid character in annotation");
    }
    fail("unterminated annotation", start);
  }

  const tokens: Token[] = [];
  while (offset < source.length) {
    if (/[ \t\r\n]/.test(source[offset])) {
      offset++;
      continue;
    }
    if (comment()) continue;
    if (source.startsWith("(@", offset)) {
      annotation();
      continue;
    }
    const start = offset;
    const char = source[offset];
    if (char === "(" || char === ")") {
      tokens.push({ kind: char, text: char, offset: offset++ });
      continue;
    }
    let strings = 0;
    let bytes: number[] | undefined;
    // The longest match includes adjacent strings and reserved punctuation: do not split 0$x.
    while (offset < source.length) {
      if (source.startsWith(";;", offset)) break;
      if (source[offset] === '"') {
        bytes = string();
        strings++;
      } else if (idchar.test(source[offset]) || /[,;\[\]{}]/.test(source[offset])) offset++;
      else break;
    }
    if (offset === start) fail("invalid source character");
    const text = source.slice(start, offset);
    let kind: Token["kind"];
    if (strings === 1 && text.startsWith('"') && text.endsWith('"')) kind = "string";
    else if (/^\$(?:[0-9A-Za-z!#$%&'*+\-./:<=>?@\\^_`|~]+)$/.test(text)) kind = "identifier";
    else if (strings === 1 && text.startsWith('$"') && text.endsWith('"')) kind = "identifier";
    else if (
      strings === 0 &&
      (/^[a-z][0-9A-Za-z!#$%&'*+\-./:<=>?@\\^_`|~]*$/.test(text) || numeric.test(text))
    )
      kind = "atom";
    else return fail(`reserved token ${JSON.stringify(text)}`, start);
    tokens.push({ kind, text, bytes, offset: start });
  }
  return tokens;
}

/** Canonical spacing keeps every token separate; comments and source formatting are not retained. */
function printTokens(tokens: Token[]): string {
  return tokens.map((token) => token.text).join(" ");
}
