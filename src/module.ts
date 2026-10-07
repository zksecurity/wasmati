import type {} from "./js-api.ts";
import * as Dependency from "./dependency.ts";
import { Export, Import } from "./export.ts";
import type { FinalizedFunc, JSFunction } from "./func.ts";
import { resolveInstruction, type ResolvedInstruction } from "./instruction/base.ts";
import { Module as BinableModule } from "./module-binable.ts";
import { Data, Elem, Global, Table } from "./memory-binable.ts";
import {
  FunctionType,
  functionTypeEquals,
  type HeapType,
  refType,
  type ValueType,
  type JSValue,
  Limits,
  MemoryType,
  funcref,
  TableType,
} from "./types.ts";
import { elemConstructor, memoryConstructor } from "./memory.ts";
import { parseWat } from "./text/wat.ts";
import { printWat } from "./text/print.ts";
import { jsStringBuiltins, usesJSStringBuiltins } from "./js-string.ts";
import type { AsyncExport } from "./export.ts";
import { TypeRegistry } from "./type-registry.ts";
import type { NameMap, NameSection } from "./name-section.ts";
import type { CustomSection } from "./module-binable.ts";

export { Module, type ModuleExport, type ModuleInstance };

type Module = ReturnType<typeof ModuleConstructor>;

/** Exports, of which functions may be async exports. */
type ExportInput = Dependency.Export | AsyncExport;

