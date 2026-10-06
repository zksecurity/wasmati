import * as C from "../codec.ts";
import type { Module as ModuleValue } from "../module-binable.ts";
import type { FunctionType, ValueType } from "../types.ts";
import type { ResolvedInstruction } from "../instruction/base.ts";
import { TextSyntaxError, UnsupportedTextError } from "./lexer.ts";
import { Name, Script, Text, type Expression } from "./text.ts";
import {
  form,
  head,
  Index,
  optional,
  position,
  repeated,
  token,
  type IndexValue,
  record,
} from "./grammar.ts";
import {
  Instructions,
  label,
  LocalGroup,
  TypeUse,
  type Instruction,
  type LocalGroupValue,
  type TypeUseValue,
} from "./instructions.ts";
import { Memory, Global, Table } from "./objects.ts";

export { Wat, ModuleSyntax };

const Path = record({ module: token(Name), field: token(Name) });
const Function = record({
  name: label,
  exports: repeated(form("export", token(Name)), "export"),
  path: optional(form("import", Path), (node) => head(node) === "import"),
  signature: TypeUse,
  locals: repeated(form("local", LocalGroup), "local"),
  body: Instructions,
});
type Function = ReturnType<typeof Function.decode>[0];
const Type = record({ name: label, signature: form("func", TypeUse) });
const Import = record({ path: Path, func: form("func", Function) });
type Description = { kind: "function" | "global" | "memory" | "table"; index: IndexValue };
const Description: C.Codec<Description, Expression> = {
  encode(value) {
    return form(value.kind === "function" ? "func" : value.kind, Index).encode(value.index);
  },
  decode(input, offset) {
    const name = head(input[offset]);
    if (name !== "func" && name !== "global" && name !== "memory" && name !== "table")
      throw new TextSyntaxError("expected export kind", position(input[offset]));
    const [index, end] = form(name, Index).decode(input, offset);
    return [{ kind: name === "func" ? "function" : name, index }, end];
  },
};
const Export = record({ name: token(Name), description: Description });

type Field =
  | { kind: "type"; value: ReturnType<typeof Type.decode>[0] }
  | { kind: "func"; value: Function }
  | { kind: "import"; value: ReturnType<typeof Import.decode>[0] }
  | { kind: "export"; value: ReturnType<typeof Export.decode>[0] }
  | { kind: "memory"; value: ReturnType<typeof Memory.decode>[0] }
  | { kind: "global"; value: ReturnType<typeof Global.decode>[0] }
  | { kind: "table"; value: ReturnType<typeof Table.decode>[0] }
  | { kind: "start"; value: IndexValue };

function tagged<K extends Field["kind"]>(
  kind: K,
  codec: C.Codec<Extract<Field, { kind: K }>["value"], Expression>,
): C.Codec<Extract<Field, { kind: K }>, Expression> {
  return C.iso(form(kind, codec), {
    to: (field) => field.value,
    from: (value) => ({ kind, value }) as Extract<Field, { kind: K }>,
  });
}
const fields = {
  type: tagged("type", Type),
  func: tagged("func", Function),
  import: tagged("import", Import),
  export: tagged("export", Export),
  start: tagged("start", Index),
  memory: tagged("memory", Memory),
  global: tagged("global", Global),
  table: tagged("table", Table),
};
// Select by syntax before decoding, so malformed and unsupported fields retain their errors.
const Field: C.Codec<Field, Expression> = {
  encode(field) {
    return (fields[field.kind] as C.Codec<Field, Expression>).encode(field);
  },
  decode(input, offset) {
    const name = head(input[offset]);
    if (name === undefined || !Object.hasOwn(fields, name)) {
      const known = new Set(["table", "memory", "global", "elem", "data", "tag", "rec"]);
      if (name !== undefined && known.has(name))
        throw new UnsupportedTextError(`module field ${name} is not implemented`);
      throw new TextSyntaxError(
        `unsupported module field ${name ?? "<token>"}`,
        position(input[offset]),
      );
    }
    return fields[name as keyof typeof fields].decode(input, offset);
  },
};
const Module = form("module", record({ name: label, fields: C.sequence(Field) }));
type SourceModule = ReturnType<typeof Module.decode>[0];

