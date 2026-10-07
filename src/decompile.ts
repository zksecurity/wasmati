import * as api from "./index.ts";
import type { Module as DecodedModule } from "./module-binable.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import {
  functionTypeEquals,
  type FunctionType,
  type GlobalType,
  refType,
  typeEquals,
  type ValueType,
} from "./types.ts";
import type { F32, F64 } from "./immediate.ts";

export { decompile, decompileModule };

/**
 * Decode Wasm using the existing Binable codecs and emit editable, stack-style wasmati TypeScript.
 * The default export is a module factory accepting the original WebAssembly import object.
 * importPath chooses where the generated source imports wasmati (default: the published package).
 * Unsupported builder constructs throw rather than embedding raw instructions or input bytes.
 */
function decompile(bytes: Uint8Array, { importPath = "wasmati" } = {}): string {
  const module = api.Module.fromBytes(bytes).module;
  return decompileModule(module, { importPath });
}

/** Emit from the shared module representation, without encoding and decoding it through Wasm first. */
function decompileModule(module: DecodedModule, { importPath = "wasmati" } = {}): string {
  return new Source(module, importPath).emit();
}

type Binding = { key: string; variable: string };

// Allocation is deterministic; debug names need not be legal or unique TS identifiers.
class Names {
  private used: Set<string>;

  constructor(declarations: string[] = []) {
    this.used = new Set([
      ...Object.keys(api),
      ...declarations,
      ..."eval arguments await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield async abstract as asserts any boolean constructor declare get infer is keyof module namespace never number object of readonly require set string symbol type undefined unique unknown from global using NaN Infinity imports createModule args locals".split(
        " ",
      ),
    ]);
  }

  take(name: string): string {
    const base = name.replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^(?=[0-9])/, "_") || "unnamed";
    let candidate = base;
    for (let n = 1; this.used.has(candidate); n++) candidate = `${base}_${n}`;
    this.used.add(candidate);
    return candidate;
  }
}

class Source {
  private names = new Names();
  private functions: string[] = [];
  private globals: string[] = [];
  private tables: string[] = [];
  private memories: string[] = [];
  private datas: string[] = [];
  private elems: string[] = [];
  private parameters: Binding[][] = [];
  private locals: Binding[][] = [];
  private usedApi = new Set(["Module"]);
  private lines: string[] = [];
  private dependencies: string[] = [];

  private module: DecodedModule;
  private importPath: string;

  constructor(module: DecodedModule, importPath: string) {
    this.module = module;
    this.importPath = importPath;
  }

  private use(name: string): string {
    this.usedApi.add(name.split(".")[0]);
    return name;
  }

  private line(text: string, indent = 1) {
    this.lines.push(`${"  ".repeat(indent)}${text}`);
  }

  private name(kind: "functions" | "globals" | "tables" | "memories", index: number) {
    const exportKind = {
      functions: "function",
      globals: "global",
      tables: "table",
      memories: "memory",
    }[kind];
    return (
      this.module.names?.[kind]?.[index] ??
      this.module.exports.find(
        (e) => e.description.kind === exportKind && e.description.value === index,
      )?.name ??
      `${exportKind}${index}`
    );
  }

  private bindings(index: number, types: ValueType[]): Binding[] {
    const keys = new Set<string>();
    const variables = new Names([
      ...this.functions,
      ...this.globals,
      ...this.tables,
      ...this.memories,
      ...this.datas,
      ...this.elems,
    ]);
    return types.map((_, i) => {
      const base = this.module.names?.locals?.[index]?.[i] ?? `local${i}`;
      let key = base;
      for (let n = 1; keys.has(key); n++) key = `${base}_${n}`;
      keys.add(key);
      return { key, variable: variables.take(key) };
    });
  }

  private signature(
    index: number,
    type: FunctionType,
    locals: ValueType[] = [],
    path?: { module: string; field: string },
  ): string {
    const bindings = this.bindings(index, [...type.args, ...locals]);
    const parameters = (this.parameters[index] = bindings.slice(0, type.args.length));
    this.locals[index] = bindings.slice(type.args.length);
    const input = parameters
      .map((b, i) => `{ ${property(b.key)}: ${this.valueType(type.args[i])} }`)
      .join(", ");
    const localEntries = this.locals[index]
      .map((b, i) => `${property(b.key)}: ${this.valueType(locals[i])}`)
      .join(", ");
    const name = this.module.names?.functions?.[index];
    return `{ ${path === undefined ? "" : `module: ${literal(path.module)}, field: ${literal(path.field)}, `}${name === undefined ? "" : `name: ${literal(name)}, `}in: [${input}], ${locals.length ? `locals: { ${localEntries} }, ` : ""}out: [${type.results.map((t) => this.valueType(t)).join(", ")}] }`;
  }