function ModuleConstructor<Exports extends Record<string, ExportInput>>({
  exports: inputExports,
  exportEntries = [],
  memory: inputMemory,
  start: inputStart,
  name,
  names,
  customSections,
  dependencies: inputDependencies = [],
  declareReferences = true,
}: {
  exports: Exports;
  /**
   * Further exports as ordered name-value pairs, after `exports`. Unlike in `exports`, names can repeat,
   * which makes the module invalid; the decompiler uses this to reproduce such modules faithfully.
   */
  exportEntries?: [name: string, value: ExportInput][];
  memory?: Limits | Dependency.AnyMemory;
  start?: Dependency.AnyFunc;
  name?: string;
  names?: NameSection;
  customSections?: CustomSection[];
  /** Include declarations even when exports and the start function do not reference them. */
  dependencies?: Dependency.t[];
  /**
   * Declare the functions that code references with `ref.func`, as Wasm requires, unless exports or
   * segments declare them. The decompiler turns this off to reproduce modules without it faithfully.
   */
  declareReferences?: boolean;
}) {
  // collect all dependencies (by kind)
  let dependencies = new Set<Dependency.t>();
  for (const dep of inputDependencies) pushDependency(dependencies, dep);
  let inputs: [string, ExportInput][] = [...Object.entries(inputExports), ...exportEntries];
  let allExports = inputs.map(([name, value]): [string, Dependency.Export] => [
    name,
    value.kind === "asyncExport" ? value.func : value,
  ]);
  let asyncExports = inputs.flatMap(([name, value]) =>
    value.kind === "asyncExport" ? [name] : [],
  );
  checkAsyncCalls(allExports, asyncExports, inputStart);
  for (let [, exp] of allExports) {
    pushDependency(dependencies, exp);
  }
  if (inputMemory !== undefined) {
    let memory = "kind" in inputMemory ? inputMemory : memoryConstructor(inputMemory);
    pushDependency(dependencies, memory);
  }
  if (inputStart !== undefined) {
    pushDependency(dependencies, inputStart);
  }
  let dependencyByKind: {
    [K in Dependency.t["kind"]]: (Dependency.t & { kind: K })[];
  } = Object.fromEntries(Dependency.dependencyKinds.map((key) => [key, []])) as any;
  for (let dep of dependencies) {
    (dependencyByKind[dep.kind] as Dependency.t[]).push(dep);
  }
  // Globals may read earlier globals, so they follow the globals they read.
  dependencyByKind.global = orderGlobals(dependencyByKind.global);
  let depToIndex = new Map<Dependency.t, number>();

  // process imports, along with types of imported functions
  let imports: Import[] = [];
  let importMap: WebAssembly.Imports = {};
  let registry = new TypeRegistry();
  // Types listed as dependencies come first, in order, so decompiled modules keep their type indices.
  for (let type of dependencyByKind.type) {
    depToIndex.set(type, registry.index(type));
  }

  dependencyByKind.importFunction.forEach((func, funcIdx) => {
    let typeIdx = registry.index(Dependency.typeOf(func));
    let description = { kind: "function" as const, value: typeIdx };
    depToIndex.set(func, funcIdx);
    let imp = addImport(func, description, funcIdx, importMap);
    imports.push(imp);
  });
  dependencyByKind.importGlobal.forEach((global, globalIdx) => {
    depToIndex.set(global, globalIdx);
    let description = { kind: "global" as const, value: global.type };
    let imp = addImport(global, description, globalIdx, importMap);
    imports.push(imp);
  });
  dependencyByKind.importTag.forEach((tag, tagIdx) => {
    depToIndex.set(tag, tagIdx);
    let description = { kind: "tag" as const, value: registry.index(Dependency.typeOf(tag)) };
    imports.push(addImport(tag, description, tagIdx, importMap));
  });
  dependencyByKind.importTable.forEach((table, tableIdx) => {
    depToIndex.set(table, tableIdx);
    let description = { kind: "table" as const, value: table.type };
    let imp = addImport(table, description, tableIdx, importMap);
    imports.push(imp);
  });
  dependencyByKind.importMemory.forEach((memory, memoryIdx) => {
    depToIndex.set(memory, memoryIdx);
    let description = { kind: "memory" as const, value: memory.type };
    let imp = addImport(memory, description, memoryIdx, importMap);
    imports.push(imp);
  });

  // In the order of the imports.
  let importDependencies: Dependency.AnyImport[] = [
    ...dependencyByKind.importFunction,
    ...dependencyByKind.importGlobal,
    ...dependencyByKind.importTag,
    ...dependencyByKind.importTable,
    ...dependencyByKind.importMemory,
  ];

  // index funcs + their types
  let funcs0: (Dependency.Func & { typeIdx: number; funcIdx: number })[] = [];
  let nImportFuncs = dependencyByKind.importFunction.length;
  for (let func of dependencyByKind.function) {
    if (!func.defined) throw Error(`Module: function ${func.name ?? "<unnamed>"} is not defined`);
    let typeIdx = registry.index(Dependency.typeOf(func));
    let funcIdx = nImportFuncs + funcs0.length;
    funcs0.push({ ...func, typeIdx, funcIdx });
    depToIndex.set(func, funcIdx);
  }

  // index tags
  let nImportTags = dependencyByKind.importTag.length;
  dependencyByKind.tag.forEach((tag, tagIdx) => depToIndex.set(tag, tagIdx + nImportTags));
  let tags = dependencyByKind.tag.map((tag) => registry.index(Dependency.typeOf(tag)));
  // index globals
  let nImportGlobals = dependencyByKind.importGlobal.length;
  dependencyByKind.global.forEach((global, globalIdx) =>
    depToIndex.set(global, globalIdx + nImportGlobals),
  );
  // index tables
  let nImportTables = dependencyByKind.importTable.length;
  dependencyByKind.table.forEach((table, tableIdx) =>
    depToIndex.set(table, tableIdx + nImportTables),
  );
  // Functions that code references must be declared outside of code; a declarative segment declares the rest.
  let declared = new Set<Dependency.t>(allExports.map(([, exp]) => exp));
  for (let dep of [...dependencyByKind.elem, ...dependencyByKind.global, ...dependencyByKind.table])
    dep.deps.forEach((d) => declared.add(d));
  let undeclared = new Set(
    dependencyByKind.function
      .flatMap((func) => func.deps)
      .flatMap((dep) => (dep.kind === "hasRefTo" && !declared.has(dep.value) ? [dep.value] : [])),
  );
  if (declareReferences && undeclared.size > 0)
    dependencyByKind.elem.push(
      elemConstructor({ type: funcref, mode: "declarative" }, [...undeclared]),
    );
  // index elems
  dependencyByKind.elem.forEach((elem, elemIdx) => depToIndex.set(elem, elemIdx));
  // index memories
  let nImportMemories = dependencyByKind.importMemory.length;
  dependencyByKind.memory.forEach((memory, memoryIdx) =>
    depToIndex.set(memory, memoryIdx + nImportMemories),
  );
  // index datas
  dependencyByKind.data.forEach((data, dataIdx) => depToIndex.set(data, dataIdx));

  // finalize functions
  let funcs: FinalizedFunc[] = funcs0.map(({ typeIdx, funcIdx, ...func }) => {
    let body = func.body.map((instr) => resolveInstruction(instr, depToIndex));
    return {
      funcIdx: funcIdx,
      typeIdx: typeIdx,
      type: func.type,
      locals: func.locals,
      body,
    };
  });
  // finalize globals
  let globals: Global[] = dependencyByKind.global.map(({ type, init }) => {
    let init_ = resolveConst(init, depToIndex);
    return { type, init: init_ };
  });
  // finalize tables
  let tables: Table[] = dependencyByKind.table.map(({ type, init }) =>
    init === undefined ? type : { ...type, init: resolveConst(init, depToIndex) },
  );
  // finalize elems
  let elems: Elem[] = dependencyByKind.elem.map(({ type, init, mode }) => {
    let init_ = init.map((i) => resolveConst(i, depToIndex));
    let mode_: Elem["mode"] =
      typeof mode === "object"
        ? {
            table: depToIndex.get(mode.table)!,
            offset: resolveConst(mode.offset, depToIndex),
          }
        : mode;
    return { type, init: init_, mode: mode_ };
  });
  // finalize memories
  checkDefaultMemory(dependencyByKind);
  let memories = dependencyByKind.memory.map(({ type }) => type);
  // finalize datas: without a memory, active segments use the default memory
  let datas: Data[] = dependencyByKind.data.map(({ init, mode }) => {
    let mode_: Data["mode"] =
      mode !== "passive"
        ? {
            memory: mode.memory === undefined ? 0 : depToIndex.get(mode.memory)!,
            offset: resolveConst(mode.offset, depToIndex),
          }
        : mode;
    return { init, mode: mode_ };
  });

  // start
  let start = inputStart === undefined ? undefined : depToIndex.get(inputStart);

  // exports
  let exports: Export[] = [];
  for (let [name, exp] of allExports) {
    let kind = Dependency.kindToExportKind[exp.kind];
    let value = depToIndex.get(exp)!;
    exports.push({ name, description: { kind, value } });
  }
  // Resolve debug names only after dependency indices and sorted locals are known.
  const generated: NameSection = name === undefined ? {} : { module: name };
  for (const func of funcs0) {
    if (func.name !== undefined) (generated.functions ??= {})[func.funcIdx] = func.name;
    if (func.localNames !== undefined) (generated.locals ??= {})[func.funcIdx] = func.localNames;
  }
  dependencyByKind.importFunction.forEach((func, index) => {
    const debugName = func.name ?? func.field;
    if (debugName !== undefined) (generated.functions ??= {})[index] = debugName;
    (generated.locals ??= {})[index] = Object.fromEntries(
      func.params.names.map((name, index) => [index, name]),
    );
  });
  const exportNameMaps = {
    function: "functions",
    global: "globals",
    table: "tables",
    memory: "memories",
    tag: "tags",
  } as const;
  for (const {
    name,
    description: { kind, value },
  } of exports) {
    const map: NameMap = (generated[exportNameMaps[kind]] ??= {});
    map[value] ??= name;
  }
  imports
    .filter((imp) => imp.description.kind === "function")
    .forEach((entry, index) => {
      (generated.functions ??= {})[index] ??= entry.name;
    });
  // Explicit metadata overrides inferred entries, preserving other generated names.
  const mergedNames: NameSection = { ...generated, ...names };
  for (const key of Object.values(exportNameMaps)) {
    if (generated[key] !== undefined || names?.[key] !== undefined) {
      mergedNames[key] = { ...generated[key], ...names?.[key] };
    }
  }
  if (generated.locals !== undefined || names?.locals !== undefined) {
    mergedNames.locals = { ...generated.locals, ...names?.locals };
    for (const index of Object.keys(generated.locals ?? {}).map(Number)) {
      mergedNames.locals[index] = { ...generated.locals?.[index], ...names?.locals?.[index] };
    }
  }
  let binableModule: BinableModule = {
    types: registry.types,
    funcs,
    imports,
    exports,
    datas,
    elems,
    tables,
    globals,
    memories,
    tags,
    start,
    ...(Object.keys(mergedNames).length === 0 ? {} : { names: mergedNames }),
    ...(customSections === undefined ? {} : { customSections }),
  };
  return createModule<Exports>(indexTypes(binableModule, registry), importMap, {
    asyncExports,
    importDependencies,
  });
}

