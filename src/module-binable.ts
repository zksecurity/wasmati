import {
  branchHintSection,
  decodeBranchHints,
  encodeBranchHints,
  encodeCode,
  type Hint,
} from "./branch-hints.ts";
import {
  Binable,
  Byte,
  RemainingBytes,
  iso,
  record,
  interleavedRecord,
  tuple,
  withByteCode,
  withPreamble,
  withValidation,
} from "./binable.ts";
import { Name, U32, vec, withByteLength } from "./immediate.ts";
import { NameSection } from "./name-section.ts";
import {
  FunctionIndex,
  TypeIndex,
  FunctionType,
  isFunctionType,
  RecType,
  TypeDefinition,
  GlobalType,
  MemoryType,
  TagType,
  TableType,
  type ValueTypeObject,
} from "./types.ts";
import { Export, type Import, Imports } from "./export.ts";
import {
  type Data,
  type Elem,
  type Global,
  type Table,
  EncodedData,
  EncodedElem,
  EncodedGlobal,
  EncodedTable,
} from "./memory-binable.ts";
import { Expression } from "./instruction/binable.ts";
import type { FinalizedFunc } from "./func.ts";
import { CodeEntry, FunctionCode } from "./code-section.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";

export { Module, EncodedModule, type EncodedFunc, type CustomSection };

type CustomSection = {
  name: string;
  data: Uint8Array;
  // Position after a standard section id; 0 means before the first section.
  // If that section is empty/absent, use its position in the section order.
  // Omit to append after all standard sections.
  after?: number;
};

type Module = {
  types: TypeDefinition[];
  /** Sizes of the recursion groups that partition types, if any group is not a single type. */
  recGroups?: number[];
  funcs: FinalizedFunc[];
  tables: Table[];
  memories: MemoryType[];
  /** Exception tags, by the index of their function type. */
  tags: TagType[];
  globals: Global[];
  elems: Elem[];
  datas: Data[];
  start?: FunctionIndex;
  imports: Import[];
  exports: Export[];
  names?: NameSection;
  customSections?: CustomSection[];
};

/**
 * A function whose code is encoded: its locals and body, as in the code section, and the offsets of
 * the branch hints that the module writes for it, from the start of its code.
 */
type EncodedFunc = { typeIdx: TypeIndex; code: Uint8Array; hints: Hint[] };

/**
 * A module whose code is encoded: its functions, and the constant expressions of its globals, tables
 * and segments. Its bytes encode and decode it directly. Decoding leaves a branch hint section among
 * the custom sections; encoding writes one from the functions' hints.
 */
type EncodedModule = Omit<Module, "funcs" | "globals" | "tables" | "elems" | "datas"> & {
  funcs: EncodedFunc[];
  globals: EncodedGlobal[];
  tables: EncodedTable[];
  elems: EncodedElem[];
  datas: EncodedData[];
  /** The number of data segments in the data count section, which code that refers to them needs. */
  dataCount?: number;
};

/** Split types into their recursion groups; without groups, each type forms a group of its own. */
function groupTypes(types: TypeDefinition[], recGroups = types.map(() => 1)): TypeDefinition[][] {
  let start = 0;
  let groups = recGroups.map((size) => types.slice(start, (start += size)));
  if (start !== types.length) throw Error("recursion groups do not partition the types");
  return groups;
}

function section<T>(code: number, b: Binable<T>) {
  return withByteCode(code, withByteLength(b));
}
// 0: CustomSection
const CustomPayload = record({ name: Name, data: RemainingBytes });
const CustomSection = section(0, CustomPayload);

// 1: TypeSection
/** Recursion groups of type definitions. */
type TypeSection = TypeDefinition[][];
let TypeSection = section<TypeSection>(1, vec(RecType));

// 2: ImportSection
type ImportSection = Import[];
let ImportSection = section<ImportSection>(2, Imports);

// 3: FuncSection
type FuncSection = U32[];
let FuncSection = section<FuncSection>(3, vec(U32));

