import type { Module } from "../module-binable.ts";
import type { Import, Export } from "../export.ts";
import type { Elem, Data } from "../memory-binable.ts";
import type { ResolvedInstruction } from "../instruction/base.ts";
import type { NameMap, NameSection } from "../name-section.ts";
import type {
  AddressType,
  FunctionType,
  GlobalType,
  IndexSpace,
  MemoryType,
  RefType,
  TableType,
  ValueType,
} from "../types.ts";
import { Cursor } from "./cursor.ts";
import { readTree, withLocation, UnsupportedTextError, type List } from "./lexer.ts";
import { parseInstructions, parseValueType, type BlockType, type Scope } from "./instructions.ts";
import { parseU64 } from "./numbers.ts";
import { limits } from "../memory.ts";

export { parseWat, parseModule };

/** Parse a WAT module; the enclosing (module ...) may be omitted. */
function parseWat(source: string): Module {
  return withLocation(source, () => {
    const nodes = readTree(source);
    const [first] = nodes;
    if (nodes.length === 1 && first.kind === "list" && Cursor.of(first).peekAtom() === "module")
      return parseModule(first);
    return new ModuleParser().parse(new Cursor(nodes), undefined);
  });
}

/** Parse a `(module $id? field*)` list. */
function parseModule(list: List): Module {
  const c = Cursor.of(list);
  c.keyword("module");
  const name = c.identifier();
  return new ModuleParser().parse(c, name);
}

type ModuleSpace = Exclude<IndexSpace, "local" | "label">;
type Path = { module: string; name: string };
type EntityKind = "func" | "table" | "memory" | "global";
const spaceOf = { func: "function", table: "table", memory: "memory", global: "global" } as const;

/**
 * Parsing takes two passes over the fields, both in textual order. The first assigns every index and
 * identifier, including those of abbreviated imports, exports and segments; the second reads the rest,
 * resolving identifiers as it goes. Abbreviations expand into their plain fields while parsing.
 */
class ModuleParser {
  private module: Module = {
    types: [],
    funcs: [],
    tables: [],
    globals: [],
    elems: [],
    datas: [],
    imports: [],
    exports: [],
  };
  private counts: Record<ModuleSpace, number> = {
    type: 0,
    function: 0,
    table: 0,
    memory: 0,
    global: 0,
    elem: 0,
    data: 0,
  };
  private ids = Object.fromEntries(
    Object.keys(this.counts).map((space) => [space, new Map<string, number>()]),
  ) as Record<ModuleSpace, Map<string, number>>;
  private locals: Record<number, NameMap> = {};
  private defined = false;

  parse(c: Cursor, name: string | undefined): Module {
    const definitions = c.until((c) => this.field(c.list()));
    for (const define of definitions) define();
    return { ...this.module, ...this.names(name) };
  }

  // First pass: assign indices and identifiers, and return the second pass for the field.

  private field(c: Cursor): () => void {
    const kind = c.atom();
    switch (kind) {
      case "type":
        return this.type(c);
      case "import": {
        const path = { module: c.name(), name: c.name() };
        const description = c.list();
        c.end();
        const kind = description.atom();
        if (kind === "tag") throw new UnsupportedTextError("tags are not supported");
        if (!(kind in spaceOf)) description.fail(`unknown import kind ${kind}`);
        return this.entity(kind as EntityKind, description, path);
      }
      case "func":
      case "table":
      case "memory":
      case "global":
        return this.entity(kind, c);
      case "export":
        return () => this.exportField(c);
      case "start":
        return () => {
          if (this.module.start !== undefined) c.fail("multiple start sections");
          this.module.start = this.index(c, "function");
          c.end();
        };
      case "elem": {
        const index = this.allocate(c, "elem");
        return () => this.elem(c, index);
      }
      case "data": {
        const index = this.allocate(c, "data");
        return () => this.data(c, index);
      }
      case "tag":
      case "rec":
        throw new UnsupportedTextError(`${kind} fields are not supported`);
      default:
        return c.fail(`unknown module field ${kind}`);
    }
  }

  /** Take the next index of a space, binding the cursor's identifier, if any, to it. */
  private allocate(c: Cursor | undefined, space: ModuleSpace): number {
    const node = c?.peek();
    const id = c?.identifier();
    const index = this.counts[space]++;
    if (id === undefined) return index;
    if (this.ids[space].has(id)) c!.fail(`duplicate ${space} $${id}`, node);
    this.ids[space].set(id, index);
    return index;
  }

