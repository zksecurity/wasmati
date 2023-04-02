import * as Dependency from "./dependency.js";
import { Export, Import } from "./export.js";
import { FinalizedFunc, JSFunctionType } from "./func.js";
import { resolveInstruction } from "./instruction/base.js";
import { Module as BinableModule } from "./module-binable.js";
import { Data, Elem, Global } from "./memory-binable.js";
import {
  FunctionType,
  functionTypeEquals,
  Limits,
  MemoryType,
  TableType,
} from "./types.js";
import { memoryConstructor } from "./memory.js";

export { Module };

type Module = BinableModule;

function ModuleConstructor<Exports extends Record<string, Dependency.Export>>({
  exports: inputExports,
  memory: inputMemory,
  start: inputStart,
}: {
  exports: Exports;
  memory?: Limits | Dependency.AnyMemory;
  start?: Dependency.AnyFunc;
}) {
  // collect all dependencies (by kind)
  let dependencies = new Set<Dependency.t>();
  for (let name in inputExports) {
    pushDependency(dependencies, inputExports[name]);
  }
  if (inputMemory !== undefined) {
    let memory =
      "kind" in inputMemory ? inputMemory : memoryConstructor(inputMemory);
    pushDependency(dependencies, memory);
  }
  if (inputStart !== undefined) {
    pushDependency(dependencies, inputStart);
  }
  let dependencyByKind: {
    [K in Dependency.t["kind"]]: (Dependency.t & { kind: K })[];
  } = Object.fromEntries(
    Dependency.dependencyKinds.map((key) => [key, []])
  ) as any;
  for (let dep of dependencies) {
    (dependencyByKind[dep.kind] as Dependency.t[]).push(dep);
  }
  let depToIndex = new Map<Dependency.t, number>();

  // process imports, along with types of imported functions
  let imports: Import[] = [];
  let importMap: WebAssembly.Imports = {};
  let types: FunctionType[] = [];

  dependencyByKind.importFunction.forEach((func, funcIdx) => {
    let typeIdx = pushType(types, func.type);
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
    let typeIdx = pushType(types, func.type);
    let funcIdx = nImportFuncs + funcs0.length;
    funcs0.push({ ...func, typeIdx, funcIdx });
    depToIndex.set(func, funcIdx);
  }

  // index other types
  for (let type of dependencyByKind.type) {
    let typeIdx = pushType(types, type.type);
    depToIndex.set(type, typeIdx);
  }
  // index globals
  let nImportGlobals = dependencyByKind.importGlobal.length;
  dependencyByKind.global.forEach((global, globalIdx) =>
    depToIndex.set(global, globalIdx + nImportGlobals)
  );
  // index tables
  let nImportTables = dependencyByKind.importTable.length;
  dependencyByKind.table.forEach((table, tableIdx) =>
    depToIndex.set(table, tableIdx + nImportTables)
  );
  // index elems
  dependencyByKind.elem.forEach((elem, elemIdx) =>
    depToIndex.set(elem, elemIdx)
  );
  // index memories
  let nImportMemories = dependencyByKind.importMemory.length;
  dependencyByKind.memory.forEach((memory, memoryIdx) =>
    depToIndex.set(memory, memoryIdx + nImportMemories)
  );
  // index datas
  dependencyByKind.data.forEach((data, dataIdx) =>
    depToIndex.set(data, dataIdx)
  );

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
    let init_ = [resolveInstruction(init, depToIndex)];
    return { type, init: init_ };
  });
  // finalize tables
  let tables: TableType[] = dependencyByKind.table.map(({ type }) => type);
  // finalize elems
  let elems: Elem[] = dependencyByKind.elem.map(({ type, init, mode }) => {
    let init_ = init.map((i) => [resolveInstruction(i, depToIndex)]);
    let mode_: Elem["mode"] =
      typeof mode === "object"
        ? {
            table: depToIndex.get(mode.table)!,
            offset: [resolveInstruction(mode.offset, depToIndex)],
          }
        : mode;
    return { type, init: init_, mode: mode_ };
  });
  // finalize memory
  let memory = checkMemory(dependencyByKind);
  // finalize datas
  let datas: Data[] = dependencyByKind.data.map(({ init, mode }) => {
    let mode_: Data["mode"] =
      mode !== "passive"
        ? {
            memory: mode.memory,
            offset: [resolveInstruction(mode.offset, depToIndex)],
          }
        : mode;
    return { init, mode: mode_ };
  });

  // start
  let start = inputStart === undefined ? undefined : depToIndex.get(inputStart);

  // exports
  let exports: Export[] = [];
  for (let name in inputExports) {
    let exp = inputExports[name];
    let kind = Dependency.kindToExportKind[exp.kind];
    let value = depToIndex.get(exp)!;
    exports.push({ name, description: { kind, value } });
  }
  let binableModule: BinableModule = {
    types,
    funcs,
    imports,
    exports,
    datas,
    elems,
    tables,
    globals,
    memory,
    start,
  };
  let module = {
    module: binableModule,
    importMap,
    async instantiate() {
      let wasmByteCode = Module.toBytes(binableModule);
      return (await WebAssembly.instantiate(
        Uint8Array.from(wasmByteCode),
        importMap
      )) as {
        instance: WebAssembly.Instance & { exports: NiceExports<Exports> };
        module: WebAssembly.Module;
      };
    },
    toBytes() {
      let bytes = Module.toBytes(module.module);
      return Uint8Array.from(bytes);
    },
  };
  return module;
}

type NiceExports<Exports extends Record<string, Dependency.Export>> = {
  [K in keyof Exports]: NiceExport<Exports[K]>;
};
type NiceExport<Export extends Dependency.Export> =
  Export extends Dependency.AnyFunc
    ? JSFunctionType<Export["type"]>
    : Export extends Dependency.AnyGlobal
    ? WebAssembly.Global
    : Export extends Dependency.AnyMemory
    ? WebAssembly.Memory
    : Export extends Dependency.AnyTable
    ? WebAssembly.Table
    : unknown;

const Module = Object.assign(ModuleConstructor, BinableModule);

function pushDependency(
  existing: Set<Dependency.anyDependency>,
  dep: Dependency.anyDependency
) {
  if (existing.has(dep)) return;
  existing.add(dep);
  for (let dep_ of dep.deps) {
    pushDependency(existing, dep_);
  }
}

function pushType(types: FunctionType[], type: FunctionType) {
  let typeIndex = types.findIndex((t) => functionTypeEquals(t, type));
  if (typeIndex === -1) {
    typeIndex = types.length;
    types.push(type);
  }
  return typeIndex;
}

function addImport(
  { kind, module = "", string, value }: Dependency.AnyImport,
  description: Import["description"],
  i: number,
  importMap: WebAssembly.Imports
): Import {
  let prefix = {
    importFunction: "f",
    importGlobal: "g",
    importMemory: "m",
    importTable: "t",
  }[kind];
  string ??= `${prefix}${i}`;
  let import_ = { module, name: string, description };
  let importModule = (importMap[module] ??= {});
  if (string in importModule && importModule[string] !== value) {
    throw Error(
      `Overwriting import "${module}" > "${string}" with different value. Use the same value twice instead.`
    );
  }
  importModule[string] = value;
  return import_;
}

function checkMemory(dependencyByKind: {
  importMemory: Dependency.ImportMemory[];
  memory: Dependency.Memory[];
  hasMemory: Dependency.HasMemory[];
}): MemoryType | undefined {
  let nMemoriesTotal =
    dependencyByKind.importMemory.length + dependencyByKind.memory.length;
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
  return dependencyByKind.memory[0]?.type;
}