/** WAT and Wasm use the same normalized module endpoint. Syntax parsing does not validate stack types. */
const ModuleSyntax = C.iso(Module, { to: denormalize, from: normalize });
const Wat = Text(
  C.iso(Script, {
    to: (module: ModuleValue) => ModuleSyntax.encode(module),
    from: (expressions) => {
      // WAT allows the enclosing (module ...) form to be omitted.
      if (expressions.length === 1 && head(expressions[0]) === "module") {
        return ModuleSyntax.decode(expressions, 0)[0];
      }
      return ModuleSyntax.decode([[{ kind: "atom", text: "module" }, ...expressions]], 0)[0];
    },
  }),
);

function flatten(groups: LocalGroupValue[]): ValueType[] {
  return groups.flatMap((group) => group.types);
}

/** Identifier tables resolve symbolic indices only; numeric index and stack validation belongs to the API. */
class Identifiers {
  private indices = new Map<string, number>();

  add(name: string | undefined, index: number) {
    if (name === undefined) return;
    if (this.indices.has(name)) throw new TextSyntaxError(`duplicate identifier $${name}`);
    this.indices.set(name, index);
  }

  resolve(index: IndexValue): number {
    if (typeof index === "number") return index;
    const value = this.indices.get(index);
    if (value === undefined) throw new TextSyntaxError(`unknown identifier $${index}`);
    return value;
  }

  names(): Record<number, string> {
    return Object.fromEntries([...this.indices].map(([name, index]) => [index, name]));
  }
}