  private type(c: Cursor) {
    const index = this.allocate(c, "type");
    const head = c.peekHead();
    if (head === "sub" || head === "struct" || head === "array" || head === "rec")
      throw new UnsupportedTextError(`${head} types are not supported`);
    const func = c.list("func");
    this.module.types[index] = this.signature(func, true).type;
    func.end();
    c.end();
    return () => {};
  }

  /** A function, table, memory or global, imported or defined, with inline exports. */
  private entity(kind: EntityKind, c: Cursor, path?: Path) {
    const space = spaceOf[kind];
    const index = this.allocate(c, space);
    if (space === "memory" && index > 0)
      throw new UnsupportedTextError("multiple memories are not supported");
    const exports = path === undefined ? c.lists("export", (e) => e.name()) : [];
    const inline = path === undefined ? c.maybeList("import") : undefined;
    if (inline !== undefined) {
      path = { module: inline.name(), name: inline.name() };
      inline.end();
    }
    if (path !== undefined && this.defined) c.fail(`import after definition`);
    if (path === undefined) this.defined = true;
    // Inline segments take the next segment index: a table without limits has inline elements.
    let segment: number | undefined;
    const ahead = c.peekAtom() === "i32" || c.peekAtom() === "i64" ? 1 : 0;
    if (path === undefined && kind === "table" && !c.peekIndex(ahead))
      segment = this.allocate(undefined, "elem");
    if (path === undefined && kind === "memory" && c.peekHead(ahead) === "data")
      segment = this.allocate(undefined, "data");

    return () => {
      for (const name of exports)
        this.module.exports.push({ name, description: { kind: space, value: index } });
      if (path !== undefined) {
        this.module.imports.push({ ...path, description: this.importDescription(kind, c, index) });
      } else if (kind === "func") this.func(c, index);
      else if (kind === "table") this.table(c, index, segment);
      else if (kind === "memory") this.memory(c, index, segment);
      else this.global(c);
      c.end();
    };
  }

  // Second pass: everything else.

  private importDescription(kind: EntityKind, c: Cursor, index: number): Import["description"] {
    switch (kind) {
      case "func": {
        const { index: type, names } = this.typeUse(c, true);
        this.localNames(index, names);
        return { kind: "function", value: type };
      }
      case "table":
        return { kind: "table", value: this.tableType(c) };
      case "memory":
        return { kind: "memory", value: this.memoryType(c) };
      case "global":
        return { kind: "global", value: this.globalType(c) };
    }
  }

  private func(c: Cursor, funcIdx: number) {
    const { index: typeIdx, type, names } = this.typeUse(c, true);
    const locals: ValueType[] = [];
    for (const local of c.lists("local", (l) => this.group(l))) {
      local.names.forEach((name, i) => (names[type.args.length + locals.length + i] = name));
      locals.push(...local.types);
    }
    const ids = new Map<string, number>();
    names.forEach((name, i) => {
      if (name === undefined) return;
      if (ids.has(name)) c.fail(`duplicate local $${name}`);
      ids.set(name, i);
    });
    this.localNames(funcIdx, names);
    const scope = this.scope(ids);
    const body = parseInstructions(c, scope);
    this.module.funcs.push({ funcIdx, typeIdx, type, locals, body });
  }

  private table(c: Cursor, index: number, segment: number | undefined) {
    if (segment === undefined) {
      this.module.tables.push(this.tableType(c));
      return;
    }
    const address = this.address(c);
    const type = this.refType(c);
    const items = c.list("elem");
    const init = items.done || items.peekIndex() ? this.functions(items) : this.expressions(items);
    items.end();
    const size = init.length;
    this.module.tables.push({ type, limits: limits(size, size, false, address) });
    this.module.elems[segment] = { type, init, mode: { table: index, offset: zero(address) } };
  }

  private memory(c: Cursor, index: number, segment: number | undefined) {
    if (segment === undefined) {
      this.module.memory = this.memoryType(c);
      return;
    }
    const address = this.address(c);
    const data = c.list("data");
    const init = data.until((d) => d.bytes()).flat();
    data.end();
    const pages = Math.ceil(init.length / 65536);
    this.module.memory = { limits: limits(pages, pages, false, address) };
    this.module.datas[segment] = { init, mode: { memory: index, offset: zero(address) } };
  }

  private global(c: Cursor) {
    const type = this.globalType(c);
    this.module.globals.push({ type, init: parseInstructions(c, this.scope()) });
  }