// 4: TableSection
type TableSection = EncodedTable[];
let TableSection = section<TableSection>(4, vec(EncodedTable));

// 5: MemorySection
type MemorySection = MemoryType[];
let MemorySection = section<MemorySection>(5, vec(MemoryType));

// 13: TagSection, between the memory and global sections
type TagSection = TagType[];
let TagSection = section<TagSection>(13, vec(TagType));

// 6: GlobalSection
type GlobalSection = EncodedGlobal[];
let GlobalSection = section<GlobalSection>(6, vec(EncodedGlobal));

// 7: ExportSection
type ExportSection = Export[];
let ExportSection = section<ExportSection>(7, vec(Export));

// 8: StartSection
type StartSection = U32;
let StartSection = section<StartSection>(8, U32);

// 9: ElementSection
type ElemSection = EncodedElem[];
let ElemSection = section<ElemSection>(9, vec(EncodedElem));

// 10: CodeSection
type CodeSection = Uint8Array[];
let CodeSection = section<CodeSection>(10, vec(CodeEntry));

// 11: DataSection
type DataSection = EncodedData[];
let DataSection = section<DataSection>(11, vec(EncodedData));

// 12: DataCountSection
type DataCountSection = U32;
let DataCountSection = section<DataCountSection>(12, U32);

const Version = iso(tuple([Byte, Byte, Byte, Byte]), {
  to(n: number) {
    return [n, 0x00, 0x00, 0x00];
  },
  from([n0, n1, n2, n3]) {
    if (n1 || n2 || n3) throw Error("invalid version");
    return n0;
  },
});

/** A section that may be absent. Presence follows from the section id; a present section must decode. */
function optional<T>(id: number, section: Binable<T>, empty: T): Binable<T> {
  const isEmpty = (value: T) => value === undefined || (Array.isArray(value) && value.length === 0);
  return Binable({
    writeBytes: (output, value) => {
      if (!isEmpty(value)) section.writeBytes(output, value);
    },
    readBytes: (input) => (input.bytes[input.offset] === id ? section.readBytes(input) : empty),
  });
}

type Sections = {
  typeSection: TypeSection;
  importSection: ImportSection;
  funcSection: FuncSection;
  tableSection: TableSection;
  memorySection: MemorySection;
  tagSection: TagSection;
  globalSection: GlobalSection;
  exportSection: ExportSection;
  startSection?: StartSection;
  elemSection: ElemSection;
  dataCountSection?: DataCountSection;
  codeSection: CodeSection;
  dataSection: DataSection;
};

const sectionIds = {
  typeSection: 1,
  importSection: 2,
  funcSection: 3,
  tableSection: 4,
  memorySection: 5,
  tagSection: 13,
  globalSection: 6,
  exportSection: 7,
  startSection: 8,
  elemSection: 9,
  dataCountSection: 12,
  codeSection: 10,
  dataSection: 11,
} as const;

const Sections = interleavedRecord<Sections, { name: string; data: Uint8Array }>(
  {
    typeSection: optional(1, TypeSection, []),
    importSection: optional(2, ImportSection, []),
    funcSection: optional(3, FuncSection, []),
    tableSection: optional(4, TableSection, []),
    memorySection: optional(5, MemorySection, []),
    tagSection: optional(13, TagSection, []),
    globalSection: optional(6, GlobalSection, []),
    exportSection: optional(7, ExportSection, []),
    startSection: optional(8, StartSection, undefined),
    elemSection: optional(9, ElemSection, []),
    dataCountSection: optional(12, DataCountSection, undefined),
    codeSection: optional(10, CodeSection, []),
    dataSection: optional(11, DataSection, []),
  },
  { codec: CustomSection, matches: (input) => input.bytes[input.offset] === 0 },
);

