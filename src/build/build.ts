import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseModule, type ESTree } from "meriyah";
import type * as Dependency from "../dependency.ts";
import { isCreated, type Import } from "../export.ts";
import { builtinModule, constantModule } from "../js-string.ts";
import { Module as BinaryModule } from "../module-binable.ts";
import { analyzeScopes, contains, freeReferences, type Scopes } from "./scopes.ts";
import { entryTypes, exportLocals, exportTypes, isBindingName, isIdentifier } from "./types.ts";

export { build, type BuildOutput };

/**
 * The built files. With async exports, the entry module wraps them with `WebAssembly.promising`, and
 * JS imports the entry module instead of the Wasm module.
 */
type BuildOutput = {
  wasm: string;
  types: string;
  host?: string;
  entry?: string;
  entryTypes?: string;
  /** With JS string builtins, a polyfill for bundlers, which map `wasm:js-string` to it. */
  jsStringPolyfill?: string;
};

/** wasmati's own sources, which built code must not depend on. */
const wasmatiRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * JS string builtins come from the engine, or from a polyfill that bundlers map their module to.
 * String constants become exports of the host module, which bundlers can resolve.
 */
const polyfillFile = "js-string.js";

/** The parts of a wasmati module that the build needs. */
type BuildableModule = {
  module: BinaryModule;
  importMap: WebAssembly.Imports;
  asyncExports?: string[];
  importDependencies?: Dependency.AnyImport[];
};

/**
 * Build a file that default-exports a wasmati module into `<name>.wasm`, which JS imports directly
 * through the ESM integration of Wasm, and `<name>.d.wasm.ts` with its export types. Imports whose
 * values are given inline become exports of a generated `<name>.host.js`, extracted from the source
 * file; imports with an explicit module path keep it.
 */
async function build(input: string, { outDir }: { outDir?: string } = {}): Promise<BuildOutput> {
  const path = resolve(input);
  const out = resolve(outDir ?? dirname(path));
  const name = basename(path, extname(path));
  const entry = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const others = Object.keys(entry).filter((key) => key !== "default");
  if (others.length > 0)
    throw Error(
      `${basename(path)} exports ${others.join(", ")}; a built file may only export its Module, as default. Move shared code to another module.`,
    );
  const module = entry.default as BuildableModule | undefined;
  if (typeof module?.module?.imports !== "object")
    throw Error(`${basename(path)} must default-export a wasmati Module`);

  await mkdir(out, { recursive: true });
  const source = new Source(path, await readFile(path, "utf8"));
  await source.loadImports();
  const host = new HostModule(source, out);
  const hostPath = `./${name}.host.js`;
  const imports: Import[] = [];
  for (const [i, imported] of module.module.imports.entries()) {
    const dependency = module.importDependencies?.[i];
    const value = module.importMap[imported.module]?.[imported.name];
    if (imported.module === constantModule) {
      imports.push({ ...imported, module: hostPath, name: host.addString(imported.name) });
      continue;
    }
    if (
      imported.module === builtinModule ||
      dependency === undefined ||
      dependency.module !== undefined
    ) {
      await checkSpecifier(imported, value, dependency, out);
      imports.push(imported);
      continue;
    }
    const field = host.add(imported, dependency, describe(imported, dependency));
    imports.push({ ...imported, module: hostPath, name: field });
  }

  const wasm = join(out, `${name}.wasm`);
  const types = join(out, `${name}.d.wasm.ts`);
  const built = { ...module.module, imports };
  await writeFile(wasm, Uint8Array.from(BinaryModule.toBytes(built)));
  await writeFile(types, exportTypes(built));
  const output: BuildOutput = { wasm, types };
  if (!host.isEmpty) {
    output.host = join(out, `${name}.host.js`);
    await writeFile(output.host, host.emit());
  }
  if (imports.some((imported) => imported.module === builtinModule)) {
    output.jsStringPolyfill = join(out, polyfillFile);
    await writeFile(output.jsStringPolyfill, await polyfill());
  }
  const asyncExports = module.asyncExports ?? [];
  if (asyncExports.length > 0) {
    output.entry = join(out, `${name}.js`);
    output.entryTypes = join(out, `${name}.d.ts`);
    await writeFile(output.entry, entryModule(built, asyncExports, `./${name}.wasm`));
    await writeFile(output.entryTypes, entryTypes(built, asyncExports, `./${name}.wasm`));
  }
  return output;
}

