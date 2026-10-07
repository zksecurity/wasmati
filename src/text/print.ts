import type { Module } from "../module-binable.ts";
import type { ResolvedInstruction } from "../instruction/base.ts";
import type { NameMap } from "../name-section.ts";
import type {
  FunctionType,
  GlobalType,
  Limits,
  TableType,
  MemoryType,
  ValueType,
} from "../types.ts";
import { UnsupportedTextError } from "./lexer.ts";
import { printInstructions, printString, printValueType, type Names } from "./instructions.ts";

export { printWat };

const idChars = /^[0-9A-Za-z!#$%&'*+\-./:<=>?@\\^_`|~]+$/;

/**
 * Print a module as WAT that parses back to the same module, including names. Names print as
 * identifiers where they are unique in their index space; other indices print as numbers.
 */
function printWat(module: Module): string {
  if (module.customSections?.length)
    throw new UnsupportedTextError("custom sections cannot be printed as text");
  const names = module.names ?? {};
  const spaces = {
    type: identifiers(names.types),
    function: identifiers(names.functions),
    table: identifiers(names.tables),
    memory: identifiers(names.memories),
    global: identifiers(names.globals),
    elem: identifiers(names.elements),
    data: identifiers(names.data),
    tag: identifiers(names.tags),
  };
  const moduleNames: Names = {
    id: (space, index) => spaces[space as keyof typeof spaces]?.[index],
  };
  const id = (space: keyof typeof spaces, index: number) =>
    moduleNames.id(space, index) ?? String(index);
  const label = (space: keyof typeof spaces, index: number) => moduleNames.id(space, index) ?? "";
  const expression = (body: ResolvedInstruction[]) =>
    printInstructions(body, moduleNames).join(" ");
  const type = (value: ValueType) => printValueType(value, moduleNames);
  const fields: string[] = [];
  const field = (...parts: string[]) =>
    fields.push(`(${parts.filter((part) => part !== "").join(" ")})`);

  // A function's type, with inline parameters that carry its local names.
  const signature = (typeIdx: number, locals: NameMap = {}, type = module.types[typeIdx]) => {
    if (type === undefined) return `(type ${typeIdx})`;
    return [
      `(type ${id("type", typeIdx)})`,
      ...type.args.map(
        (arg, i) =>
          `(param ${optional(identifiers(locals)[i])}${printValueType(arg, moduleNames)})`,
      ),
      ...results(type, moduleNames),
    ].join(" ");
  };

  module.types.forEach((func, i) =>
    field(
      "type",
      label("type", i),
      `(${["func", ...params(func, moduleNames), ...results(func, moduleNames)].join(" ")})`,
    ),
  );
  const next = { function: 0, table: 0, memory: 0, global: 0, tag: 0 };
  for (const { module: from, name, description } of module.imports) {
    const index = next[description.kind]++;
    const path = `${printName(from)} ${printName(name)}`;
    const space = description.kind;
    let desc: string;
    if (description.kind === "function") desc = signature(description.value, names.locals?.[index]);
    else if (description.kind === "table") desc = tableType(description.value, moduleNames);
    else if (description.kind === "memory") desc = memoryType(description.value);
    else if (description.kind === "tag") desc = signature(description.value);
    else desc = globalType(description.value, moduleNames);
    const kind = space === "function" ? "func" : space;
    field(
      "import",
      path,
      `(${[kind, label(space, index), desc].filter((x) => x !== "").join(" ")})`,
    );
  }
  for (const func of module.funcs) {
    const locals = names.locals?.[func.funcIdx] ?? {};
    const localIds = identifiers(locals);
    const header = [
      "func",
      label("function", func.funcIdx),
      signature(func.typeIdx, locals, func.type),
    ];
    const declarations = func.locals.map(
      (local, i) => `(local ${optional(localIds[func.type.args.length + i])}${type(local)})`,
    );
    const bodyNames: Names = {
      id: (space, index) => (space === "local" ? localIds[index] : moduleNames.id(space, index)),
    };
    const lines = [...declarations, ...printInstructions(func.body, bodyNames)];
    fields.push(
      `(${header.filter((part) => part !== "").join(" ")}${lines.map((line) => "\n    " + line).join("")})`,
    );
  }
  module.tables.forEach((table, i) =>
    field(
      "table",
      label("table", next.table + i),
      tableType(table, moduleNames),
      table.init === undefined ? "" : expression(table.init),
    ),
  );
  module.memories.forEach((memory, i) =>
    field("memory", label("memory", next.memory + i), memoryType(memory)),
  );
  module.tags.forEach((typeIdx, i) => field("tag", label("tag", next.tag + i), signature(typeIdx)));
  module.globals.forEach((global, i) =>
    field(
      "global",
      label("global", next.global + i),
      globalType(global.type, moduleNames),
      expression(global.init),
    ),
  );
  for (const { name, description } of module.exports) {
    const kind = description.kind === "function" ? "func" : description.kind;
    field("export", printName(name), `(${kind} ${id(description.kind, description.value)})`);
  }
  if (module.start !== undefined) field("start", id("function", module.start));
  module.elems.forEach((elem, i) => {
    const mode =
      elem.mode === "passive"
        ? ""
        : elem.mode === "declarative"
          ? "declare"
          : `${elem.mode.table === 0 ? "" : `(table ${id("table", elem.mode.table)}) `}(offset ${expression(elem.mode.offset)})`;
    const items = elem.init.map((item) => `(item ${expression(item)})`);
    field("elem", label("elem", i), mode, type(elem.type), ...items);
  });
  module.datas.forEach((data, i) => {
    const mode =
      data.mode === "passive"
        ? ""
        : `${data.mode.memory === 0 ? "" : `(memory ${id("memory", data.mode.memory)}) `}(offset ${expression(data.mode.offset)})`;
    field("data", label("data", i), mode, printString(data.init));
  });

  const name = names.module === undefined ? "" : " " + identifier(names.module);
  return `(module${name}${fields.map((field) => "\n  " + field).join("")})\n`;
}

/** Identifiers for the names of one index space, omitting names that occur more than once. */
function identifiers(names: NameMap = {}): Record<number, string> {
  const counts = new Map<string, number>();
  for (const name of Object.values(names)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return Object.fromEntries(
    Object.entries(names).flatMap(([index, name]) =>
      name !== "" && counts.get(name) === 1 ? [[index, identifier(name)]] : [],
    ),
  );
}

function identifier(name: string): string {
  return "$" + (idChars.test(name) ? name : printName(name));
}

function printName(name: string): string {
  return printString(new TextEncoder().encode(name));
}

function optional(id: string | undefined) {
  return id === undefined ? "" : id + " ";
}

function params(type: FunctionType, names: Names) {
  const args = type.args.map((arg) => printValueType(arg, names));
  return args.length === 0 ? [] : [`(param ${args.join(" ")})`];
}

function results(type: FunctionType, names: Names) {
  const results = type.results.map((result) => printValueType(result, names));
  return results.length === 0 ? [] : [`(result ${results.join(" ")})`];
}

function limits({ min, max, address }: Limits) {
  const sizes = max === undefined ? `${min}` : `${min} ${max}`;
  return address === "i64" ? `i64 ${sizes}` : sizes;
}

function tableType(table: TableType, names: Names) {
  return `${limits(table.limits)} ${printValueType(table.type, names)}`;
}

function memoryType(memory: MemoryType) {
  return `${limits(memory.limits)}${memory.limits.shared ? " shared" : ""}`;
}

function globalType(type: GlobalType, names: Names) {
  const value = printValueType(type.value, names);
  return type.mutable ? `(mut ${value})` : value;
}