/**
 * Wasm can only wait for async imports when JS entered it through an async export. Following direct
 * calls, check that other exports and the start function cannot reach an async import. Indirect calls
 * are not followed: they fail at runtime with a `WebAssembly.SuspendError`.
 */
function checkAsyncCalls(
  exports: [string, Dependency.Export][],
  asyncExports: string[],
  start: Dependency.AnyFunc | undefined,
) {
  let roots: [string, Dependency.AnyFunc][] = exports.flatMap(([name, value]) =>
    (value.kind === "function" || value.kind === "importFunction") && !asyncExports.includes(name)
      ? [[`export "${name}"`, value] as [string, Dependency.AnyFunc]]
      : [],
  );
  if (start !== undefined) roots.push(["the start function", start]);
  // Functions that one root reaches without an async import need no second look from another.
  let visited = new Set<Dependency.AnyFunc>();
  for (let [root, func] of roots) {
    let path = asyncPath(func, visited);
    if (path === undefined) continue;
    let via = path.slice(1, -1).map(functionName);
    throw Error(
      `${root} reaches async import ${functionName(path.at(-1)!)}${via.length > 0 ? ` via ${via.join(", ")}` : ""}; export it as async(...)`,
    );
  }
}

/** A chain of direct calls from a function to an async import, if any. */
function asyncPath(
  func: Dependency.AnyFunc,
  visited: Set<Dependency.AnyFunc>,
): Dependency.AnyFunc[] | undefined {
  if (visited.has(func)) return undefined;
  visited.add(func);
  if (func.kind === "importFunction") return func.async ? [func] : undefined;
  for (let callee of directCalls(func.body)) {
    let path = asyncPath(callee, visited);
    if (path !== undefined) return [func, ...path];
  }
  return undefined;
}