  emit(): string {
    // Allocate all function identities before globals/segments can reference them.
    const importedFunctions = this.module.imports.filter(
      (i) => i.description.kind === "function",
    ).length;
    for (let i = 0; i < importedFunctions + this.module.funcs.length; i++) {
      this.functions.push(this.names.take(this.name("functions", i)));
    }
    for (const [kind, refs] of [
      ["global", this.globals],
      ["table", this.tables],
      ["memory", this.memories],
    ] as const) {
      const count =
        this.module.imports.filter((i) => i.description.kind === kind).length +
        (kind === "global"
          ? this.module.globals.length
          : kind === "table"
            ? this.module.tables.length
            : this.module.memories.length);
      const map = { global: "globals", table: "tables", memory: "memories" } as const;
      for (let i = 0; i < count; i++) refs.push(this.names.take(this.name(map[kind], i)));
    }
    this.datas = this.module.datas.map((_, i) => this.names.take(`data${i}`));
    this.elems = this.module.elems.map((_, i) => this.names.take(`elem${i}`));
    const nextIndex = { function: 0, global: 0, table: 0, memory: 0 };
    for (const imp of this.module.imports) {
      const { kind, value } = imp.description;
      const index = nextIndex[kind]++;
      const path = { module: imp.module, field: imp.name };
      const imported = `imports[${literal(imp.module)}]?.[${literal(imp.name)}]`;
      let variable: string;
      let expression: string;
      switch (kind) {
        case "function": {
          variable = this.functions[index];
          const type = this.module.types[value as number];
          expression = `${this.use("importFunc")}(${this.signature(index, type, [], path)}, ${imported} as ${jsSignature(type)})`;
          break;
        }
        case "global": {
          variable = this.globals[index];
          const type = value as Extract<typeof imp.description, { kind: "global" }>["value"];
          expression = `${this.use("importGlobal")}(${this.valueType(type.value)}, ${imported} as WebAssembly.Global, ${literal({ mutable: type.mutable, ...path })})`;
          break;
        }
        case "memory": {
          variable = this.memories[index];
          const type = value as Extract<typeof imp.description, { kind: "memory" }>["value"];
          expression = `${this.use("importMemory")}(${literal({ ...type.limits, ...path })}, ${imported} as WebAssembly.Memory)`;
          break;
        }
        case "table": {
          variable = this.tables[index];
          const type = value as Extract<typeof imp.description, { kind: "table" }>["value"];
          expression = `${this.use("importTable")}({ type: ${this.valueType(type.type)}, ...${literal({ ...type.limits, ...path })} }, ${imported} as WebAssembly.Table)`;
          break;
        }
      }
      this.line(`const ${variable} = ${expression};`);
      this.dependencies.push(variable);
    }
    // Builders describe referenced types structurally, and add them before the types referring to them.
    this.module.types.forEach(({ args, results }, index) => {
      for (const type of [...args, ...results]) {
        if (typeof type !== "object" || typeof type.ref !== "number") continue;
        if (type.ref === index) throw Error("decompile: recursive types are not supported");
        if (type.ref > index)
          throw Error(`decompile: type ${index} refers to later type ${type.ref}`);
      }
    });
    for (const f of this.module.funcs) {
      // Builders derive type indices from signatures, so a mismatching index would silently be repaired.
      const declared = this.module.types[f.typeIdx];
      if (declared === undefined || !functionTypeEquals(declared, f.type))
        throw Error(`decompile: function ${f.funcIdx} does not have type ${f.typeIdx}`);
      this.line(
        `const ${this.functions[f.funcIdx]} = ${this.use("declareFunc")}(${this.signature(f.funcIdx, f.type, f.locals)});`,
      );
      this.dependencies.push(this.functions[f.funcIdx]);
    }
    for (const g of this.module.globals) {
      // Builders take a global's type from its initializer, unless it is declared.
      const initType = this.constantType(g.init);
      const declared =
        initType !== undefined && typeEquals(initType, g.type.value)
          ? ""
          : `, type: ${this.valueType(g.type.value)}`;
      const variable = this.globals[nextIndex.global++];
      this.line(
        `const ${variable} = ${this.use("global")}(${this.constant(g.init)}, { mutable: ${g.type.mutable}${declared} });`,
      );
      this.dependencies.push(variable);
    }
    for (const t of this.module.tables) {
      const variable = this.tables[nextIndex.table++];
      this.line(
        `const ${variable} = ${this.use("table")}({ type: ${this.valueType(t.type)}, ...${literal(t.limits)}${t.init === undefined ? "" : `, init: ${this.constant(t.init)}`} });`,
      );
      this.dependencies.push(variable);
    }
    for (const m of this.module.memories) {
      const variable = this.memories[nextIndex.memory++];
      this.line(`const ${variable} = ${this.use("memory")}(${literal(m.limits)});`);
      this.dependencies.push(variable);
    }
    for (const [index, d] of this.module.datas.entries()) {
      const variable = this.datas[index];
      const mode =
        typeof d.mode === "string"
          ? literal(d.mode)
          : `{ memory: ${this.reference(this.memories, d.mode.memory)}, offset: ${this.constant(d.mode.offset)} }`;
      this.line(`const ${variable} = ${this.use("data")}(${mode}, ${literal(d.init)});`);
      this.dependencies.push(variable);
    }
    for (const [index, e] of this.module.elems.entries()) {
      const variable = this.elems[index];
      const mode =
        typeof e.mode === "string"
          ? literal(e.mode)
          : `{ table: ${this.reference(this.tables, e.mode.table)}, offset: ${this.constant(e.mode.offset)} }`;
      this.line(
        `const ${variable} = ${this.use("elem")}({ type: ${this.valueType(e.type)}, mode: ${mode} }, [${e.init.map((init) => this.constant(init)).join(", ")}]);`,
      );
      this.dependencies.push(variable);
    }
    for (const f of this.module.funcs) {
      const destructure = (bindings: Binding[]) =>
        `{ ${bindings.map((b) => (b.key === b.variable ? b.key : `${literal(b.key)}: ${b.variable}`)).join(", ")} }`;
      const args = this.parameters[f.funcIdx];
      const locals = this.locals[f.funcIdx];
      const callback = locals.length
        ? `${destructure(args)}, ${destructure(locals)}`
        : args.length
          ? destructure(args)
          : "";
      this.line(`${this.functions[f.funcIdx]}.define((${callback}) => {`);
      this.instructions(
        f.body,
        [...this.parameters[f.funcIdx], ...this.locals[f.funcIdx]].map((b) => b.variable),
        2,
      );
      this.line("});");
    }
    // Unreferenced types also belong to the module, even if the builder deduplicates equal signatures.
    for (const type of this.module.types) {
      this.dependencies.push(`${this.use("Dependency")}.type(${this.functionType(type)})`);
    }
    const exports = this.module.exports.map((e) => {
      const refs = {
        function: this.functions,
        global: this.globals,
        table: this.tables,
        memory: this.memories,
      };
      const variable = this.reference(refs[e.description.kind], e.description.value);
      return { name: e.name, variable };
    });
    // Repeated names cannot be keys of the exports object, so they need export entries.
    const names = exports.map((e) => e.name);
    const repeated = new Set(names).size !== names.length;
    this.line("return Module({");
    if (this.module.names?.module !== undefined)
      this.line(`name: ${literal(this.module.names.module)},`, 2);
    if (repeated) {
      this.line("exports: {},", 2);
      const entries = exports.map(({ name, variable }) => `[${literal(name)}, ${variable}]`);
      this.line(`exportEntries: [${entries.join(", ")}],`, 2);
    } else {
      const properties = exports.map(({ name, variable }) =>
        name === variable ? variable : `${property(name)}: ${variable}`,
      );
      this.line(`exports: { ${properties.join(", ")} },`, 2);
    }
    if (this.module.start !== undefined)
      this.line(`start: ${this.reference(this.functions, this.module.start)},`, 2);
    this.line(`dependencies: [${this.dependencies.join(", ")}],`, 2);
    if (this.module.customSections?.length)
      this.line(`customSections: ${literal(this.module.customSections)},`, 2);
    this.line("});");
    return `import { ${[...this.usedApi].sort().join(", ")} } from ${literal(this.importPath)};\n\nexport default function createModule(imports: WebAssembly.Imports = {}) {\n${this.lines.join("\n")}\n}\n`;
  }