function normalize(source: SourceModule): ModuleValue {
  const module: ModuleValue = {
    types: [],
    funcs: [],
    globals: [],
    tables: [],
    elems: [],
    datas: [],
    imports: [],
    exports: [],
  };
  const types = new Identifiers();
  const functions = new Identifiers();
  const globals = new Identifiers();
  const memories = new Identifiers();
  const tables = new Identifiers();
  for (const field of source.fields) {
    if (field.kind !== "type") continue;
    const { name, signature } = field.value;
    if (signature.index !== undefined)
      throw new TextSyntaxError("type declarations cannot use another type");
    types.add(name, module.types.length);
    module.types.push({ args: flatten(signature.params), results: signature.results.flat() });
  }

  function typeIndex(use: TypeUseValue): number {
    const type = { args: flatten(use.params), results: use.results.flat() };
    const equal = (other: FunctionType) => JSON.stringify(other) === JSON.stringify(type);
    if (use.index !== undefined) {
      const index = types.resolve(use.index);
      const referenced = module.types[index];
      if (referenced === undefined) throw new TextSyntaxError(`unknown type ${index}`);
      if ((use.params.length || use.results.length) && !equal(referenced)) {
        throw new TextSyntaxError("inline signature does not match referenced type");
      }
      return index;
    }
    const existing = module.types.findIndex(equal);
    if (existing !== -1) return existing;
    module.types.push(type);
    return module.types.length - 1;
  }

  const declarations: Function[] = [];
  let defined = false;
  for (const field of source.fields) {
    if (field.kind !== "func" && field.kind !== "import") continue;
    const func =
      field.kind === "func" ? field.value : { ...field.value.func, path: field.value.path };
    if (field.kind === "import" && field.value.func.path !== undefined)
      throw new TextSyntaxError("nested inline import");
    if (func.path !== undefined) {
      if (defined) throw new TextSyntaxError("function imports must precede definitions");
      if (func.locals.length || func.body.length)
        throw new TextSyntaxError("imported functions cannot have locals or a body");
    } else defined = true;
    functions.add(func.name, declarations.length);
    declarations.push(func);
  }

  const localNames: Record<number, Record<number, string>> = {};
  let globalIndex = 0;
  for (const field of source.fields) {
    if (field.kind === "memory") {
      if (module.memory !== undefined)
        throw new UnsupportedTextError(
          "multiple memories are not supported by the module representation",
        );
      memories.add(field.value.name, 0);
      module.memory = { limits: { ...field.value.limits, shared: false } };
      for (const name of field.value.exports)
        module.exports.push({ name, description: { kind: "memory", value: 0 } });
    }
    if (field.kind === "global") {
      globals.add(field.value.name, globalIndex);
      for (const name of field.value.exports)
        module.exports.push({ name, description: { kind: "global", value: globalIndex } });
      globalIndex++;
    }
    if (field.kind === "table") {
      const index = module.tables.length;
      tables.add(field.value.name, index);
      const { storage } = field.value;
      module.tables.push({ type: storage.type, limits: { ...storage.limits, shared: false } });
      for (const name of field.value.exports)
        module.exports.push({ name, description: { kind: "table", value: index } });
      if (storage.init !== undefined)
        module.elems.push({
          type: storage.type,
          mode: { table: index, offset: [{ name: "i32.const", immediate: 0 }] },
          init: storage.init.map((ref) => [
            { name: "ref.func", immediate: functions.resolve(ref) },
          ]),
        });
    }
  }
  for (const field of source.fields) {
    if (field.kind === "global")
      module.globals.push({
        type: field.value.type,
        init: field.value.init.map((instruction) => ({
          name: instruction.name,
          immediate:
            instruction.name === "global.get"
              ? globals.resolve(instruction.immediate as IndexValue)
              : instruction.name === "ref.func"
                ? functions.resolve(instruction.immediate as IndexValue)
                : instruction.immediate,
        })),
      });
  }
  for (const [funcIdx, declaration] of declarations.entries()) {
    const typeIdx = typeIndex(declaration.signature);
    const type = module.types[typeIdx];
    const locals = new Identifiers();
    let localIndex = 0;
    for (const param of declaration.signature.params) {
      locals.add(param.name, localIndex);
      localIndex += param.types.length;
    }
    localIndex = type.args.length;
    for (const local of declaration.locals) {
      locals.add(local.name, localIndex);
      localIndex += local.types.length;
    }
    localNames[funcIdx] = locals.names();
    for (const name of declaration.exports)
      module.exports.push({ name, description: { kind: "function", value: funcIdx } });
    if (declaration.path !== undefined) {
      module.imports.push({
        module: declaration.path.module,
        name: declaration.path.field,
        description: { kind: "function", value: typeIdx },
      });
      continue;
    }
    function resolveBody(
      body: Instruction[],
      labels: (string | undefined)[],
    ): ResolvedInstruction[] {
      const resolveLabel = (index: IndexValue) => {
        if (typeof index === "number") return index;
        const depth = labels.indexOf(index);
        if (depth === -1) throw new TextSyntaxError(`unknown label $${index}`);
        return depth;
      };
      return body.map((instruction) => {
        const { name } = instruction;
        if (name === "block" || name === "loop" || name === "if") {
          const index = typeIndex(instruction.type!);
          const type = module.types[index];
          const blockType =
            instruction.type!.index !== undefined
              ? index
              : type.args.length === 0
                ? type.results.length === 0
                  ? "empty"
                  : type.results.length === 1
                    ? type.results[0]
                    : index
                : index;
          const nested = [instruction.label, ...labels];
          const ifBody = resolveBody(instruction.body!, nested);
          const instructions =
            name === "if"
              ? {
                  if: ifBody,
                  else:
                    instruction.else === undefined
                      ? undefined
                      : resolveBody(instruction.else, nested),
                }
              : ifBody;
          return { name, immediate: { blockType, instructions } };
        }
        let immediate = instruction.immediate;
        if (name.startsWith("local.")) immediate = locals.resolve(immediate as IndexValue);
        else if (name.startsWith("global.")) immediate = globals.resolve(immediate as IndexValue);
        else if (name === "call_indirect") {
          const { type, table } = immediate as { type: TypeUseValue; table?: IndexValue };
          immediate = [typeIndex(type), tables.resolve(table ?? 0)];
        } else if (name === "memory.size" || name === "memory.grow" || name === "memory.fill")
          immediate = memories.resolve(immediate as IndexValue);
        else if (name === "call" || name === "ref.func")
          immediate = functions.resolve(immediate as IndexValue);
        else if (name === "br" || name === "br_if")
          immediate = resolveLabel(immediate as IndexValue);
        else if (name === "br_table") {
          const indices = (immediate as IndexValue[]).map(resolveLabel);
          immediate = { indices: indices.slice(0, -1), defaultIndex: indices.at(-1)! };
        }
        return { name, immediate };
      });
    }
    module.funcs.push({
      funcIdx,
      typeIdx,
      type,
      locals: flatten(declaration.locals),
      body: resolveBody(declaration.body, [undefined]),
    });
  }
  for (const field of source.fields) {
    if (field.kind === "export")
      module.exports.push({
        name: field.value.name,
        description: {
          kind: field.value.description.kind,
          value: { function: functions, global: globals, memory: memories, table: tables }[
            field.value.description.kind
          ].resolve(field.value.description.index),
        },
      });
    if (field.kind === "start") {
      if (module.start !== undefined) throw new TextSyntaxError("duplicate start declaration");
      module.start = functions.resolve(field.value);
    }
  }
  module.names = {
    module: source.name,
    functions: functions.names(),
    types: types.names(),
    locals: localNames,
    globals: globals.names(),
    memories: memories.names(),
    tables: tables.names(),
  };
  return module;
}

