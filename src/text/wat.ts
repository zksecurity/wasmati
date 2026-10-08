import type { Module } from "../module-binable.ts";
import type { Import, Export } from "../export.ts";
import type { Elem, Data } from "../memory-binable.ts";
import type { ResolvedInstruction } from "../instruction/base.ts";
import type { NameMap, NameSection } from "../name-section.ts";
import {
  type AddressType,
  type CompositeType,
  type FieldType,
  type FunctionType,
  isFunctionType,
  type StorageType,
  type TypeDefinition,
  type GlobalType,
  type IndexSpace,
  isRefType,
  refType,
  type MemoryType,
  type RefType,
  type TableType,
  functionTypeEquals,
  type ValueType,
} from "../types.ts";
import { Cursor } from "./cursor.ts";
import { readTree, withLocation, UnsupportedTextError, type List, type Node } from "./lexer.ts";
import { parseInstructions, parseValueType, type BlockType, type Scope } from "./instructions.ts";
import { parseU64 } from "./numbers.ts";
import { limits } from "../memory.ts";

export { parseWat, parseModule, impliedType, sectionIds };

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
type EntityKind = "func" | "table" | "memory" | "global" | "tag";
const spaceOf = {
  func: "function",
  table: "table",
  memory: "memory",
  global: "global",
  tag: "tag",
} as const;

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
    memories: [],
    tags: [],
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
    tag: 0,
  };
  private ids = Object.fromEntries(
    Object.keys(this.counts).map((space) => [space, new Map<string, number>()]),
  ) as Record<ModuleSpace, Map<string, number>>;
  private locals: Record<number, NameMap> = {};
  private defined = false;

  /** Type definitions can refer to later types, and other fields to all of them. */
  private typeDefinitions: (() => void)[] = [];
  /** Sizes of the recursion groups, in order; a type outside of rec is a group of its own. */
  private groups: number[] = [];
  /** Field identifiers of struct types, by type index. */
  private fieldIds = new Map<number, Map<string, number>>();
  /** Names given by `@name` annotations, which take precedence over identifiers. */
  private annotatedNames = { function: new Map<number, string>(), tag: new Map<number, string>() };

  parse(c: Cursor, id: string | undefined): Module {
    const name = c.peekHead() === "@name" ? nameAnnotation(c.list("@name")) : id;
    const definitions = c.until((c) => this.field(c.list()));
    for (const define of this.typeDefinitions) define();
    for (const define of definitions) define();
    const recGroups = this.groups.some((size) => size !== 1) ? { recGroups: this.groups } : {};
    return { ...this.module, ...recGroups, ...this.names(name) };
  }

  // First pass: assign indices and identifiers, and return the second pass for the field.

  private field(c: Cursor): () => void {
    const kind = c.atom();
    switch (kind) {
      case "type":
        this.typeField(c);
        this.groups.push(1);
        return () => {};
      case "import":
        return this.imports(c);
      case "func":
      case "table":
      case "memory":
      case "global":
      case "tag":
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
      case "rec": {
        const types = c.until((c) => this.typeField(c.list("type")));
        this.groups.push(types.length);
        return () => {};
      }
      case "@custom":
        return () => this.customSection(c);
      case "@name":
        return c.fail("misplaced @name annotation");
      default:
        return c.fail(`unknown module field ${kind}`);
    }
  }

  /**
   * `(import "module" "name" description)`, or the compact forms with several items of one module:
   * `(import "module" (item "name" description)*)`, or `(import "module" (item "name")* description)`
   * with a shared description.
   */
  private imports(c: Cursor): () => void {
    const module = c.name();
    const description = (node: Node, name: string) => {
      if (node.kind !== "list") return c.fail("expected an import description", node);
      const description = Cursor.of(node);
      const kind = description.atom();
      if (!(kind in spaceOf)) description.fail(`unknown import kind ${kind}`);
      return this.entity(kind as EntityKind, description, { module, name });
    };
    if (c.peek()?.kind === "string") {
      const name = c.name();
      const node = c.next();
      c.end();
      return description(node, name);
    }
    const items = c.lists("item", (item) => {
      const name = item.name();
      const node = item.done ? undefined : item.next();
      item.end();
      return { name, node };
    });
    const shared = items.every(({ node }) => node === undefined) && !c.done ? c.next() : undefined;
    c.end();
    if (shared !== undefined) {
      // A shared description describes several entities, so it cannot bind an identifier.
      const check = shared.kind === "list" ? Cursor.of(shared) : undefined;
      check?.atom();
      if (check?.peekIdentifier())
        check.fail("identifier not allowed in a shared import description");
    }
    const imports = items.map(({ name, node }) => {
      if (node === undefined && shared === undefined) c.fail("import item without description");
      // A shared description is read once per item.
      return description((node ?? shared)!, name);
    });
    // Without items, a shared function type use still defines its type.
    if (items.length === 0 && shared?.kind === "list") {
      const use = Cursor.of(shared);
      const kind = use.atom();
      if (kind === "func" || kind === "tag") imports.push(() => this.typeUse(use, true));
    }
    return () => imports.forEach((define) => define());
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

  /** `(type $id? (sub final? x? comptype))` or `(type $id? comptype)`, read once all types are named. */
  private typeField(c: Cursor) {
    const index = this.allocate(c, "type");
    this.typeDefinitions.push(() => {
      this.module.types[index] = this.typeDefinition(c, index);
      c.end();
    });
  }

  private typeDefinition(c: Cursor, index: number): TypeDefinition {
    const sub = c.maybeList("sub");
    if (sub === undefined) {
      const composite = c.list();
      const type = this.compositeType(composite, index);
      composite.end();
      return type;
    }
    const final = sub.maybeKeyword("final");
    const supertypes = [];
    while (sub.peekIndex()) supertypes.push(this.index(sub, "type"));
    if (supertypes.length > 1)
      throw new UnsupportedTextError("multiple supertypes are not supported");
    const composite = sub.list();
    const type: TypeDefinition = this.compositeType(composite, index);
    composite.end();
    sub.end();
    if (!final) type.final = false;
    if (supertypes.length === 1) type.supertype = supertypes[0];
    return type;
  }

  /** `(func ...)`, `(struct (field $id? fieldtype)*)` or `(array fieldtype)`. */
  private compositeType(c: Cursor, index: number): CompositeType {
    const kind = c.atom();
    if (kind === "func") return this.signature(c, true).type;
    if (kind === "array") return { array: this.fieldType(c) };
    if (kind !== "struct") return c.fail(`unknown composite type ${kind}`);
    const ids = new Map<string, number>();
    const struct: FieldType[] = [];
    c.lists("field", (field) => {
      const node = field.peek();
      const id = field.identifier();
      const types = field.until((f) => this.fieldType(f));
      if (id !== undefined) {
        if (types.length !== 1) field.fail("a named field has one type");
        if (ids.has(id)) field.fail(`duplicate field $${id}`, node);
        ids.set(id, struct.length);
      }
      struct.push(...types);
    });
    if (ids.size > 0) this.fieldIds.set(index, ids);
    return { struct };
  }

  /** A storage type, made mutable by `(mut ...)`. */
  private fieldType(c: Cursor): FieldType {
    const mutable = c.maybeList("mut");
    const type = this.storageType(mutable ?? c);
    mutable?.end();
    return { type, mutable: mutable !== undefined };
  }

  private storageType(c: Cursor): StorageType {
    if (c.maybeKeyword("i8")) return "i8";
    if (c.maybeKeyword("i16")) return "i16";
    return this.valueType(c);
  }

  /** A function, table, memory or global, imported or defined, with inline exports. */
  private entity(kind: EntityKind, c: Cursor, path?: Path) {
    const space = spaceOf[kind];
    const index = this.allocate(c, space);
    if ((space === "function" || space === "tag") && c.peekHead() === "@name")
      this.annotatedNames[space].set(index, nameAnnotation(c.list("@name")));
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
      else if (kind === "tag") this.module.tags.push(this.tagType(c));
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
      case "tag":
        return { kind: "tag", value: this.tagType(c) };
    }
  }

  /** A tag's type use; exceptions carry the parameters and have no results. */
  private tagType(c: Cursor): number {
    return this.typeUse(c, true).index;
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
      // A table may initialize its elements with a constant expression.
      const type = this.tableType(c);
      this.module.tables.push(
        c.done ? type : { ...type, init: parseInstructions(c, this.scope()) },
      );
      return;
    }
    const address = this.address(c);
    const type = this.refType(c);
    const items = c.list("elem");
    const init = items.done || items.peekIndex() ? this.functions(items) : this.expressions(items);
    items.end();
    const size = init.length;
    this.module.tables.push({ type, limits: limits(size, size, false, address) });
    // The inline segment has the table's type, even when given as function indices.
    this.module.elems[segment] = { type, init, mode: { table: index, offset: zero(address) } };
  }

  private memory(c: Cursor, index: number, segment: number | undefined) {
    if (segment === undefined) {
      this.module.memories.push(this.memoryType(c));
      return;
    }
    const address = this.address(c);
    const data = c.list("data");
    const init = Uint8Array.from(data.until((d) => d.bytes()).flat());
    data.end();
    const pages = Math.ceil(init.length / 65536);
    this.module.memories.push({ limits: limits(pages, pages, false, address) });
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
    // An active segment starts with its table or offset; a reference type may start a passive one.
    else if (c.peek()?.kind === "list" && c.peekHead() !== "ref") {
      const table = c.maybeList("table");
      const tableIndex = table === undefined ? 0 : this.index(table, "table");
      table?.end();
      mode = { table: tableIndex, offset: this.offset(c) };
    }
    // Function indices denote non-null function references.
    let type: RefType = refType("func", false);
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
    const init = Uint8Array.from(c.until((c) => c.bytes()).flat());
    this.module.datas[index] = { init, mode };
  }

  private offset(c: Cursor): ResolvedInstruction[] {
    const offset = c.maybeList("offset");
    if (offset === undefined) return parseInstructions(new Cursor([c.next()]), this.scope());
    const expression = parseInstructions(offset, this.scope());
    offset.end();
    return expression;
  }

  /** `(@custom name placement? datastring)`: a custom section, after the last section by default. */
  private customSection(c: Cursor) {
    if (c.peek()?.kind !== "string") c.fail("@custom annotation: missing section name");
    const name = c.name();
    let after: number | undefined;
    const placement = c.peek()?.kind === "list" ? c.list() : undefined;
    if (placement !== undefined) {
      const direction = placement.atom();
      if (direction !== "before" && direction !== "after")
        placement.fail("@custom annotation: malformed placement");
      const node = placement.peek();
      const section = placement.done ? "" : placement.atom();
      const position = sectionOrder.indexOf(
        section === "first" ? "type" : section === "last" ? "data" : section,
      );
      if (position === -1) placement.fail("@custom annotation: malformed section kind", node);
      placement.end();
      // Custom sections are placed after a section; before the first one, after none.
      const previous = direction === "after" ? sectionOrder[position] : sectionOrder[position - 1];
      after = previous === undefined ? 0 : sectionIds[previous];
    }
    const data = Uint8Array.from(c.until((c) => c.bytes()).flat());
    (this.module.customSections ??= []).push({
      name,
      data,
      ...(after === undefined ? {} : { after }),
    });
  }

  // Types

  private valueType(c: Cursor): ValueType {
    return parseValueType(c, (c) => this.index(c, "type"));
  }

  private refType(c: Cursor): RefType {
    const node = c.peek();
    const type = this.valueType(c);
    if (!isRefType(type)) c.fail("expected reference type", node);
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
    return { type: this.refType(c), limits: limits(min, max, false, address) };
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
    if (mutable === undefined) return { value: this.valueType(c), mutable: false };
    const value = this.valueType(mutable);
    mutable.end();
    return { value, mutable: true };
  }

  /** `(param $id? t)` or `(param t*)`, and likewise for locals. */
  private group(c: Cursor) {
    const name = c.identifier();
    const types = c.until((c) => this.valueType(c));
    if (name !== undefined && types.length !== 1) c.fail("a named parameter or local has one type");
    return { names: types.map(() => name), types };
  }

  private signature(c: Cursor, named: boolean) {
    const params = c.lists("param", (p) => this.group(p));
    if (!named && params.some((p) => p.names.some((name) => name !== undefined)))
      c.fail("unexpected parameter identifier");
    const results = c.lists("result", (r) => r.until((c) => this.valueType(c))).flat();
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
    if ((referenced === undefined || !isFunctionType(referenced)) && !inline)
      return { index: explicit, type, names };
    if (referenced === undefined || !isFunctionType(referenced))
      c.fail(`type ${explicit} is not a function type`);
    if (inline && !functionTypeEquals(referenced, type))
      c.fail("inline function type does not match the referenced type");
    return { index: explicit, type: referenced, names };
  }

  /** The type an inline signature refers to, or a new one at the end. */
  private findType(type: FunctionType): number {
    const index = impliedType(this.module.types, this.groups, type);
    if (index !== -1) return index;
    this.counts.type++;
    this.groups.push(1);
    return this.module.types.push(type) - 1;
  }

  private blockType(c: Cursor): BlockType {
    if (c.peekHead() !== "type" && c.peekHead() !== "param") {
      const results = c.lists("result", (r) => r.until((c) => this.valueType(c))).flat();
      if (results.length <= 1) return results[0] ?? "empty";
      return this.findType({ args: [], results });
    }
    return this.typeUse(c, false).index;
  }

  // Names

  /** Read an index of a space: a number, or an identifier bound in that space. */
  private index(
    c: Cursor,
    space: IndexSpace | "field",
    ids = this.ids[space as ModuleSpace],
  ): number {
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
      field: (c, type) => this.index(c, "field", this.fieldIds.get(type) ?? new Map()),
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
    const annotated = (space: "function" | "tag") => {
      const names = { ...map(space), ...Object.fromEntries(this.annotatedNames[space]) };
      return Object.keys(names).length === 0 ? undefined : names;
    };
    const names: NameSection = {
      module,
      functions: annotated("function"),
      locals: Object.keys(this.locals).length > 0 ? this.locals : undefined,
      types: map("type"),
      fields:
        this.fieldIds.size === 0
          ? undefined
          : Object.fromEntries(
              [...this.fieldIds].map(([type, ids]) => [
                type,
                Object.fromEntries([...ids].map(([name, field]) => [field, name])),
              ]),
            ),
      tables: map("table"),
      memories: map("memory"),
      tags: annotated("tag"),
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

/** Sections in binary order, as custom section placements name them. */
const sectionOrder = [
  "type",
  "import",
  "func",
  "table",
  "memory",
  "tag",
  "global",
  "export",
  "start",
  "elem",
  "datacount",
  "code",
  "data",
];
const sectionIds: Record<string, number> = {
  type: 1,
  import: 2,
  func: 3,
  table: 4,
  memory: 5,
  global: 6,
  export: 7,
  start: 8,
  elem: 9,
  code: 10,
  data: 11,
  datacount: 12,
  tag: 13,
};

/** An inline signature refers to the first final function type of its own group with that signature. */
function impliedType(types: TypeDefinition[], groups: number[], type: FunctionType): number {
  const singletons = new Set<number>();
  groups.reduce((start, size) => (size === 1 && singletons.add(start), start + size), 0);
  return types.findIndex(
    (other, i) =>
      singletons.has(i) &&
      isFunctionType(other) &&
      other.final !== false &&
      other.supertype === undefined &&
      functionTypeEquals(other, type),
  );
}

/** `(@name "name")`, which names the enclosing module, function or tag in the name section. */
function nameAnnotation(c: Cursor): string {
  if (c.peek()?.kind !== "string") c.fail("@name annotation: missing name");
  const name = c.name();
  c.end();
  return name;
}

/** The offset of an inline segment, at the start of its memory or table. */
function zero(address: AddressType): ResolvedInstruction[] {
  return [
    address === "i64" ? { name: "i64.const", immediate: 0n } : { name: "i32.const", immediate: 0 },
  ];
}