/** The JS string polyfill, without types: wasmati ships it as TypeScript source, or compiled. */
async function polyfill() {
  const extension = extname(fileURLToPath(import.meta.url));
  const path = fileURLToPath(new URL(`../js-string-polyfill${extension}`, import.meta.url));
  const source = new Source(path, await readFile(path, "utf8"));
  return [
    "// Generated by wasmati build: JS string builtins, for bundlers that map wasm:js-string here.",
    source.text(source.program),
  ].join("\n");
}

/** A JS module that re-exports the Wasm module's exports, with async exports wrapped. */
function entryModule(module: BinaryModule, asyncExports: string[], wasm: string) {
  const locals = exportLocals(module.exports.map(({ name }) => name));
  const exports = module.exports.map(({ name }, i) => ({
    name,
    exported: isIdentifier(name) ? name : JSON.stringify(name),
    local: locals[i],
  }));
  // The namespace of the Wasm module takes a name that no export uses.
  let namespace = "wasm";
  while (exports.some(({ local }) => local === namespace)) namespace = `${namespace}_`;
  const lines = [
    "// Generated by wasmati build: async exports return promises (JS Promise Integration).",
    `import * as ${namespace} from ${JSON.stringify(wasm)};`,
  ];
  for (const { name, exported, local } of exports) {
    if (!asyncExports.includes(name)) {
      lines.push(`export { ${exported} } from ${JSON.stringify(wasm)};`);
      continue;
    }
    lines.push(`const ${local} = WebAssembly.promising(${namespace}[${JSON.stringify(name)}]);`);
    lines.push(local === name ? `export { ${local} };` : `export { ${local} as ${exported} };`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Load modules as a module in `directory` would import them: ESM resolves relative specifiers and
 * packages from the importing module. A temporary module there imports them.
 */
async function importFrom(directory: string, specifier: string): Promise<Record<string, unknown>> {
  const importer = join(directory, `.wasmati-import-${process.pid}-${importers++}.mjs`);
  await writeFile(importer, "export default (specifier) => import(specifier);\n");
  try {
    const { default: load } = await import(pathToFileURL(importer).href);
    return await load(specifier);
  } finally {
    await rm(importer, { force: true });
  }
}
let importers = 0;

/** How an import is called in errors: by its debug name, or by its module and field. */
function describe(imported: Import, dependency: Dependency.AnyImport) {
  const name = debugName(dependency);
  return name !== undefined ? `"${name}"` : `"${imported.module}" "${imported.name}"`;
}

function debugName(dependency: Dependency.AnyImport) {
  return dependency.kind === "importFunction" ? dependency.name : undefined;
}

/**
 * An explicit import path must lead, from the built file, to the value that the module imports
 * during development. Async imports must be exported as `WebAssembly.Suspending` objects.
 */
async function checkSpecifier(
  imported: Import,
  value: unknown,
  dependency: Dependency.AnyImport | undefined,
  out: string,
) {
  if (imported.module === builtinModule || dependency === undefined) return;
  const specifier = imported.module;
  let namespace: Record<string, unknown>;
  try {
    namespace = await importFrom(out, specifier);
  } catch (error) {
    throw Error(
      `import "${specifier}" "${imported.name}" cannot be loaded from the built file: ${error}`,
    );
  }
  const actual = namespace[imported.name];
  if (dependency.kind === "importFunction" && dependency.async) {
    if (!(actual instanceof WebAssembly.Suspending))
      throw Error(
        `async import "${specifier}" "${imported.name}" must be exported as new WebAssembly.Suspending(...)`,
      );
    return;
  }
  if (actual !== value)
    throw Error(
      `import "${specifier}" "${imported.name}": the module's export is not the value imported during development`,
    );
}

/** The source file, without types, with its scopes. Offsets of the TS source are preserved. */
class Source {
  readonly path: string;
  readonly ts: string;
  readonly js: string;
  readonly program: ESTree.Program;
  readonly scopes: Scopes;
  readonly directory: string;

  constructor(path: string, source: string) {
    this.path = path;
    this.directory = dirname(path);
    this.ts = source;
    this.js = path.endsWith(".ts") || path.endsWith(".mts") ? stripTypeScriptTypes(source) : source;
    this.program = parseModule(this.js, { ranges: true, next: true });
    this.scopes = analyzeScopes(this.program);
  }

  /**
   * The code of a node, without types: type stripping turns types into spaces, which are dropped
   * where the TypeScript source had other characters.
   */
  text(node: ESTree.Node) {
    let text = "";
    for (let i = node.start!; i < node.end!;) {
      if (this.js[i] !== " ") text += this.js[i++];
      else {
        // In a run of spaces with stripped types, keep the spaces around the types only.
        let end = i;
        while (end < node.end! && this.js[end] === " ") end++;
        const run = this.ts.slice(i, end);
        const first = run.search(/\S/);
        if (first === -1) text += run;
        else text += run.slice(0, first) + run.slice(run.trimEnd().length);
        i = end;
      }
    }
    return text;
  }

  /** The name of the top-level constant whose initializer contains a node, if any. */
  declaredName(node: ESTree.Node): string | undefined {
    for (const statement of this.program.body) {
      if (statement.type !== "VariableDeclaration" || !contains(statement, node)) continue;
      for (const { id, init } of statement.declarations)
        if (init && contains(init, node) && id.type === "Identifier") return id.name;
    }
    return undefined;
  }

  /** Function nodes whose source is the given function's source. */
  functions(code: string): ESTree.Node[] {
    const nodes: ESTree.Node[] = [];
    for (let at = this.js.indexOf(code); at !== -1; at = this.js.indexOf(code, at + 1)) {
      const node = this.nodeAt(at, at + code.length);
      if (node !== undefined) nodes.push(node);
    }
    return nodes;
  }

  private nodeAt(start: number, end: number): ESTree.Node | undefined {
    let found: ESTree.Node | undefined;
    const search = (node: ESTree.Node) => {
      if (node.start! > start || node.end! < end) return;
      if (
        node.start === start &&
        node.end === end &&
        (node.type === "ArrowFunctionExpression" ||
          node.type === "FunctionExpression" ||
          node.type === "FunctionDeclaration")
      )
        found = node;
      for (const value of Object.values(node))
        for (const item of Array.isArray(value) ? value : [value])
          if (item !== null && typeof item === "object" && typeof item.type === "string")
            search(item);
    };
    search(this.program);
    return found;
  }

  /**
   * Functions passed as values to `importFunc`, which stores them without calling them while the
   * module is built. The callee must be wasmati's `importFunc`, as the source file binds it.
   */
  importFuncValues(): Set<ESTree.Node> {
    const { module, references } = this.scopes;
    const declarationOf = new Map(references.map((r) => [r.node as ESTree.Node, r.declaration]));
    // Local names of importFunc, and of wasmati namespaces, from the source file's imports.
    const direct = new Set<string>();
    const namespaces = new Set<string>();
    for (const statement of this.program.body) {
      if (statement.type !== "ImportDeclaration" || !this.importsWasmati(statement)) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
        else if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier" &&
          specifier.imported.name === "importFunc"
        )
          direct.add(specifier.local.name);
      }
    }
    const atModule = (node: ESTree.Identifier) => declarationOf.get(node) === module;
    const isImportFunc = (callee: ESTree.Node) =>
      (callee.type === "Identifier" && direct.has(callee.name) && atModule(callee)) ||
      (callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name) &&
        atModule(callee.object) &&
        callee.property.type === "Identifier" &&
        callee.property.name === "importFunc");
    const nodes = new Set<ESTree.Node>();
    const visit = (node: ESTree.Node) => {
      if (node.type === "CallExpression" && isImportFunc(node.callee)) {
        const value = node.arguments[1];
        if (value?.type === "Identifier") nodes.add(value);
      }
      for (const value of Object.values(node))
        for (const item of Array.isArray(value) ? value : [value])
          if (item !== null && typeof item === "object" && typeof item.type === "string")
            visit(item);
    };
    visit(this.program);
    return nodes;
  }

  /** Namespaces of the modules that the source file imports, other than wasmati, by specifier. */
  readonly namespaces = new Map<string, Record<string, unknown>>();

  async loadImports() {
    for (const statement of this.program.body) {
      if (statement.type !== "ImportDeclaration" || this.importsWasmati(statement)) continue;
      const specifier = String(statement.source.value);
      // The source file already loaded these modules, so this returns the same namespaces.
      this.namespaces.set(specifier, await importFrom(this.directory, specifier));
    }
  }

  /** A specifier as a URL to import, and as a file path where it is one. */
  resolve(specifier: string): { url: string; path?: string } {
    if (specifier.startsWith("file:")) return { url: specifier, path: fileURLToPath(specifier) };
    if (!specifier.startsWith(".") && !isAbsolute(specifier)) return { url: specifier };
    const path = resolve(this.directory, specifier);
    return { url: pathToFileURL(path).href, path };
  }

  /** Whether an import declaration imports wasmati, which built code must not depend on. */
  importsWasmati(node: ESTree.ImportDeclaration) {
    const specifier = String(node.source.value);
    if (specifier === "wasmati" || specifier.startsWith("wasmati/")) return true;
    const { path } = this.resolve(specifier);
    return path !== undefined && !relative(wasmatiRoot, path).startsWith("..");
  }
}