  /**
   * The memory argument of an instruction: none if the module has a single memory with 32-bit
   * addresses, which instructions use when they do not name a memory.
   */
  private memoryArgument(index = 0): string[] {
    const imported = this.module.imports.flatMap((i) =>
      i.description.kind === "memory" ? [i.description.value] : [],
    );
    const memories = [...imported, ...this.module.memories];
    if (memories.length === 1 && memories[0].limits.address !== "i64") return [];
    return [this.reference(this.memories, index)];
  }

  private reference(references: string[], index: number): string {
    const ref = references[index];
    if (ref === undefined) throw Error(`decompile: missing reference at index ${index}`);
    return ref;
  }

  private type(blockType: "empty" | ValueType | number): string {
    const type =
      blockType === "empty"
        ? { args: [], results: [] }
        : typeof blockType === "number"
          ? this.module.types[blockType]
          : { args: [], results: [blockType] };
    if (!type) throw Error(`decompile: missing block type ${blockType}`);
    return `{ in: [${type.args.map((t) => this.valueType(t)).join(", ")}], out: [${type.results.map((t) => this.valueType(t)).join(", ")}] }`;
  }

  /** A value type of the builder API: references to defined types describe their signature. */
  private valueType(type: ValueType): string {
    if (typeof type !== "object") return this.use(type);
    const heap = typeof type.ref === "number" ? this.type(type.ref) : literal(type.ref);
    return `${this.use("refType")}(${heap}${type.nullable ? ", { nullable: true }" : ""})`;
  }