/** Functions called by `call` and `return_call`, including in nested blocks. */
function* directCalls(body: Dependency.Instruction[]): Generator<Dependency.AnyFunc> {
  for (let instruction of body) {
    if (instruction.string === "call" || instruction.string === "return_call")
      yield instruction.deps[0] as Dependency.AnyFunc;
    for (let arg of instruction.resolveArgs)
      if (Array.isArray(arg) && typeof arg[0]?.string === "string") yield* directCalls(arg);
  }
}

function functionName(func: Dependency.AnyFunc) {
  return func.name === undefined ? "<anonymous function>" : `"${func.name}"`;
}

function orderGlobals(globals: Dependency.Global[]): Dependency.Global[] {
  let ordered: Dependency.Global[] = [];
  let visited = new Set<Dependency.Global>();
  let visit = (global: Dependency.Global) => {
    if (visited.has(global)) return;
    visited.add(global);
    for (let dep of global.deps) if (dep.kind === "global") visit(dep);
    ordered.push(global);
  };
  globals.forEach(visit);
  return ordered;
}

/**
 * Builders refer to defined types as objects. Give each its type index, adding types as needed, so
 * that the module refers to types by index only, and record type and field names.
 */
function indexTypes(module: BinableModule, registry: TypeRegistry): BinableModule {
  const value = <T extends ValueType>(type: T): T => registry.value(type);
  const instructions = (body: ResolvedInstruction[]) => registry.instructions(body);
  const indexed: BinableModule = {
    ...module,
    funcs: module.funcs.map((func) => ({
      ...func,
      type: registry.signature(func.type),
      locals: func.locals.map(value),
      body: instructions(func.body),
    })),
    globals: module.globals.map(({ type, init }) => ({
      type: { ...type, value: value(type.value) },
      init: instructions(init),
    })),
    tables: module.tables.map(({ type, init, ...table }) => ({
      ...table,
      type: value(type),
      ...(init === undefined ? {} : { init: instructions(init) }),
    })),
    elems: module.elems.map(({ type, init, mode }) => ({
      type: value(type),
      init: init.map(instructions),
      mode: typeof mode === "string" ? mode : { ...mode, offset: instructions(mode.offset) },
    })),
    datas: module.datas.map(({ init, mode }) => ({
      init,
      mode: mode === "passive" ? mode : { ...mode, offset: instructions(mode.offset) },
    })),
    imports: module.imports.map((imp) => {
      const { description } = imp;
      if (description.kind === "global") {
        const type = { ...description.value, value: value(description.value.value) };
        return { ...imp, description: { ...description, value: type } };
      }
      if (description.kind === "table") {
        const type = { ...description.value, type: value(description.value.type) };
        return { ...imp, description: { ...description, value: type } };
      }
      return imp;
    }),
  };
  if (registry.groups.some((size) => size !== 1)) indexed.recGroups = registry.groups;
  // Names given in the builder, unless the module's names override them.
  const { names: typeNames, fieldNames } = registry;
  if (Object.keys(typeNames).length > 0 || Object.keys(fieldNames).length > 0) {
    const names = { ...indexed.names };
    if (Object.keys(typeNames).length > 0) names.types = { ...typeNames, ...names.types };
    if (Object.keys(fieldNames).length > 0) names.fields = { ...fieldNames, ...names.fields };
    indexed.names = names;
  }
  return indexed;
}

