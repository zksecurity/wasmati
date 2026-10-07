import { branchHintSection, decodeBranchHints, encodeBranchHints } from "./branch-hints.ts";
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
import { Data, Elem, Global, Table } from "./memory-binable.ts";
import { Code, type FinalizedFunc } from "./func.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";

export { Module, type CustomSection };

type CustomSection = {
  name: string;
  data: number[];
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
type TableSection = Table[];
let TableSection = section<TableSection>(4, vec(Table));

// 5: MemorySection
type MemorySection = MemoryType[];
let MemorySection = section<MemorySection>(5, vec(MemoryType));

// 13: TagSection, between the memory and global sections
type TagSection = TagType[];
let TagSection = section<TagSection>(13, vec(TagType));

// 6: GlobalSection
type GlobalSection = Global[];
let GlobalSection = section<GlobalSection>(6, vec(Global));

// 7: ExportSection
type ExportSection = Export[];
let ExportSection = section<ExportSection>(7, vec(Export));

// 8: StartSection
type StartSection = U32;
let StartSection = section<StartSection>(8, U32);

// 9: ElementSection
type ElemSection = Elem[];
let ElemSection = section<ElemSection>(9, vec(Elem));

// 10: CodeSection
type CodeSection = Code[];
let CodeSection = section<CodeSection>(10, vec(Code));

// 11: DataSection
type DataSection = Data[];
let DataSection = section<DataSection>(11, vec(Data));

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
    toBytes: (value) => (isEmpty(value) ? [] : section.toBytes(value)),
    readBytes: (bytes, offset) =>
      bytes[offset] === id ? section.readBytes(bytes, offset) : [empty, offset],
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

const Sections = interleavedRecord<Sections, { name: string; data: number[] }>(
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
  { codec: CustomSection, matches: (bytes, offset) => bytes[offset] === 0 },
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
    if (dataCountSection === undefined && codeSection.some(({ body }) => usesDataIndex(body)))
      throw Error("data count section required");
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

const Module = iso(ParsedModule, {
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
  }: Module) {
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
    let codeSection = funcs.map(({ locals, body }) => ({ locals, body }));
    let importedFunctions = imports.filter((i) => i.description.kind === "function").length;
    let hints = encodeBranchHints(codeSection, importedFunctions);
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
          dataCountSection: datas.length,
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
        elemSection,
      },
    },
  }): Module {
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
    let importedFunctionsLength = importSection.filter(
      (i) => i.description.kind === "function",
    ).length;
    const hintSections = customSections.filter(({ name }) => name === branchHintSection);
    if (hintSections.length === 1) {
      const section = hintSections[0];
      try {
        decodeBranchHints(section.data, codeSection, importedFunctionsLength);
        customSections.splice(customSections.indexOf(section), 1);
      } catch {
        // Invalid optional metadata remains an opaque custom section.
      }
    }
    let types = typeSection.flat();
    let funcs = funcSection.map((typeIdx, funcIdx) => {
      let type = types[typeIdx];
      if (type === undefined || !isFunctionType(type))
        throw Error(`function ${funcIdx} does not have a function type`);
      let { locals, body } = codeSection[funcIdx];
      return {
        funcIdx: importedFunctionsLength + funcIdx,
        typeIdx,
        type,
        locals,
        body,
      };
    });
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
      elems: elemSection,
      ...(names === undefined ? {} : { names }),
      ...(customSections.length === 0 ? {} : { customSections }),
    };
  },
});

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
