import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import * as C from "../codec.ts";
import { tokenize } from "../text/lexer.ts";
import {
  Text,
  keyword,
  list,
  Name,
  Bytes,
  Identifier,
  U32,
  I32,
  I64,
  Script,
} from "../text/text.ts";

test("shared combinators express a parenthesized text grammar", () => {
  const param = C.iso(list(C.tuple([keyword("param"), Identifier, keyword("i32")])), {
    to: (name: string): [undefined, string, undefined] => [undefined, name, undefined],
    from: ([, name]) => name,
  });
  const signature = Text(
    list(
      C.record({
        kind: keyword("func"),
        name: C.orUndefined(Identifier),
        params: C.sequence(param),
      }),
    ),
  );
  const value = { kind: undefined, name: "add", params: ["x", "y"] };
  const source = "(func $add (param $x i32) (param $y i32))";
  assert.deepEqual(signature.fromText(source), value);
  assert.deepEqual(signature.fromText(signature.toText(value)), value);
  assert.deepEqual(signature.fromText("(func (param $x i32))"), {
    kind: undefined,
    name: undefined,
    params: ["x"],
  });
  assert.throws(() => signature.fromText("(func $add (param $x i32 i32))"));
  assert.throws(() => signature.fromText(source + " (func)"), /trailing token/);
  assert.throws(() => signature.fromText("(func $add (param $x))"));
});

test("nested comments and annotations separate tokens", () => {
  const source =
    '(module(; outer (; inner ;) ;; not a line comment ;) (@vendor (nested " ) ") (;x;)) ;; line\r\n(func))';
  assert.equal(Script.toText(Script.fromText(source)), "( module ( func ) )");
  assert.deepEqual(
    tokenize("0;; comment\n$x").map((t) => t.text),
    ["0", "$x"],
  );
  assert.throws(() => tokenize("(; unclosed"), /unterminated block comment/);
  assert.throws(() => tokenize('(@vendor "unclosed)'), /unterminated string/);
  assert.throws(() => tokenize("(@vendor (oops)"), /unterminated annotation/);
  assert.deepEqual(tokenize('(@vendor (@) (@ x) x-y$yz"aa"-2)'), []);
  assert.throws(() => tokenize('(@"")'), /missing annotation identifier/);
});

test("longest-match tokenization rejects adjacent tokens and illegal characters", () => {
  for (const source of [
    '"a""b"',
    "0$x",
    "123abc",
    "1__0",
    "0x_",
    "$",
    ",",
    "[]",
    "\v",
    "é",
    "\ud800",
    "(@)",
  ]) {
    assert.throws(() => tokenize(source), JSON.stringify(source));
  }
  assert.deepEqual(
    tokenize("(i32.const 0xff_ff)(f64.const -nan:0x12)").map((t) => t.text),
    ["(", "i32.const", "0xff_ff", ")", "(", "f64.const", "-nan:0x12", ")"],
  );
});

test("byte strings preserve bytes; names require UTF-8", () => {
  const bytes = Bytes.fromText(String.raw`"A\00\ff\t\n\r\"\'\\\u{1_f600}"`);
  assert.deepEqual(bytes, [65, 0, 255, 9, 10, 13, 34, 39, 92, 240, 159, 152, 128]);
  assert.deepEqual(Bytes.fromText(Bytes.toText(bytes)), bytes);
  const allBytes = Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(Bytes.fromText(Bytes.toText(allBytes)), allBytes);
  for (const name of ["", "héllo 😀", "\ufeffname", "\0"]) {
    assert.equal(Name.fromText(Name.toText(name)), name);
  }
  assert.throws(() => Name.fromText(String.raw`"\ff"`));
  for (const source of [
    String.raw`"\q"`,
    String.raw`"\0"`,
    String.raw`"\u{d800}"`,
    String.raw`"\u{110000}"`,
    '"\n"',
    '"\x7f"',
  ]) {
    assert.throws(() => Bytes.fromText(source));
  }
});

test("identifiers support bare and quoted names", () => {
  for (const name of ["x", "x[0]", "mémoire", "a b", "\ufeffx"]) {
    assert.equal(Identifier.fromText(Identifier.toText(name)), name);
    assert.equal(Identifier.decode(Identifier.encode(name), 0)[0], name);
  }
  assert.equal(Identifier.fromText('$"x"'), "x");
  assert.throws(() => Identifier.fromText('$""'), /empty identifier/);
  assert.throws(() => Identifier.fromText(String.raw`$"\ff"`));
});

test("integer grammar checks signs, bit patterns, separators, and ranges", () => {
  assert.equal(U32.fromText("0xff_ff"), 65535);
  assert.equal(I32.fromText("0xffffffff"), -1);
  assert.equal(I32.fromText("-0x8000_0000"), -2147483648);
  assert.equal(I64.fromText("18446744073709551615"), -1n);
  assert.equal(I64.fromText("-9223372036854775808"), -9223372036854775808n);
  for (const source of ["4294967296", "+2147483648", "-2147483649", "1.0", "1e2"]) {
    assert.throws(() => I32.fromText(source));
  }
  for (const source of ["-1", "+1", "4294967296"]) assert.throws(() => U32.fromText(source));
  assert.throws(() => I64.fromText("18446744073709551616"));
  for (const value of [-2147483648, -1, 0, 2147483647]) {
    assert.equal(I32.fromText(I32.toText(value)), value);
  }
});

test("syntax-only trees retain float spellings and report malformed nesting", () => {
  const source = '(assert_return (invoke "f") (f32.const -nan:0x40_0001))';
  const printed = Script.toText(Script.fromText(source));
  assert.match(printed, /-nan:0x40_0001/);
  assert.throws(() => Script.fromText("(module"), /unclosed parenthesis at 1:1/);
  assert.throws(() => Script.fromText("\n)"), /expected expression at 2:1/);
  assert.equal(Script.toText(Script.fromText(";; empty")), "");
});

test("example WAT roundtrips once WABT's nonstandard bracketed identifiers are quoted", async () => {
  const source = await readFile(new URL("../../examples/example.wat", import.meta.url), "utf8");
  // WABT prints debug names like $vectors[0], which are reserved tokens in the text grammar.
  assert.throws(() => Script.fromText(source), /reserved token "\$vectors\[0\]"/);
  const quoted = source.replace(/\$([^\s()"]+\[\d+\])/g, (_, name: string) =>
    Identifier.toText(name),
  );
  const printed = Script.toText(Script.fromText(quoted));
  const spellings = (text: string) => tokenize(text).map(({ kind, text }) => ({ kind, text }));
  assert.deepEqual(spellings(printed), spellings(quoted));
});