/** A JS module of import values: extracted declarations and closures, and recreated objects. */
class HostModule {
  private statements = new Set<ESTree.Node>();
  private reexports: string[] = [];
  /** Values as constants, and exports of bindings, by field; local names are chosen on emit. */
  private constants: { field: string; code: string }[] = [];
  private exports: { local: string; field: string }[] = [];
  private names = new Set<string>();
  /** Extracted code, which may assign top-level variables. */
  private extracted: ESTree.Node[] = [];
  /**
   * Values already exported, by their field, so that a value imported twice is one export. A function
   * imported as async is a different value, its `WebAssembly.Suspending` wrapper.
   */
  private values = new Map<unknown, string>();
  private asyncValues = new Map<unknown, string>();

  private source: Source;
  private out: string;

  constructor(source: Source, out: string) {
    this.source = source;
    this.out = out;
  }

  get isEmpty() {
    return this.exports.length + this.constants.length + this.reexports.length === 0;
  }

  /** Export an import's value, and return its field. */
  add(imported: Import, dependency: Dependency.AnyImport, label: string): string {
    const values =
      dependency.kind === "importFunction" && dependency.async ? this.asyncValues : this.values;
    const known = values.get(dependency.value);
    if (known !== undefined) return known;
    // Functions are named after the variable of their import, like `const log = importFunc(...)`.
    const declared =
      dependency.kind === "importFunction"
        ? this.source
            .functions(Function.prototype.toString.call(dependency.value))
            .map((node) => this.source.declaredName(node))[0]
        : undefined;
    const field = this.name(debugName(dependency) ?? declared ?? imported.name);
    values.set(dependency.value, field);
    if (dependency.kind === "importFunction") this.function(field, dependency, label);
    else this.constant(field, this.recreate(imported, dependency, label));
    return field;
  }