const ParsedModule = withValidation(
  withPreamble([0x00, 0x61, 0x73, 0x6d], record({ version: Version, sections: Sections })),
  ({
    version,
    sections: {
      value: { funcSection, codeSection, dataSection, dataCountSection },
    },
  }) => {
    if (version !== 1) throw Error("unsupported version");
    if (funcSection.length !== codeSection.length) {
      throw Error("length of function and code sections do not match.");
    }
    if (dataCountSection !== undefined && dataSection.length !== dataCountSection)
      throw Error("data section length does not match data count section");
  },
);

/** Whether code refers to data segments, which requires a data count section before the code. */
function usesDataIndex(body: ResolvedInstruction[]): boolean {
  return body.some(({ name, immediate }) => {
    if (name === "memory.init" || name === "data.drop") return true;
    if (name === "block" || name === "loop" || name === "try_table")
      return usesDataIndex(immediate.instructions);
    if (name === "if")
      return (
        usesDataIndex(immediate.instructions.if) || usesDataIndex(immediate.instructions.else ?? [])
      );
    return false;
  });
}

/** Modules whose functions are encoded, from and to their bytes. */
const EncodedModule = iso(ParsedModule, {
  to({
    types,
    imports,
    funcs,
    tables,
    memories,
    tags,
    recGroups,
    globals,
    exports,
    start,
    datas,
    elems,
    names,
    customSections,
    dataCount,
  }: EncodedModule) {
    const extras = (customSections ?? []).map(({ after, ...value }) => {
      const key = Object.entries(sectionIds).find(([, id]) => id === after)?.[0] as
        keyof Sections | undefined;
      if (after !== undefined && after !== 0 && key === undefined) {
        throw Error(`invalid custom section position ${after}`);
      }
      return { after: after === undefined ? null : key, value };
    });
    if (names !== undefined) {
      extras.push({ after: null, value: { name: "name", data: NameSection.toBytes(names) } });
    }
    let funcSection = funcs.map((f) => f.typeIdx);
    let codeSection = funcs.map((f) => f.code);
    let importedFunctions = imports.filter((i) => i.description.kind === "function").length;
    let hints = encodeBranchHints(funcs, importedFunctions);
    // Engines read branch hints before the code they refer to.
    if (hints !== undefined)
      extras.push({ after: "dataCountSection", value: { name: branchHintSection, data: hints } });
    let exportSection: Export[] = exports;
    return {
      version: 1,
      sections: {
        extras,
        value: {
          typeSection: groupTypes(types, recGroups),
          importSection: imports,
          funcSection,
          tableSection: tables,
          memorySection: memories,
          tagSection: tags,
          globalSection: globals,
          exportSection,
          startSection: start,
          codeSection,
          dataSection: datas,
          dataCountSection: dataCount,
          elemSection: elems,
        },
      },
    };
  },
  from({
    sections: {
      extras,
      value: {
        typeSection,
        importSection,
        funcSection,
        tableSection,
        memorySection,
        tagSection,
        globalSection,
        exportSection,
        startSection,
        codeSection,
        dataSection,
        dataCountSection,
        elemSection,
      },
    },
  }): EncodedModule {
    const customSections = extras.map(({ after, value }) => ({
      ...value,
      after: after === undefined || after === null ? 0 : sectionIds[after],
    }));
    let names: NameSection | undefined;
    const nameSections = customSections.filter(({ name }) => name === "name");
    if (nameSections.length === 1) {
      const section = nameSections[0];
      try {
        names = NameSection.fromBytes(section.data);
        customSections.splice(customSections.indexOf(section), 1);
      } catch {
        // Invalid optional metadata remains an opaque custom section.
      }
    }
    let types = typeSection.flat();
    let funcs = funcSection.map((typeIdx, i) => ({ typeIdx, code: codeSection[i], hints: [] }));
    let exports: Export[] = exportSection;
    return {
      types,
      ...(typeSection.some((group) => group.length !== 1)
        ? { recGroups: typeSection.map((group) => group.length) }
        : {}),
      imports: importSection,
      funcs,
      tables: tableSection,
      memories: memorySection,
      tags: tagSection,
      globals: globalSection,
      exports,
      start: startSection,
      datas: dataSection,
      ...(dataCountSection === undefined ? {} : { dataCount: dataCountSection }),
      elems: elemSection,
      ...(names === undefined ? {} : { names }),
      ...(customSections.length === 0 ? {} : { customSections }),
    };
  },
});