  private exportField(c: Cursor) {
    const name = c.name();
    const description = c.list();
    const kind = description.atom();
    if (kind === "tag") throw new UnsupportedTextError("tags are not supported");
    if (!(kind in spaceOf)) description.fail(`unknown export kind ${kind}`);
    const space = spaceOf[kind as EntityKind];
    const value = this.index(description, space);
    description.end();
    c.end();
    this.module.exports.push({ name, description: { kind: space, value } } satisfies Export);
  }

  /**
   * `(elem declare? elemlist)`, or active: `(elem (table x)? (offset expr) elemlist)`, where the offset
   * may be a single folded instruction and a list of function indices needs no `func` keyword.
   */
  private elem(c: Cursor, index: number) {
    let mode: Elem["mode"] = "passive";
    if (c.maybeKeyword("declare")) mode = "declarative";
    else if (c.peek()?.kind === "list") {
      const table = c.maybeList("table");
      const tableIndex = table === undefined ? 0 : this.index(table, "table");
      table?.end();
      mode = { table: tableIndex, offset: this.offset(c) };
    }
    let type: RefType = "funcref";
    let init: ResolvedInstruction[][];
    if (c.maybeKeyword("func") || (typeof mode === "object" && (c.done || c.peekIndex())))
      init = this.functions(c);
    else {
      type = this.refType(c);
      init = this.expressions(c);
    }
    this.module.elems[index] = { type, init, mode };
  }

  private functions(c: Cursor): ResolvedInstruction[][] {
    return c.until((c) => [{ name: "ref.func", immediate: this.index(c, "function") }]);
  }

  /** Element expressions: `(item instr*)`, or a single folded instruction. */
  private expressions(c: Cursor): ResolvedInstruction[][] {
    return c.until((c) => {
      if (c.peekHead() !== "item") return parseInstructions(new Cursor([c.next()]), this.scope());
      const item = c.list("item");
      const expression = parseInstructions(item, this.scope());
      item.end();
      return expression;
    });
  }

  /** `(data datastring)`, or active: `(data (memory x)? (offset expr) datastring)`. */
  private data(c: Cursor, index: number) {
    let mode: Data["mode"] = "passive";
    if (c.peek()?.kind === "list") {
      const memory = c.maybeList("memory");
      const memoryIndex = memory === undefined ? 0 : this.index(memory, "memory");
      memory?.end();
      mode = { memory: memoryIndex, offset: this.offset(c) };
    }
    const init = c.until((c) => c.bytes()).flat();
    this.module.datas[index] = { init, mode };
  }

  private offset(c: Cursor): ResolvedInstruction[] {
    const offset = c.maybeList("offset");
    if (offset === undefined) return parseInstructions(new Cursor([c.next()]), this.scope());
    const expression = parseInstructions(offset, this.scope());
    offset.end();
    return expression;
  }

  // Types

  private refType(c: Cursor): RefType {
    const node = c.peek();
    const type = parseValueType(c);
    if (type !== "funcref" && type !== "externref") c.fail("expected reference type", node);
    return type;
  }

  /** An optional address type; 32-bit by default. */
  private address(c: Cursor): AddressType {
    if (c.maybeKeyword("i64")) return "i64";
    c.maybeKeyword("i32");
    return "i32";
  }

  private sizes(c: Cursor) {
    const min = c.parse(parseU64);
    const max = c.peekIndex() ? c.parse(parseU64) : undefined;
    return { min, max };
  }

  private tableType(c: Cursor): TableType {
    const address = this.address(c);
    const { min, max } = this.sizes(c);
    const type = this.refType(c);
    if (!c.done) throw new UnsupportedTextError("table initializers are not supported");
    return { type, limits: limits(min, max, false, address) };
  }

  private memoryType(c: Cursor): MemoryType {
    const address = this.address(c);
    const { min, max } = this.sizes(c);
    const shared = c.maybeKeyword("shared");
    if (c.peekHead() === "pagesize")
      throw new UnsupportedTextError("custom page sizes are not supported");
    return { limits: limits(min, max, shared, address) };
  }

  private globalType(c: Cursor): GlobalType {
    const mutable = c.maybeList("mut");
    if (mutable === undefined) return { value: parseValueType(c), mutable: false };
    const value = parseValueType(mutable);
    mutable.end();
    return { value, mutable: true };
  }