  /** Export a string constant, and return its field. */
  addString(value: string): string {
    const key = `string ${value}`;
    const known = this.values.get(key);
    if (known !== undefined) return known;
    const field = this.name(isIdentifier(value) ? value : "string");
    this.values.set(key, field);
    this.constant(field, JSON.stringify(value));
    return field;
  }

  private constant(field: string, code: string) {
    this.constants.push({ field, code });
  }

  emit(): string {
    this.checkBuildTimeUses();
    const statements = [...this.statements]
      .sort((a, b) => a.start! - b.start!)
      .map((statement) => this.statement(statement));
    // Constants take local names that no copied declaration uses.
    const declared = new Set(
      [...this.source.scopes.module.declarations].flatMap(([name, statement]) =>
        this.statements.has(statement) ? [name] : [],
      ),
    );
    const constants = this.constants.map(({ field, code }) => {
      let local = field;
      while (declared.has(local)) local = `${local}_`;
      return { local, field, code };
    });
    const exports = [...this.exports, ...constants].map(({ local, field }) =>
      local === field ? field : `${local} as ${field}`,
    );
    return [
      "// Generated by wasmati build: the values that the Wasm module imports.",
      ...statements,
      ...constants.map(({ local, code }) => `const ${local} = ${code};`),
      ...(exports.length === 0 ? [] : [`export { ${exports.join(", ")} };`]),
      ...this.reexports,
      "",
    ].join("\n");
  }