function denormalize(module: ModuleValue): SourceModule {
  if (module.elems.length || module.datas.length || module.customSections?.length) {
    throw new Error("text printing of segments and custom sections is not implemented");
  }
  const signature = (
    type: FunctionType,
    index?: number,
    names: Record<number, string> = {},
  ): TypeUseValue => ({
    index,
    params: type.args.map((type, index) => ({ name: names[index], types: [type] })),
    results: type.results.length ? [type.results] : [],
  });
  const body = (instructions: ResolvedInstruction[]): Instruction[] =>
    instructions.map(({ name, immediate }) => {
      if (name === "block" || name === "loop" || name === "if") {
        const blockType = immediate.blockType as "empty" | ValueType | number;
        const type =
          typeof blockType === "number"
            ? module.types[blockType]
            : { args: [], results: blockType === "empty" ? [] : [blockType] };
        return {
          name,
          type: signature(type, typeof blockType === "number" ? blockType : undefined),
          body: body(name === "if" ? immediate.instructions.if : immediate.instructions),
          else:
            immediate.instructions.else === undefined
              ? undefined
              : body(immediate.instructions.else),
        };
      }
      return {
        name,
        immediate:
          name === "br_table"
            ? [...immediate.indices, immediate.defaultIndex]
            : name === "call_indirect"
              ? { table: immediate[1], type: signature(module.types[immediate[0]], immediate[0]) }
              : immediate,
      };
    });
  const fields: Field[] = module.types.map((type, index) => ({
    kind: "type",
    value: { name: module.names?.types?.[index], signature: signature(type) },
  }));
  let funcIdx = 0;
  for (const imp of module.imports) {
    if (imp.description.kind !== "function")
      throw new Error("only function imports can be printed as text yet");
    const index = imp.description.value;
    fields.push({
      kind: "import",
      value: {
        path: { module: imp.module, field: imp.name },
        func: {
          name: module.names?.functions?.[funcIdx],
          exports: [],
          path: undefined,
          signature: signature(module.types[index], index, module.names?.locals?.[funcIdx]),
          locals: [],
          body: [],
        },
      },
    });
    funcIdx++;
  }
  for (const func of module.funcs)
    fields.push({
      kind: "func",
      value: {
        name: module.names?.functions?.[func.funcIdx],
        exports: [],
        path: undefined,
        signature: signature(func.type, func.typeIdx, module.names?.locals?.[func.funcIdx]),
        locals: func.locals.map((type, index) => ({
          name: module.names?.locals?.[func.funcIdx]?.[func.type.args.length + index],
          types: [type],
        })),
        body: body(func.body),
      },
    });
  for (const exp of module.exports) {
    fields.push({
      kind: "export",
      value: {
        name: exp.name,
        description: { kind: exp.description.kind, index: exp.description.value },
      },
    });
  }
  module.globals.forEach((global, index) =>
    fields.push({
      kind: "global",
      value: {
        name: module.names?.globals?.[index],
        exports: [],
        type: global.type,
        init: body(global.init),
      },
    }),
  );
  module.tables.forEach((table, index) =>
    fields.push({
      kind: "table",
      value: {
        name: module.names?.tables?.[index],
        exports: [],
        storage: { type: table.type, limits: { min: table.limits.min, max: table.limits.max } },
      },
    }),
  );
  if (module.memory !== undefined) {
    if (module.memory.limits.shared)
      throw new UnsupportedTextError("shared memory text printing is not implemented");
    fields.push({
      kind: "memory",
      value: {
        name: module.names?.memories?.[0],
        exports: [],
        limits: { min: module.memory.limits.min, max: module.memory.limits.max },
      },
    });
  }
  if (module.start !== undefined) fields.push({ kind: "start", value: module.start });
  return { name: module.names?.module, fields };
}
