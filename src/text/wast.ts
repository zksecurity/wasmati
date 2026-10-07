import { Cursor } from "./cursor.ts";
import { readTree, UnsupportedTextError, type List, type Node } from "./lexer.ts";
import { parseFloat, parseInteger } from "./numbers.ts";

export { readScript, parseCommand };
export type { Command, Action, ModuleCommand, ModuleSource, Value, Expected, Numeric, Lane };

/**
 * WAST scripts are test input only, so they are parsed but never printed. Commands are parsed one at a
 * time, so an unsupported command fails on its own; malformed modules stay unparsed until they run.
 */
function readScript(source: string): List[] {
  const lists = readTree(source).map((node) => {
    if (node.kind !== "list")
      throw new UnsupportedTextError(`unexpected script token ${node.text}`);
    return node;
  });
  // A script of module fields is a single module.
  if (lists.length > 0 && lists.every((list) => fields.has(Cursor.of(list).peekAtom() ?? ""))) {
    const atom = { kind: "atom" as const, text: "module", offset: lists[0].offset };
    return [{ kind: "list", items: [atom, ...lists], offset: lists[0].offset }];
  }
  return lists;
}

const fields = new Set([
  "type",
  "import",
  "func",
  "table",
  "memory",
  "global",
  "export",
  "start",
  "elem",
  "data",
  "tag",
  "rec",
]);

/** A module's source: the text form stays a syntax tree; quoted text and binary keep their bytes. */
type ModuleSource =
  | { kind: "text"; list: List }
  | { kind: "quote"; bytes: Uint8Array }
  | { kind: "binary"; bytes: Uint8Array };
type ModuleCommand = {
  kind: "module";
  name: string | undefined;
  /** A definition is only compiled; it is instantiated by later module instance commands. */
  definition: boolean;
  source: ModuleSource;
};

/** Each lane of a number must match `value` on the bits in `mask`; exact constants use a full mask. */
type Lane = { width: number; value: bigint; mask: bigint };
type Numeric = { type: "i32" | "i64" | "f32" | "f64" | "v128"; lanes: Lane[] };
/** Reference values: extern references are host values numbered by the script. */
type Reference = { type: "ref"; ref: "null" | "func" | "extern"; host?: number };
type Value = Numeric | Reference;
type Expected = Value | { type: "either"; options: Expected[] };

type Action =
  | { kind: "invoke"; module: string | undefined; name: string; args: Value[] }
  | { kind: "get"; module: string | undefined; name: string };

type Command =
  | ModuleCommand
  | { kind: "instance"; name: string | undefined; definition: string | undefined }
  | { kind: "register"; name: string; module: string | undefined }
  | { kind: "action"; action: Action }
  | { kind: "assert_return"; action: Action; expected: Expected[] }
  | { kind: "assert_trap" | "assert_exhaustion"; action: Action; message: string }
  | { kind: "assert_exception"; action: Action }
  | {
      kind: "assert_trap_module" | "assert_invalid" | "assert_malformed" | "assert_unlinkable";
      module: ModuleCommand;
      message: string;
    };

function parseCommand(list: List): Command {
  const c = Cursor.of(list);
  const head = c.peekAtom();
  switch (head) {
    case "module": {
      if (c.peekAtom(1) === "instance") {
        c.keyword("module");
        c.keyword("instance");
        const name = c.identifier();
        const definition = c.identifier();
        c.end();
        return { kind: "instance", name, definition };
      }
      return moduleCommand(list);
    }
    case "register": {
      c.keyword(head);
      const name = c.name();
      const module = c.identifier();
      c.end();
      return { kind: "register", name, module };
    }
    case "invoke":
    case "get":
      return { kind: "action", action: action(list) };
    case "assert_return": {
      c.keyword(head);
      const performed = action(c.next());
      const expected = c.until((c) => result(c.next()));
      return { kind: head, action: performed, expected };
    }
    case "assert_trap":
    case "assert_exhaustion":
    case "assert_exception": {
      c.keyword(head);
      if (head === "assert_trap" && c.peekHead() === "module") {
        const module = moduleCommand(c.next());
        const message = c.name();
        c.end();
        return { kind: "assert_trap_module", module, message };
      }
      const performed = action(c.next());
      if (head === "assert_exception") {
        c.end();
        return { kind: head, action: performed };
      }
      const message = c.name();
      c.end();
      return { kind: head, action: performed, message };
    }
    case "assert_invalid":
    case "assert_malformed":
    case "assert_unlinkable": {
      c.keyword(head);
      const module = moduleCommand(c.next());
      const message = c.name();
      c.end();
      return { kind: head, module, message };
    }
    default:
      throw new UnsupportedTextError(`WAST command ${head ?? "<list>"} is not implemented`);
  }
}