  /** A unique export name, from the import's debug name where it is an identifier. */
  private name(name: string) {
    const base = isBindingName(name) ? name : "value";
    let unique = base;
    for (let i = 1; this.names.has(unique); i++) unique = `${base}${i}`;
    this.names.add(unique);
    return unique;
  }

  private function(field: string, dependency: Dependency.ImportFunc, label: string) {
    const run = dependency.value;
    const wrap = (code: string) =>
      dependency.async ? `new WebAssembly.Suspending(${code})` : code;
    const code = Function.prototype.toString.call(run);
    if (code.endsWith("{ [native code] }"))
      throw Error(
        `import ${label} is a built-in or bound function, which cannot be extracted; wrap it in a function`,
      );
    // A function from an imported module is that module's, even if the source has the same code.
    const reexport = this.imported(run);
    const nodes = reexport === undefined ? this.source.functions(code) : [];
    if (nodes.length === 0) {
      if (reexport === undefined)
        throw Error(
          `the function of import ${label} is neither defined in ${basename(this.source.path)} nor imported by it`,
        );
      if (dependency.async)
        throw Error(
          `async import ${label} is imported from another module; define the async function in ${basename(this.source.path)}, or export new WebAssembly.Suspending(...) and import it by module path`,
        );
      this.reexports.push(
        `export { ${reexport.name === field ? field : `${reexport.name} as ${field}`} } from ${JSON.stringify(reexport.specifier)};`,
      );
      return;
    }
    // Identical code in several places is extracted once, if it means the same everywhere.
    const node = nodes[0];
    for (const other of nodes) this.checkClosure(other, label);
    const declaration = this.topLevelDeclaration(node);
    if (declaration === undefined) {
      this.extract(node);
      // The other copies are the same code, whose uses of declarations are also extracted.
      this.extracted.push(...nodes.slice(1));
      this.constant(field, wrap(this.source.text(node)));
    } else {
      this.include(declaration.statement);
      if (dependency.async) this.constant(field, wrap(declaration.name));
      else this.exports.push({ local: declaration.name, field });
    }
  }

  /** A closure may use globals and top-level bindings, not variables of enclosing functions. */
  private checkClosure(node: ESTree.Node, label: string) {
    for (const reference of freeReferences(this.source.scopes, node)) {
      const scope = reference.declaration;
      if (scope === undefined || scope === this.source.scopes.module) continue;
      const what =
        reference.name === "this" || reference.name === "arguments"
          ? `${reference.name} of an enclosing function`
          : `"${reference.name}", a variable of an enclosing function`;
      throw Error(
        `the function of import ${label} uses ${what}, which only exists while the module is built. Use top-level declarations instead.`,
      );
    }
  }

  /** A top-level function declaration, or a top-level `const name = function`. */
  private topLevelDeclaration(
    node: ESTree.Node,
  ): { statement: ESTree.Node; name: string } | undefined {
    for (const statement of this.source.program.body) {
      if (statement === node && node.type === "FunctionDeclaration" && node.id)
        return { statement, name: node.id.name };
      if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
      for (const declarator of statement.declarations)
        if (declarator.init === node && declarator.id.type === "Identifier")
          return { statement, name: declarator.id.name };
    }
    return undefined;
  }

  /** Extract code, with the top-level statements it uses. */
  private extract(node: ESTree.Node) {
    this.extracted.push(node);
    for (const reference of freeReferences(this.source.scopes, node)) {
      if (reference.declaration !== this.source.scopes.module) continue;
      this.include(this.source.scopes.module.declarations.get(reference.name)!);
    }
  }

  private include(statement: ESTree.Node) {
    if (this.statements.has(statement)) return;
    if (statement.type === "ImportDeclaration" && this.source.importsWasmati(statement))
      throw Error(
        `import values cannot use wasmati at runtime, but they use ${statement.specifiers.map((s) => s.local.name).join(", ")} from "${statement.source.value}"`,
      );
    if (statement.type.startsWith("Export"))
      throw Error("import values cannot use the module's own exports");
    this.statements.add(statement);
    if (statement.type !== "ImportDeclaration") this.extract(statement);
  }

