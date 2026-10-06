import { TextSyntaxError, type Leaf, type List, type Node } from "./lexer.ts";
import { parseU32 } from "./numbers.ts";

export { Cursor };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Recursive-descent reading of one list's items. Every read either consumes input or throws. */
class Cursor {
  private position = 0;
  readonly items: Node[];
  private readonly offset: number | undefined;

  constructor(items: Node[], offset?: number) {
    this.items = items;
    this.offset = offset;
  }

  static of(list: List): Cursor {
    return new Cursor(list.items, list.offset);
  }

  get done(): boolean {
    return this.position >= this.items.length;
  }

  peek(ahead = 0): Node | undefined {
    return this.items[this.position + ahead];
  }

  /** Text of the next atom, or undefined if the next item is not an atom. */
  peekAtom(ahead = 0): string | undefined {
    const node = this.peek(ahead);
    return node?.kind === "atom" ? node.text : undefined;
  }

  /** Keyword at the head of the next list, or undefined if the next item is not such a list. */
  peekHead(ahead = 0): string | undefined {
    const node = this.peek(ahead);
    return node?.kind === "list" && node.items[0]?.kind === "atom" ? node.items[0].text : undefined;
  }

  peekIdentifier(): boolean {
    return this.peek()?.kind === "identifier";
  }

  /** True if the next item is an index: a numeric literal or an identifier. */
  peekIndex(): boolean {
    return this.peekIdentifier() || /^[0-9]/.test(this.peekAtom() ?? "");
  }

  fail(message: string, node: Node | undefined = this.peek()): never {
    throw new TextSyntaxError(message, node?.offset ?? this.offset);
  }

  next(): Node {
    const node = this.peek();
    if (node === undefined) this.fail("unexpected end of list");
    this.position++;
    return node;
  }

  /** Apply a leaf conversion, attributing its errors to the leaf's position. */
  private leaf<T>(kind: Leaf["kind"], convert: (leaf: Leaf) => T): T {
    const node = this.peek();
    if (node?.kind !== kind) this.fail(`expected ${kind}`);
    try {
      const value = convert(node);
      this.position++;
      return value;
    } catch (error) {
      if (error instanceof TextSyntaxError) error.offset ??= node.offset;
      throw error;
    }
  }

  atom(): string {
    return this.leaf("atom", (leaf) => leaf.text);
  }

  /** Read an atom and convert it, e.g. with a number parser. */
  parse<T>(convert: (text: string) => T): T {
    return this.leaf("atom", (leaf) => convert(leaf.text));
  }

  keyword(word: string): void {
    if (this.peekAtom() !== word) this.fail(`expected ${word}`);
    this.position++;
  }

  maybeKeyword(word: string): boolean {
    if (this.peekAtom() !== word) return false;
    this.position++;
    return true;
  }

  u32(): number {
    return this.parse(parseU32);
  }

  /** Raw bytes of a string literal, which may be arbitrary data. */
  bytes(): number[] {
    return this.leaf("string", (leaf) => leaf.bytes!);
  }

  /** A string literal that must be valid UTF-8. */
  name(): string {
    return this.leaf("string", (leaf) => decodeName(leaf.bytes!));
  }

  /** An optional identifier, without its $ prefix. */
  identifier(): string | undefined {
    if (!this.peekIdentifier()) return undefined;
    return this.leaf("identifier", (leaf) => {
      const name = leaf.bytes === undefined ? leaf.text.slice(1) : decodeName(leaf.bytes);
      if (name.length === 0) throw new TextSyntaxError("empty identifier");
      return name;
    });
  }

  /** A numeric index or a symbolic identifier. */
  index(): number | string {
    return this.identifier() ?? this.u32();
  }

  maybeIndex(): number | string | undefined {
    return this.peekIndex() ? this.index() : undefined;
  }

  /** Enter the next list, consuming its head keyword if one is required. */
  list(head?: string): Cursor {
    const node = this.peek();
    if (node?.kind !== "list")
      this.fail(head === undefined ? "expected list" : `expected (${head} ...)`);
    const cursor = Cursor.of(node);
    if (head !== undefined) {
      if (cursor.peekAtom() !== head) this.fail(`expected (${head} ...)`);
      cursor.position++;
    }
    this.position++;
    return cursor;
  }

  maybeList(head: string): Cursor | undefined {
    return this.peekHead() === head ? this.list(head) : undefined;
  }

  /** Read every consecutive (head ...) list. */
  lists<T>(head: string, read: (cursor: Cursor) => T): T[] {
    const values: T[] = [];
    for (let list; (list = this.maybeList(head)); list.end()) values.push(read(list));
    return values;
  }

  /** Read items until the list is exhausted. */
  until<T>(read: (cursor: Cursor) => T): T[] {
    const values: T[] = [];
    while (!this.done) values.push(read(this));
    return values;
  }

  end(): void {
    if (!this.done) this.fail("unexpected item");
  }
}

function decodeName(bytes: number[]): string {
  try {
    return utf8.decode(Uint8Array.from(bytes));
  } catch {
    throw new TextSyntaxError("malformed UTF-8 encoding");
  }
}
