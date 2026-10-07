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
  TableType,
} from "./types.ts";
import { memoryConstructor } from "./memory.ts";
import { TypeRegistry } from "./type-registry.ts";
import type { NameMap, NameSection } from "./name-section.ts";
import type { CustomSection } from "./module-binable.ts";

export { Module, type ModuleExport };

type Module = ReturnType<typeof ModuleConstructor>;

function ModuleConstructor<Exports extends Record<string, Dependency.Export>>({
  exports: inputExports,
  exportEntries = [],
  memory: inputMemory,
  start: inputStart,
  name,
  names,
  customSections,
  dependencies: inputDependencies = [],
}: {
  exports: Exports;
  /**
   * Further exports as ordered name-value pairs, after `exports`. Unlike in `exports`, names can repeat,
   * which makes the module invalid; the decompiler uses this to reproduce such modules faithfully.
   */
  exportEntries?: [name: string, value: Dependency.Export][];
  memory?: Limits | Dependency.AnyMemory;
  start?: Dependency.AnyFunc;
  name?: string;
  names?: NameSection;
  customSections?: CustomSection[];
  /** Include declarations even when exports and the start function do not reference them. */
  dependencies?: Dependency.t[];
}) {
  // collect all dependencies (by kind)
  let dependencies = new Set<Dependency.t>();
  for (const dep of inputDependencies) pushDependency(dependencies, dep);
  let allExports: [string, Dependency.Export][] = [
    ...Object.entries(inputExports),
    ...exportEntries,
  ];
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
  return createModule<Exports>(indexTypes(binableModule, registry), importMap);
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

function createModule<Exports extends Record<string, Dependency.Export>>(
  binableModule: BinableModule,
  importMap: WebAssembly.Imports,
) {
  let module = {
    module: binableModule,
    importMap,
    /** Instantiate Wasm with inferred native export signatures; exports are the actual Wasm functions. */
    async instantiate() {
      return (await WebAssembly.instantiate(
        Uint8Array.from(BinableModule.toBytes(binableModule)),
        importMap,
      )) as {
        instance: WebAssembly.Instance & {
          exports: { [K in keyof Exports]: ModuleExport<Exports[K]> };
        };
        module: WebAssembly.Module;
      };
    },
    toBytes() {
      let bytes = BinableModule.toBytes(module.module);
      return Uint8Array.from(bytes);
    },
  };
  return module;
}

type ModuleExport<Export extends Dependency.Export> = Export extends Dependency.AnyFunc
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

const Module = Object.assign(ModuleConstructor, {
  fromBytes<Exports extends Record<string, Dependency.Export>>(
    bytes: Uint8Array,
    importMap: WebAssembly.Imports = {},
  ) {
    let binableModule = BinableModule.fromBytes(bytes);
    return createModule<Exports>(binableModule, importMap);
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
  { kind, module = "", field, value }: Dependency.AnyImport,
  description: Import["description"],
  i: number,
  importMap: WebAssembly.Imports,
): Import {
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