  /** Top-level variables of extracted code must not be assigned by code that runs during the build. */
  /**
   * Copied declarations start from their initial values. Code that runs while the module is built must
   * not use them: it could change them, by assignment, through their properties or by calling them,
   * and the built module would not have these changes. Imported modules are shared, not copied.
   */
  private checkBuildTimeUses() {
    const extracted = [...this.extracted, ...this.statements];
    const { module, references } = this.source.scopes;
    const passedToWasmati = this.source.importFuncValues();
    for (const reference of references) {
      if (reference.declaration !== module || passedToWasmati.has(reference.node)) continue;
      const statement = module.declarations.get(reference.name);
      if (statement === undefined || statement.type === "ImportDeclaration") continue;
      if (!this.statements.has(statement)) continue;
      if (!extracted.some((node) => contains(node, reference.node)))
        throw Error(
          `"${reference.name}" is used by import values, and by code that runs while the module is built, whose effects the built module would not have. Move that code into the import values, or the shared state into another module.`,
        );
    }
  }

  /** A copied statement; import paths are relative to the built file. */
  private statement(statement: ESTree.Node): string {
    if (statement.type !== "ImportDeclaration") return this.source.text(statement).trim();
    const specifier = this.specifier(String(statement.source.value));
    const code = this.source.text(statement);
    const quoted = this.source.text(statement.source);
    return code.replace(quoted, JSON.stringify(specifier)).trim();
  }

  private specifier(specifier: string) {
    const { path } = this.source.resolve(specifier);
    if (path === undefined) return specifier;
    const relativePath = relative(this.out, path).replaceAll("\\", "/");
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  }

  /** A function that the source file imports, by the module and name that export it. */
  private imported(run: Function): { specifier: string; name: string } | undefined {
    for (const [specifier, namespace] of this.source.namespaces)
      for (const [name, value] of Object.entries(namespace))
        if (value === run) return { specifier: this.specifier(specifier), name };
    return undefined;
  }

  /** Recreate an object that wasmati created for an import, from its type and current value. */
  private recreate(imported: Import, dependency: Dependency.AnyImport, label: string): string {
    const value = dependency.value as object;
    if (!isCreated(value))
      throw Error(
        `import ${label} is a ${value.constructor.name} created outside wasmati, which may be shared; give it an explicit module path`,
      );
    const { description } = imported;
    if (description.kind === "memory") {
      // Data segments initialize memories when instantiated; contents written while building are lost.
      const bytes = new Uint8Array((value as WebAssembly.Memory).buffer);
      if (bytes.some((byte) => byte !== 0))
        throw Error(
          `import ${label} is a memory with contents written while the module is built, which the built module would not have. Initialize it with data segments instead.`,
        );
      const { max, shared, address } = description.value.limits;
      const size = (n: number | bigint) => (address === "i64" ? `${n}n` : `${n}`);
      // A memory may have grown while the module was built.
      const pages = bytes.length / 65536;
      const options = [
        `initial: ${size(pages)}`,
        ...(max === undefined ? [] : [`maximum: ${size(max)}`]),
        ...(shared ? ["shared: true"] : []),
        ...(address === "i64" ? [`address: "i64"`] : []),
      ];
      return `new WebAssembly.Memory({ ${options.join(", ")} })`;
    }
    if (description.kind === "global") {
      const global = value as WebAssembly.Global;
      const type = description.value.value;
      const literal = (v: unknown) =>
        typeof v === "bigint" ? `${v}n` : Object.is(v, -0) ? "-0" : v === null ? "null" : String(v);
      const jsType = type === "funcref" ? "anyfunc" : type;
      if (typeof global.value === "object" && global.value !== null)
        throw Error(`import ${label} is a global holding an object, which cannot be recreated`);
      const initial =
        typeof global.value === "string" ? JSON.stringify(global.value) : literal(global.value);
      return `new WebAssembly.Global({ value: ${JSON.stringify(jsType)}, mutable: ${description.value.mutable} }, ${initial})`;
    }
    if (description.kind === "tag" && dependency.kind === "importTag") {
      const parameters = dependency.type.args.map((t) => (t === "funcref" ? "anyfunc" : t));
      if (parameters.some((t) => typeof t === "object"))
        throw Error(`import ${label} is a tag with typed references, which cannot be recreated`);
      return `new WebAssembly.Tag({ parameters: ${JSON.stringify(parameters)} })`;
    }
    throw Error(`import ${label} cannot be recreated; give it an explicit module path`);
  }
}
