import {
  type Binable,
  Byte,
  RemainingBytes,
  iso,
  orDefault,
  orUndefined,
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
  GlobalType,
  MemoryType,
  TableType,
  type ValueTypeObject,
} from "./types.ts";
import { Export, Import } from "./export.ts";
import { Data, Elem, Global } from "./memory-binable.ts";
import { Code, type FinalizedFunc } from "./func.ts";

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
  types: FunctionType[];
  funcs: FinalizedFunc[];
  tables: TableType[];
  memory?: MemoryType;
  globals: Global[];
  elems: Elem[];
  datas: Data[];
  start?: FunctionIndex;
  imports: Import[];
  exports: Export[];
  names?: NameSection;
  customSections?: CustomSection[];
};

function section<T>(code: number, b: Binable<T>) {
  return withByteCode(code, withByteLength(b));
}
// 0: CustomSection
const CustomPayload = record({ name: Name, data: RemainingBytes });
const CustomSection = section(0, CustomPayload);

// 1: TypeSection
type TypeSection = FunctionType[];
let TypeSection = section<TypeSection>(1, vec(FunctionType));

// 2: ImportSection
type ImportSection = Import[];
let ImportSection = section<ImportSection>(2, vec(Import));

// 3: FuncSection
type FuncSection = U32[];
let FuncSection = section<FuncSection>(3, vec(U32));

// 4: TableSection
type TableSection = TableType[];
let TableSection = section<TableSection>(4, vec(TableType));

// 5: MemorySection
type MemorySection = MemoryType[];
let MemorySection = section<MemorySection>(5, vec(MemoryType));

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

const isEmpty = (arr: unknown[]) => arr.length === 0;

type Sections = {
  typeSection: TypeSection;
  importSection: ImportSection;
  funcSection: FuncSection;
  tableSection: TableSection;
  memorySection: MemorySection;
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
    typeSection: orDefault(TypeSection, [], isEmpty),
    importSection: orDefault(ImportSection, [], isEmpty),
    funcSection: orDefault(FuncSection, [], isEmpty),
    tableSection: orDefault(TableSection, [], isEmpty),
    memorySection: orDefault(MemorySection, [], isEmpty),
    globalSection: orDefault(GlobalSection, [], isEmpty),
    exportSection: orDefault(ExportSection, [], isEmpty),
    startSection: orUndefined(StartSection),
    elemSection: orDefault(ElemSection, [], isEmpty),
    dataCountSection: orUndefined(DataCountSection),
    codeSection: orDefault(CodeSection, [], isEmpty),
    dataSection: orDefault(DataSection, [], isEmpty),
  },
  { codec: CustomSection, matches: (bytes, offset) => bytes[offset] === 0 },
);

const ParsedModule = withValidation(
  withPreamble([0x00, 0x61, 0x73, 0x6d], record({ version: Version, sections: Sections })),
  ({
    version,
    sections: {
      value: { funcSection, codeSection, memorySection, dataSection, dataCountSection },
    },
  }) => {
    if (version !== 1) throw Error("unsupported version");
    if (funcSection.length !== codeSection.length) {
      throw Error("length of function and code sections do not match.");
    }
    if (memorySection.length > 1) {
      throw Error("multiple memories are not allowed");
    }
    if (dataCountSection !== undefined && dataSection.length !== dataCountSection)
      throw Error("data section length does not match data count section");
  },
);

const Module = iso(ParsedModule, {
  to({
    types,
    imports,
    funcs,
    tables,
    memory,
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
    let memorySection = memory ? [memory] : [];
    let codeSection = funcs.map(({ locals, body }) => ({ locals, body }));
    let exportSection: Export[] = exports;
    return {
      version: 1,
      sections: {
        extras,
        value: {
          typeSection: types,
          importSection: imports,
          funcSection,
          tableSection: tables,
          memorySection,
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
    let funcs = funcSection.map((typeIdx, funcIdx) => {
      let type = typeSection[typeIdx];
      let { locals, body } = codeSection[funcIdx];
      return {
        funcIdx: importedFunctionsLength + funcIdx,
        typeIdx,
        type,
        locals,
        body,
      };
    });
    let [memory] = memorySection;
    let exports: Export[] = exportSection;
    return {
      types: typeSection,
      imports: importSection,
      funcs,
      tables: tableSection,
      memory,
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
  tables: TableType[];
  memories: MemoryType[];
  globals: GlobalType[];
  elems: Elem[];
  datas: Data[];
  locals: ValueTypeObject[];
  labels: ValueTypeObject[][];
  return?: ValueTypeObject[];
  refs: FunctionIndex[];
};