/**
 * Modules as plain JS data: decoding decodes the functions' code and records the branch hint
 * section's hints on their instructions, and encoding encodes the code with its hints.
 */
const Module = iso(EncodedModule, {
  to({ funcs, globals, tables, elems, datas, ...module }: Module): EncodedModule {
    return {
      ...module,
      funcs: funcs.map(({ typeIdx, locals, body }) => ({
        typeIdx,
        ...encodeCode({ locals, body }),
      })),
      ...segments({ globals, tables, elems, datas }, (expression) =>
        Expression.toBytes(expression),
      ),
      dataCount: datas.length,
    };
  },
  from({
    funcs: encoded,
    dataCount,
    globals,
    tables,
    elems,
    datas,
    ...module
  }: EncodedModule): Module {
    let firstFunc = module.imports.filter((i) => i.description.kind === "function").length;
    let funcs = encoded.map(({ typeIdx, code }, i): FinalizedFunc => {
      let type = module.types[typeIdx];
      if (type === undefined || !isFunctionType(type))
        throw Error(`function ${i} does not have a function type`);
      let { locals, body } = FunctionCode.fromBytes(code);
      return { funcIdx: firstFunc + i, typeIdx, type, locals, body };
    });
    if (dataCount === undefined && funcs.some(({ body }) => usesDataIndex(body)))
      throw Error("data count section required");
    let customSections = module.customSections;
    const hintSections = customSections?.filter(({ name }) => name === branchHintSection) ?? [];
    if (hintSections.length === 1) {
      const section = hintSections[0];
      try {
        decodeBranchHints(section.data, funcs, firstFunc);
        customSections = customSections!.filter((custom) => custom !== section);
      } catch {
        // Invalid optional metadata remains an opaque custom section.
      }
    }
    let { customSections: _, ...rest } = module;
    return {
      ...rest,
      funcs,
      ...segments({ globals, tables, elems, datas }, (bytes) => Expression.fromBytes(bytes)),
      ...(customSections === undefined || customSections.length === 0 ? {} : { customSections }),
    };
  },
});

/** Globals, tables and segments, with their constant expressions converted. */
function segments<A, B>(
  {
    globals,
    tables,
    elems,
    datas,
  }: { globals: Global<A>[]; tables: Table<A>[]; elems: Elem<A>[]; datas: Data<A>[] },
  convert: (expression: A) => B,
): { globals: Global<B>[]; tables: Table<B>[]; elems: Elem<B>[]; datas: Data<B>[] } {
  return {
    globals: globals.map(({ type, init }) => ({ type, init: convert(init) })),
    tables: tables.map(({ init, ...table }) =>
      init === undefined ? table : { ...table, init: convert(init) },
    ),
    elems: elems.map(({ type, init, mode }) => ({
      type,
      init: init.map(convert),
      mode: typeof mode === "string" ? mode : { table: mode.table, offset: convert(mode.offset) },
    })),
    datas: datas.map(({ init, mode }) => ({
      init,
      mode: mode === "passive" ? mode : { memory: mode.memory, offset: convert(mode.offset) },
    })),
  };
}

// validation context according to spec.. may remain unused
type ValidationContext = {
  types: FunctionType[];
  funcs: FunctionType[];
  tables: Table[];
  memories: MemoryType[];
  globals: GlobalType[];
  elems: Elem[];
  datas: Data[];
  locals: ValueTypeObject[];
  labels: ValueTypeObject[][];
  return?: ValueTypeObject[];
  refs: FunctionIndex[];
};