  /** A function type as Dependency.type takes it, with value type literals. */
  private functionType({ args, results }: FunctionType): string {
    const literals = (types: ValueType[]) =>
      types
        .map((t) => (typeof t === "object" ? `${this.valueType(t)}.kind` : literal(t)))
        .join(", ");
    return `{ args: [${literals(args)}], results: [${literals(results)}] }`;
  }

  private constantType(expression: ResolvedInstruction[]): ValueType | undefined {
    if (expression.length === 0) return undefined;
    // The last instruction produces the value.
    const { name, immediate } = expression[expression.length - 1];
    if (name === "ref.null") return refType(immediate, true);
    if (name === "ref.func") return "funcref";
    if (name !== "global.get") return name.slice(0, name.indexOf(".")) as ValueType;
    const imported = this.module.imports.filter((i) => i.description.kind === "global");
    const global =
      immediate < imported.length
        ? (imported[immediate].description.value as GlobalType)
        : this.module.globals[immediate - imported.length]?.type;
    return global?.value;
  }

  /** A constant expression as nested Const calls: arithmetic takes the two values before it. */
  private constant(expression: ResolvedInstruction[]): string {
    if (expression.length === 0) throw Error("decompile: constant expression is empty");
    const values: string[] = [];
    for (const instruction of expression) {
      const arithmetic = instruction.name.match(/^(i32|i64)\.(add|sub|mul)$/);
      if (arithmetic === null) {
        values.push(this.constantInstruction(instruction));
        continue;
      }
      const [b, a] = [values.pop(), values.pop()];
      if (a === undefined || b === undefined)
        throw Error(`decompile: ${instruction.name} in a constant expression lacks operands`);
      values.push(`${this.use("Const")}.${arithmetic[1]}.${arithmetic[2]}(${a}, ${b})`);
    }
    if (values.length !== 1) throw Error("decompile: a constant expression must produce one value");
    return values[0];
  }

  private constantInstruction({ name, immediate }: ResolvedInstruction): string {
    switch (name) {
      case "i32.const":
      case "i64.const":
        return `${this.use("Const")}.${name.slice(0, 3)}(${literal(immediate)})`;
      case "f32.const":
      case "f64.const":
        return `${this.use("Const")}.${name.slice(0, 3)}(${floatLiteral(immediate)})`;
      case "v128.const":
        return `${this.use("Const")}.v128("i8x16", ${literal(immediate)})`;
      case "ref.func":
        return `${this.use("Const")}.refFunc(${this.reference(this.functions, immediate)})`;
      case "ref.null":
        return `${this.use("Const")}.refNull(${this.valueType(refType(immediate, true))})`;
      case "global.get":
        return `${this.use("Const")}.globalGet(${this.reference(this.globals, immediate)})`;
      default:
        throw Error(`decompile: unsupported constant instruction ${name}`);
    }
  }