  /** `(param $id? t)` or `(param t*)`, and likewise for locals. */
  private group(c: Cursor) {
    const name = c.identifier();
    const types = c.until(parseValueType);
    if (name !== undefined && types.length !== 1) c.fail("a named parameter or local has one type");
    return { names: types.map(() => name), types };
  }

  private signature(c: Cursor, named: boolean) {
    const params = c.lists("param", (p) => this.group(p));
    if (!named && params.some((p) => p.names.some((name) => name !== undefined)))
      c.fail("unexpected parameter identifier");
    const results = c.lists("result", (r) => r.until(parseValueType)).flat();
    const type = { args: params.flatMap((p) => p.types), results };
    return {
      type,
      names: params.flatMap((p) => p.names),
      inline: params.length + results.length > 0,
    };
  }

  /**
   * `(type x)? (param ...)* (result ...)*`. Without a type index, the first identical type is used, or
   * a new type is appended. Inline declarations must match a referenced type.
   */
  private typeUse(c: Cursor, named: boolean) {
    const reference = c.maybeList("type");
    const explicit = reference && this.index(reference, "type");
    reference?.end();
    const { type, names, inline } = this.signature(c, named);
    if (explicit === undefined) return { index: this.findType(type), type, names };
    // A bare reference to a missing type is invalid rather than malformed.
    const referenced = this.module.types[explicit];
    if (referenced === undefined && !inline) return { index: explicit, type, names };
    if (referenced === undefined) c.fail(`unknown type ${explicit}`);
    if (inline && !equal(referenced, type))
      c.fail("inline function type does not match the referenced type");
    return { index: explicit, type: referenced, names };
  }

  private findType(type: FunctionType): number {
    const index = this.module.types.findIndex((other) => equal(other, type));
    if (index !== -1) return index;
    this.counts.type++;
    return this.module.types.push(type) - 1;
  }

  private blockType(c: Cursor): BlockType {
    if (c.peekHead() !== "type" && c.peekHead() !== "param") {
      const results = c.lists("result", (r) => r.until(parseValueType)).flat();
      if (results.length <= 1) return results[0] ?? "empty";
      return this.findType({ args: [], results });
    }
    return this.typeUse(c, false).index;
  }

  // Names

  /** Read an index of a space: a number, or an identifier bound in that space. */
  private index(c: Cursor, space: IndexSpace, ids = this.ids[space as ModuleSpace]): number {
    const node = c.peek();
    const index = c.index();
    if (typeof index === "number") return index;
    const value = ids.get(index);
    if (value === undefined) c.fail(`unknown ${space} $${index}`, node);
    return value;
  }

  /** Name resolution for instructions; locals exist only in function bodies. */
  private scope(locals = new Map<string, number>()): Scope {
    return {
      index: (c, space) => this.index(c, space, space === "local" ? locals : undefined),
      typeUse: (c) => this.typeUse(c, false).index,
      blockType: (c) => this.blockType(c),
      labels: [],
    };
  }

  private localNames(func: number, names: (string | undefined)[]) {
    const map = Object.fromEntries(
      names.flatMap((name, i) => (name === undefined ? [] : [[i, name]])),
    );
    if (Object.keys(map).length > 0) this.locals[func] = map;
  }

  private names(module: string | undefined): { names?: NameSection } {
    const map = (space: ModuleSpace) =>
      this.ids[space].size === 0
        ? undefined
        : Object.fromEntries([...this.ids[space]].map(([name, index]) => [index, name]));
    const names: NameSection = {
      module,
      functions: map("function"),
      locals: Object.keys(this.locals).length > 0 ? this.locals : undefined,
      types: map("type"),
      tables: map("table"),
      memories: map("memory"),
      globals: map("global"),
      elements: map("elem"),
      data: map("data"),
    };
    const present = Object.fromEntries(
      Object.entries(names).filter(([, value]) => value !== undefined),
    );
    return Object.keys(present).length > 0 ? { names: present } : {};
  }
}

/** The offset of an inline segment, at the start of its memory or table. */
function zero(address: AddressType): ResolvedInstruction[] {
  return [
    address === "i64" ? { name: "i64.const", immediate: 0n } : { name: "i32.const", immediate: 0 },
  ];
}

function equal(a: FunctionType, b: FunctionType) {
  return (
    a.args.length === b.args.length &&
    a.results.length === b.results.length &&
    a.args.every((type, i) => type === b.args[i]) &&
    a.results.every((type, i) => type === b.results[i])
  );
}
