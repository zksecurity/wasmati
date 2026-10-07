import assert from "node:assert/strict";
import { test } from "node:test";
import { readTree, tokenize, withLocation, type Node } from "../text/lexer.ts";
import { Cursor } from "../text/cursor.ts";
import { printString } from "../text/instructions.ts";

const leaf = (source: string) => readTree(source)[0] as Exclude<Node, { kind: "list" }>;
type Shape = string | Shape[];
const shape = (nodes: Node[]): Shape[] =>
  nodes.map((node) => (node.kind === "list" ? shape(node.items) : node.text));

test("nested comments and annotations separate tokens", () => {
  const source =
    '(module(; outer (; inner ;) ;; not a line comment ;) (@vendor (nested " ) ") (;x;)) ;; line\r\n(func))';
  assert.deepEqual(shape(readTree(source)), [["module", ["func"]]]);
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
  ])
    assert.throws(() => tokenize(source), JSON.stringify(source));
  assert.deepEqual(
    tokenize("(i32.const 0xff_ff)(f64.const -nan:0x12)").map((t) => t.text),
    ["(", "i32.const", "0xff_ff", ")", "(", "f64.const", "-nan:0x12", ")"],
  );
});

test("syntax trees report unbalanced parentheses with their source position", () => {
  const read = (source: string) => withLocation(source, () => readTree(source));
  assert.throws(() => read("(module"), /unclosed parenthesis at 1:1/);
  assert.throws(() => read("\n)"), /unexpected closing parenthesis at 2:1/);
  assert.deepEqual(read(";; empty"), []);
});

test("byte strings preserve bytes; names require UTF-8", () => {
  const bytes = leaf(String.raw`"A\00\ff\t\n\r\"\'\\\u{1_f600}"`).bytes!;
  assert.deepEqual(bytes, [65, 0, 255, 9, 10, 13, 34, 39, 92, 240, 159, 152, 128]);
  const allBytes = Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(leaf(printString(allBytes)).bytes, allBytes);
  for (const name of ["", "héllo 😀", "﻿name", "\0"])
    assert.equal(new Cursor(readTree(printString(new TextEncoder().encode(name)))).name(), name);
  assert.throws(() => new Cursor(readTree(String.raw`"\ff"`)).name(), /malformed UTF-8/);
  for (const source of [
    String.raw`"\q"`,
    String.raw`"\0"`,
    String.raw`"\u{d800}"`,
    String.raw`"\u{110000}"`,
    '"\n"',
    '"\x7f"',
  ])
    assert.throws(() => readTree(source), JSON.stringify(source));
});

test("identifiers support bare and quoted names", () => {
  const identifier = (source: string) => new Cursor(readTree(source)).identifier();
  assert.equal(identifier("$a.b-c"), "a.b-c");
  assert.equal(identifier('$"a b"'), "a b");
  assert.equal(identifier('$"mémoire"'), "mémoire");
  assert.equal(identifier(String.raw`$"\ef\bb\bfx"`), "\ufeffx");
  assert.throws(() => identifier('$""'), /empty identifier/);
  assert.throws(() => identifier(String.raw`$"\ff"`), /malformed UTF-8/);
  assert.throws(() => readTree("$x[0]"), /reserved token/);
});

test("cursors read lists by head keyword and report their position", () => {
  const source = "(func $f (param i32) (param i64) (result i32) nop)";
  const c = new Cursor(readTree(source)).list("func");
  assert.equal(c.identifier(), "f");
  assert.deepEqual(
    c.lists("param", (p) => p.atom()),
    ["i32", "i64"],
  );
  assert.equal(c.peekHead(), "result");
  assert.throws(() => c.keyword("nop"), /expected nop/);
  c.next();
  c.keyword("nop");
  c.end();
  assert.throws(
    () => withLocation(source, () => new Cursor(readTree(source)).list("module")),
    /expected \(module \.\.\.\) at 1:1/,
  );
});
