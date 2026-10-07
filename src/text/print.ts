import type { Module } from "../module-binable.ts";
import type { ResolvedInstruction } from "../instruction/base.ts";
import type { NameMap } from "../name-section.ts";
import {
  type FieldType,
  isFunctionType,
  type FunctionType,
  GlobalType,
  Limits,
  TableType,
  MemoryType,
  ValueType,
} from "../types.ts";
import { impliedType, sectionIds } from "./wat.ts";
import { printInstructions, printString, printValueType, type Names } from "./instructions.ts";

export { printWat };

const idChars = /^[0-9A-Za-z!#$%&'*+\-./:<=>?@\\^_`|~]+$/;

/**
 * Print a module as WAT that parses back to the same module, including names. Names print as
 * identifiers where they are unique in their index space; other indices print as numbers.
 */
function printWat(module: Module): string {
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
  const fieldIds = Object.fromEntries(
    Object.entries(names.fields ?? {}).map(([type, fields]) => [type, identifiers(fields)]),
  );
  const moduleNames: Names = {
    id: (space, index) => spaces[space as keyof typeof spaces]?.[index],
    field: (type, field) => fieldIds[type]?.[field],
    typeUse: () => "",
  };
  const id = (space: keyof typeof spaces, index: number) =>
    moduleNames.id(space, index) ?? String(index);
  const label = (space: keyof typeof spaces, index: number) => moduleNames.id(space, index) ?? "";
  // Function and tag names that are not unique identifiers print as @name annotations.
  const annotated = { function: names.functions ?? {}, tag: names.tags ?? {} };
  const labelAndName = (space: "function" | "tag", index: number) => {
    const name = annotated[space][index];
    const id = label(space, index);
    if (name === undefined || id !== "") return id;
    return `(@name ${printName(name)})`;
  };
  const expression = (body: ResolvedInstruction[]) =>
    printInstructions(body, moduleNames).join(" ");
  const type = (value: ValueType) => printValueType(value, moduleNames);
  const fields: string[] = [];
  const field = (...parts: string[]) =>
    fields.push(`(${parts.filter((part) => part !== "").join(" ")})`);

  // A type use: a named type by its identifier, otherwise inline parameters and results, preceded by
  // the type's index unless the inline signature refers to it. Definitions also inline their
  // parameters to carry local names. Block types without parameters and with at most one result
  // abbreviate to a value type instead, so they keep the index.
  const groups = module.recGroups ?? module.types.map(() => 1);
  const typeUse = (
    typeIdx: number,
    { locals, block = false }: { locals?: NameMap; block?: boolean } = {},
  ) => {
    const type = module.types[typeIdx];
    if (type === undefined || !isFunctionType(type)) return `(type ${typeIdx})`;
    const named = spaces.type[typeIdx] !== undefined;
    const abbreviated = block && type.args.length === 0 && type.results.length <= 1;
    const implied = !named && !abbreviated && impliedType(module.types, groups, type) === typeIdx;
    const inline = !named || locals !== undefined;
    return [
      ...(implied ? [] : [`(type ${id("type", typeIdx)})`]),
      ...(inline
        ? [
            ...type.args.map(
              (arg, i) =>
                `(param ${optional(identifiers(locals)[i])}${printValueType(arg, moduleNames)})`,
            ),
            ...results(type, moduleNames),
          ]
        : []),
    ].join(" ");
  };
  moduleNames.typeUse = (typeIdx, block) => typeUse(typeIdx, { block });

  // Types, in their recursion groups; a type outside of rec forms a group of its own.
  const definition = (typeIdx: number) => {
    const type = module.types[typeIdx];
    const fieldType = ({ type, mutable }: FieldType) =>
      mutable ? `(mut ${printValueType(type, moduleNames)})` : printValueType(type, moduleNames);
    const typeFieldIds = fieldIds[typeIdx] ?? {};
    const composite =
      "struct" in type
        ? `(${["struct", ...type.struct.map((f, i) => `(field ${optional(typeFieldIds[i])}${fieldType(f)})`)].join(" ")})`
        : "array" in type
          ? `(array ${fieldType(type.array)})`
          : `(${["func", ...params(type, moduleNames), ...results(type, moduleNames)].join(" ")})`;
    if (type.final !== false && type.supertype === undefined) return composite;
    const supertype = type.supertype === undefined ? [] : [id("type", type.supertype as number)];
    const final = type.final === false ? [] : ["final"];
    return `(${["sub", ...final, ...supertype, composite].join(" ")})`;
  };
  const typeField = (i: number) =>
    `(${["type", label("type", i), definition(i)].filter((p) => p !== "").join(" ")})`;
  let start = 0;
  for (const size of module.recGroups ?? module.types.map(() => 1)) {
    const members = Array.from({ length: size }, (_, i) => typeField(start + i));
    fields.push(size === 1 ? members[0] : `(${["rec", ...members].join(" ")})`);
    start += size;
  }
  const next = { function: 0, table: 0, memory: 0, global: 0, tag: 0 };
  for (const { module: from, name, description } of module.imports) {
    const index = next[description.kind]++;
    const path = `${printName(from)} ${printName(name)}`;
    const space = description.kind;
    let desc: string;
    if (description.kind === "function")
      desc = typeUse(description.value, { locals: names.locals?.[index] ?? {} });
    else if (description.kind === "table") desc = tableType(description.value, moduleNames);
    else if (description.kind === "memory") desc = memoryType(description.value);
    else if (description.kind === "tag") desc = typeUse(description.value);
    else desc = globalType(description.value, moduleNames);
    const kind = space === "function" ? "func" : space;
    field(
      "import",
      path,
      `(${[kind, space === "function" || space === "tag" ? labelAndName(space, index) : label(space, index), desc].filter((x) => x !== "").join(" ")})`,
    );
  }
  for (const func of module.funcs) {
    const locals = names.locals?.[func.funcIdx] ?? {};
    const localIds = identifiers(locals);
    const header = [
      "func",
      labelAndName("function", func.funcIdx),
      typeUse(func.typeIdx, { locals }),
    ];
    const declarations = func.locals.map(
      (local, i) => `(local ${optional(localIds[func.type.args.length + i])}${type(local)})`,
    );
    const bodyNames: Names = {
      ...moduleNames,
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
  module.tags.forEach((typeIdx, i) =>
    field("tag", labelAndName("tag", next.tag + i), typeUse(typeIdx)),
  );
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

  for (const { name, data, after } of module.customSections ?? []) {
    const placement =
      after === undefined
        ? ""
        : after === 0
          ? "(before first)"
          : `(after ${Object.entries(sectionIds).find(([, id]) => id === after)![0]})`;
    field("@custom", printName(name), placement, printString(data));
  }

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

/** A name as a string literal: Unicode characters stay readable, control characters are escaped. */
function printName(name: string): string {
  let text = '"';
  for (const char of name) {
    const code = char.codePointAt(0)!;
    text +=
      code < 0x20 || code === 0x7f || char === '"' || char === "\\"
        ? printString(new TextEncoder().encode(char)).slice(1, -1)
        : char;
  }
  return text + '"';
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