  private instructions(body: ResolvedInstruction[], locals: string[], indent: number) {
    for (const { name, immediate: imm } of body) {
      if (name === "block" || name === "loop" || name === "if") {
        const op = this.use(name === "if" ? "control.if" : name);
        this.line(`${op}(${this.type(imm.blockType)}, () => {`, indent);
        this.instructions(
          name === "if" ? imm.instructions.if : imm.instructions,
          locals,
          indent + 1,
        );
        if (name === "if" && imm.instructions.else !== undefined) {
          this.line("}, () => {", indent);
          this.instructions(imm.instructions.else, locals, indent + 1);
        }
        this.line("});", indent);
        continue;
      }
      let op = name;
      let args: string[] = [];
      switch (name) {
        case "local.get":
        case "local.set":
        case "local.tee":
          args = [this.reference(locals, imm)];
          break;
        case "global.get":
        case "global.set":
          args = [this.reference(this.globals, imm)];
          break;
        case "call":
        case "ref.func":
          args = [this.reference(this.functions, imm)];
          break;
        case "call_indirect":
        case "return_call_indirect":
          args = [this.reference(this.tables, imm[1]), this.type(imm[0])];
          break;
        case "return_call":
          args = [this.reference(this.functions, imm)];
          break;
        case "call_ref":
        case "return_call_ref":
          args = [this.type(imm)];
          break;
        case "return":
          op = "control.return";
          break;
        case "br":
        case "br_if":
          args = [literal(imm)];
          break;
        case "br_table":
          args = [literal(imm.indices), literal(imm.defaultIndex)];
          break;
        case "ref.null":
          args = [this.valueType(refType(imm, true))];
          break;
        case "select_t":
          if (imm.length !== 1) throw Error("decompile: select requires exactly one result type");
          op = "select";
          args = [this.valueType(imm[0])];
          break;
        case "v128.const":
          args = [literal("i8x16"), literal(imm)];
          break;
        case "memory.size":
        case "memory.grow":
        case "memory.fill":
          args = this.memoryArgument(imm);
          break;
        case "memory.copy": {
          const [destination, source] = imm.map((i: number) => this.memoryArgument(i));
          args =
            destination.length === 0 && source.length === 0
              ? []
              : imm.map((i: number) => this.reference(this.memories, i));
          break;
        }
        case "memory.init":
          args = [this.reference(this.datas, imm[0]), ...this.memoryArgument(imm[1])];
          break;
        case "data.drop":
          args = [this.reference(this.datas, imm)];
          break;
        case "elem.drop":
          args = [this.reference(this.elems, imm)];
          break;
        case "table.init":
          args = [this.reference(this.tables, imm[1]), this.reference(this.elems, imm[0])];
          break;
        case "table.copy":
          args = imm.map((i: number) => this.reference(this.tables, i));
          break;
        case "table.get":
        case "table.set":
        case "table.size":
        case "table.grow":
        case "table.fill":
          args = [this.reference(this.tables, imm)];
          break;
        case "atomic.fence":
          break;
        case "f32.const":
        case "f64.const":
          args = [floatLiteral(imm)];
          break;
        default:
          if (imm !== undefined) {
            if (typeof imm === "object" && imm !== null && "memArg" in imm) {
              const [memory] = this.memoryArgument(imm.memArg.memory);
              args = [memarg(imm.memArg, memory), literal(imm.lane)];
            } else if (typeof imm === "object" && imm !== null && "align" in imm) {
              const [memory] = this.memoryArgument(imm.memory);
              args = [memarg(imm, memory)];
            } else args = [literal(imm)];
          }
      }
      // Most instruction names are already public API paths. Check instead of emitting broken source.
      let value: unknown = api;
      for (const part of op.split("."))
        value = (value as Record<string, unknown> | undefined)?.[part];
      if (typeof value !== "function") throw Error(`decompile: no builder for ${name}`);
      this.line(`${this.use(op)}(${args.join(", ")});`, indent);
    }
  }
}

function memarg(
  { offset, align }: { offset: number | bigint; align: number },
  memory?: string,
): string {
  // Binary alignment is an exponent; the public API takes an alignment in bytes.
  return `{ ${memory === undefined ? "" : `memory: ${memory}, `}offset: ${literal(offset)}, align: ${2 ** align} }`;
}

function property(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) && key !== "__proto__" ? key : `[${literal(key)}]`;
}

function literal(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
  }
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{ ${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${property(k)}: ${literal(v)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** NaNs keep their exact bits, written in hex so sign and payload stay readable. */
function floatLiteral(value: F32 | F64): string {
  if (typeof value === "number") return literal(value);
  return `{ bits: 0x${value.bits.toString(16)}${typeof value.bits === "bigint" ? "n" : ""} }`;
}

function jsSignature(type: FunctionType): string {
  const jsType = (type: ValueType) =>
    type === "i64"
      ? "bigint"
      : type === "funcref"
        ? "Function | null"
        : type === "externref" || typeof type === "object"
          ? "unknown"
          : type === "v128"
            ? "never"
            : "number";
  const result =
    type.results.length === 0
      ? "void"
      : type.results.length === 1
        ? jsType(type.results[0])
        : `[${type.results.map(jsType).join(", ")}]`;
  return `(${type.args.map((t, i) => `arg${i}: ${jsType(t)}`).join(", ")}) => ${result}`;
}