/**
 * `asyncExports` names the exports that are wrapped by `WebAssembly.promising` on instantiation.
 * Modules of the builder know the dependencies behind their imports, in order, which `wasmati build`
 * turns into a JS module.
 */
function createModule<Exports extends Record<string, ExportInput>>(
  binableModule: BinableModule,
  importMap: WebAssembly.Imports,
  {
    asyncExports = [],
    importDependencies,
  }: { asyncExports?: string[]; importDependencies?: Dependency.AnyImport[] } = {},
) {
  let module = {
    module: binableModule,
    importMap,
    asyncExports,
    importDependencies,
    /** Instantiate Wasm with inferred native export signatures; exports are the actual Wasm functions. */
    async instantiate() {
      let { instance, module } = await WebAssembly.instantiate(
        BinableModule.encode(binableModule),
        importMap,
        compileOptions(binableModule),
      );
      return { instance: withAsyncExports(instance, asyncExports), module } as {
        instance: TypedInstance<Exports>;
        module: WebAssembly.Module;
      };
    },
    /** Compile Wasm without instantiating it, for example to instantiate it in workers. */
    compile() {
      return WebAssembly.compile(
        BinableModule.encode(binableModule),
        compileOptions(binableModule),
      );
    },
    toBytes() {
      return BinableModule.encode(module.module);
    },
    /** The module in the WebAssembly text format, with names as identifiers. */
    toWat() {
      return printWat(module.module);
    },
  };
  return module;
}

/** Modules that use JS string builtins compile with them. */
function compileOptions(module: BinableModule): WebAssembly.CompileOptions {
  return usesJSStringBuiltins(module.imports) ? jsStringBuiltins : {};
}

/**
 * An instance whose async exports are wrapped by `WebAssembly.promising`; the other exports and the
 * prototype are the instance's own.
 */
function withAsyncExports(instance: WebAssembly.Instance, asyncExports: string[]) {
  if (asyncExports.length === 0) return instance;
  let wrapped = Object.fromEntries(
    asyncExports.map((name) => [name, WebAssembly.promising(instance.exports[name] as Function)]),
  );
  let exports = Object.freeze({ ...instance.exports, ...wrapped });
  return Object.create(instance, { exports: { value: exports } }) as WebAssembly.Instance;
}

/** An instance with the inferred types of a module's exports. */
type TypedInstance<Exports extends Record<string, ExportInput>> = WebAssembly.Instance & {
  exports: { [K in keyof Exports]: ModuleExport<Exports[K]> };
};

/**
 * The instance of a module, as `instantiate()` returns it, for instances created otherwise: for
 * example in a worker, from the compiled module and the import object of the module.
 */
type ModuleInstance<M extends Module> = Awaited<ReturnType<M["instantiate"]>>["instance"];

type ModuleExport<Export extends ExportInput> =
  Export extends AsyncExport<infer F>
    ? AsyncFunction<F>
    : Export extends Dependency.AnyFunc
      ? JSFunction<Export>
      : Export extends Dependency.AnyGlobal
        ? {
            value: JSValue<Export["type"]["value"]>;
            valueOf(): JSValue<Export["type"]["value"]>;
          }
        : Export extends Dependency.AnyMemory
          ? WebAssembly.Memory
          : Export extends Dependency.AnyTable
            ? WebAssembly.Table
            : Export extends Dependency.AnyTag
              ? WebAssembly.Tag
              : unknown;