function moduleCommand(node: Node): ModuleCommand {
  if (node.kind !== "list") return new Cursor([node]).fail("expected module");
  const c = Cursor.of(node);
  c.keyword("module");
  const definition = c.maybeKeyword("definition");
  const name = c.identifier();
  const encoding = c.peekAtom();
  if (encoding === "binary" || encoding === "quote") {
    c.keyword(encoding);
    const bytes = Uint8Array.from(c.until((c) => c.bytes()).flat());
    return { kind: "module", name, definition, source: { kind: encoding, bytes } };
  }
  // The module parser sees (module $id? field*), without the script-only definition keyword.
  const items = node.items.filter((_, i) => !(definition && i === 1));
  return { kind: "module", name, definition, source: { kind: "text", list: { ...node, items } } };
}

function action(node: Node): Action {
  const c = node.kind === "list" ? Cursor.of(node) : new Cursor([node]);
  const kind = c.peekAtom();
  if (kind !== "invoke" && kind !== "get")
    throw new UnsupportedTextError(
      `WAST action ${c.peekAtom() ?? c.peekHead()} is not implemented`,
    );
  c.keyword(kind);
  const module = c.identifier();
  const name = c.name();
  if (kind === "get") {
    c.end();
    return { kind, module, name };
  }
  const args = c.until((c) => argument(c.next()));
  return { kind, module, name, args };
}

function argument(node: Node): Value {
  const value = result(node);
  const exact = (value: Expected) =>
    value.type === "ref"
      ? value.ref !== "func" && (value.ref !== "extern" || value.host !== undefined)
      : value.type !== "either" && value.lanes.every((lane) => lane.mask === full(lane.width));
  if (value.type === "either" || !exact(value))
    return new Cursor([node]).fail("expected a constant argument");
  return value;
}

const shapes: Record<string, { lane: "i" | "f"; width: number; count: number }> = {
  i8x16: { lane: "i", width: 8, count: 16 },
  i16x8: { lane: "i", width: 16, count: 8 },
  i32x4: { lane: "i", width: 32, count: 4 },
  i64x2: { lane: "i", width: 64, count: 2 },
  f32x4: { lane: "f", width: 32, count: 4 },
  f64x2: { lane: "f", width: 64, count: 2 },
};

/** A constant, or a result pattern: NaN classes, any reference of a kind, or alternatives. */
function result(node: Node): Expected {
  const c = node.kind === "list" ? Cursor.of(node) : new Cursor([node]);
  const head = c.atom();
  let value: Expected;
  switch (head) {
    case "i32.const":
    case "i64.const":
    case "f32.const":
    case "f64.const": {
      const width = head.startsWith("i32") || head.startsWith("f32") ? 32 : 64;
      const lane = head[0] === "i" ? integerLane(c, width) : floatLane(c, width as 32 | 64);
      value = { type: head.slice(0, 3) as Numeric["type"], lanes: [lane] };
      break;
    }
    case "v128.const": {
      const shape = shapes[c.atom()];
      if (shape === undefined) c.fail("unknown vector shape");
      const lanes = Array.from({ length: shape.count }, () =>
        shape.lane === "i" ? integerLane(c, shape.width) : floatLane(c, shape.width as 32 | 64),
      );
      value = { type: "v128", lanes };
      break;
    }
    case "ref.null":
      // The heap type is irrelevant for comparison: every null reference is the same JS null.
      if (!c.done) c.atom();
      value = { type: "ref", ref: "null" };
      break;
    case "ref.extern":
    case "ref.host":
      value = { type: "ref", ref: "extern", host: c.done ? undefined : c.u32() };
      break;
    case "ref.func":
      value = { type: "ref", ref: "func" };
      break;
    case "either":
      value = { type: "either", options: c.until((c) => result(c.next())) };
      break;
    default:
      throw new UnsupportedTextError(`WAST value ${head} is not implemented`);
  }
  c.end();
  return value;
}

function full(width: number): bigint {
  return (1n << BigInt(width)) - 1n;
}

function integerLane(c: Cursor, width: number): Lane {
  const value = BigInt.asUintN(
    width,
    c.parse((text) => parseInteger(text, width)),
  );
  return { width, value, mask: full(width) };
}

const floatView = new DataView(new ArrayBuffer(8));

/** A float lane, or a NaN class: canonical NaNs have only the quiet bit set, arithmetic NaNs at least it. */
function floatLane(c: Cursor, width: 32 | 64): Lane {
  const precision = width === 32 ? 23 : 52;
  const nan = full(width - 1 - precision) << BigInt(precision);
  const quiet = 1n << BigInt(precision - 1);
  const pattern = c.peekAtom();
  if (pattern === "nan:canonical" || pattern === "nan:arithmetic") {
    c.atom();
    const mask = pattern === "nan:canonical" ? full(width - 1) : nan | quiet;
    return { width, value: nan | quiet, mask };
  }
  const value = c.parse((text) => parseFloat(text, width));
  let bits: bigint;
  if (typeof value === "number") {
    if (width === 32) floatView.setFloat32(0, value);
    else floatView.setFloat64(0, value);
    bits = width === 32 ? BigInt(floatView.getUint32(0)) : floatView.getBigUint64(0);
  } else bits = BigInt(value.bits);
  return { width, value: bits, mask: full(width) };
}