/** An async export returns a promise of its results. */
type AsyncFunction<T extends Dependency.AnyFunc> = (
  ...args: Parameters<JSFunction<T>>
) => Promise<ReturnType<JSFunction<T>>>;

const Module = Object.assign(ModuleConstructor, {
  fromBytes<Exports extends Record<string, ExportInput>>(
    bytes: Uint8Array,
    importMap: WebAssembly.Imports = {},
  ) {
    let binableModule = BinableModule.fromBytes(bytes);
    return createModule<Exports>(binableModule, importMap);
  },
  /** A module from the WebAssembly text format. */
  fromWat<Exports extends Record<string, ExportInput>>(
    text: string,
    importMap: WebAssembly.Imports = {},
  ) {
    return createModule<Exports>(parseWat(text), importMap);
  },
});

function pushDependency(existing: Set<Dependency.anyDependency>, dep: Dependency.anyDependency) {
  if (existing.has(dep)) return;
  existing.add(dep);
  for (let dep_ of dep.deps) {
    pushDependency(existing, dep_);
  }
}

/** A constant expression's instructions, which refer to other definitions by index. */
function resolveConst(
  constant: Dependency.Constant,
  depToIndex: Map<Dependency.t, number>,
): ResolvedInstruction[] {
  return constant.body.map((instruction) => resolveInstruction(instruction, depToIndex));
}

function addImport(
  dependency: Dependency.AnyImport,
  description: Import["description"],
  i: number,
  importMap: WebAssembly.Imports,
): Import {
  let { kind, module = "", field } = dependency;
  let value =
    dependency.kind === "importFunction" && dependency.async
      ? suspending(dependency.value)
      : dependency.value;
  let prefix = {
    importFunction: "f",
    importGlobal: "g",
    importMemory: "m",
    importTable: "t",
    importTag: "e",
  }[kind];
  field ??= `${prefix}${i}`;
  let import_ = { module, name: field, description };
  let importModule = (importMap[module] ??= {});
  if (field in importModule && importModule[field] !== value) {
    throw Error(
      `Overwriting import "${module}" > "${field}" with different value. Use the same value twice instead.`,
    );
  }
  importModule[field] = value as WebAssembly.ImportValue;
  return import_;
}

/** Async imports are wrapped once per function, so that a function imported twice is one value. */
const suspendingWrappers = new WeakMap<Function, WebAssembly.Suspending>();
function suspending(run: Function) {
  let wrapper = suspendingWrappers.get(run);
  if (wrapper === undefined)
    suspendingWrappers.set(run, (wrapper = new WebAssembly.Suspending(run)));
  return wrapper;
}

/**
 * Instructions and segments that do not name a memory use the default memory, which must exist, be the
 * only memory, and have 32-bit addresses.
 */
function checkDefaultMemory(dependencyByKind: {
  importMemory: Dependency.ImportMemory[];
  memory: Dependency.Memory[];
  hasMemory: Dependency.HasMemory[];
}) {
  let nMemoriesTotal = dependencyByKind.importMemory.length + dependencyByKind.memory.length;
  if (nMemoriesTotal === 0) {
    if (dependencyByKind.hasMemory.length > 0) {
      throw Error(`Module(): The module depends on the existence of a memory, but no memory was found. You can add a memory like this:

let module = Module({
  //...
  memory: Memory({ min: 1 })
});
`);
    }
  }
  let memories = [...dependencyByKind.importMemory, ...dependencyByKind.memory];
  if (dependencyByKind.hasMemory.length > 0 && memories.length > 1)
    throw Error(
      "Module(): with several memories, memory instructions and data segments must name their memory, e.g. i32.load({ memory }, address).",
    );
  if (dependencyByKind.hasMemory.length > 0 && memories[0]?.type.limits.address === "i64")
    throw Error(
      "Module(): instructions that do not name their memory need a 32-bit memory. Pass the 64-bit memory to them, e.g. i32.load({ memory }, address).",
    );
}
