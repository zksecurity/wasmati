import {
  Binable,
  Byte,
  iso,
  orDefault,
  orUndefined,
  record,
  tuple,
  withByteCode,
  withPreamble,
  withValidation,
} from "./binable.ts";
import { Name, U32, vec, withByteLength } from "./immediate.ts";
import { NameSection, readU32 } from "./name-section.ts";
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
  // The preceding standard section id; 0 means before the first section.
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

type ParsedModule = {
  version: number;
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
  names?: NameSection;
  customSections?: CustomSection[];
};

const StandardModule = withPreamble(
  [0x00, 0x61, 0x73, 0x6d],
  record<Omit<ParsedModule, "names" | "customSections">>({
    version: Version,
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
  })
);

// Custom sections may occur anywhere. Keep the standard-section codecs above
// responsible for their existing parsing, ordering and validation.
let ParsedModule = Binable<ParsedModule>({
  toBytes(value) {
    const standard = StandardModule.toBytes(value);
    const customs = value.customSections ?? [];
    if (customs.length === 0 && value.names === undefined) return standard;
    let bytes = standard.slice(0, 8);
    const positions = new Set([0]);
    const append = (after: number | undefined) => {
      for (const section of customs) {
        if (section.after !== after) continue;
        const payload = [...Name.toBytes(section.name), ...section.data];
        bytes = bytes.concat([0], U32.toBytes(payload.length), payload);
      }
    };
    append(0);
    for (const { id, start, end } of sections(standard, 8)) {
      bytes = bytes.concat(standard.slice(start, end));
      positions.add(id);
      append(id);
    }
    for (const section of customs) {
      if (section.after !== undefined && !positions.has(section.after)) {
        throw Error(`custom section position ${section.after} does not exist`);
      }
    }
    append(undefined);
    if (value.names !== undefined) {
      const payload = [...Name.toBytes("name"), ...NameSection.toBytes(value.names)];
      bytes = bytes.concat([0], U32.toBytes(payload.length), payload);
    }
    return bytes;
  },
  readBytes(bytes, offset) {
    const standard = bytes.slice(offset, offset + 8);
    const customSections: CustomSection[] = [];
    let after = 0;
    for (const { id, start, payload, end } of sections(bytes, offset + 8)) {
      if (id !== 0) {
        for (let i = start; i < end; i++) standard.push(bytes[i]);
        after = id;
      } else {
        const body = bytes.slice(payload, end);
        const [name, dataOffset] = Name.readBytes(body, 0);
        customSections.push({ name, data: body.slice(dataOffset), after });
      }
    }
    const value: ParsedModule = StandardModule.fromBytes(standard);
    const nameSections = customSections.filter((section) => section.name === "name");
    if (nameSections.length === 1) {
      const section = nameSections[0];
      try {
        value.names = NameSection.fromBytes(section.data);
        customSections.splice(customSections.indexOf(section), 1);
      } catch {
        // Malformed optional metadata must not prevent reading a valid module.
        // Preserve its original payload as an opaque custom section instead.
      }
    }
    if (customSections.length > 0) value.customSections = customSections;
    return [value, bytes.length];
  },
});

function* sections(bytes: number[], offset: number) {
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++]!;
    let size: number;
    [size, offset] = readU32(bytes, offset);
    const end = offset + size;
    if (end > bytes.length) throw Error("section extends past end of input");
    yield { id, start, payload: offset, end };
    offset = end;
  }
}

ParsedModule = withValidation(
  ParsedModule,
  ({
    version,
    funcSection,
    codeSection,
    memorySection,
    dataSection,
    dataCountSection,
  }) => {
    if (version !== 1) throw Error("unsupported version");
    if (funcSection.length !== codeSection.length) {
      throw Error("length of function and code sections do not match.");
    }
    if (memorySection.length > 1) {
      throw Error("multiple memories are not allowed");
    }
    if (dataSection.length !== (dataCountSection ?? 0))
      throw Error("data section length does not match data count section");
  }
);

const Module = iso<ParsedModule, Module>(ParsedModule, {
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
  }) {
    let funcSection = funcs.map((f) => f.typeIdx);
    let memorySection = memory ? [memory] : [];
    let codeSection = funcs.map(({ locals, body }) => ({ locals, body }));
    let exportSection: Export[] = exports;
    return {
      version: 1,
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
      ...(names === undefined ? {} : { names }),
      ...(customSections === undefined ? {} : { customSections }),
    };
  },
  from({
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
    names,
    customSections,
  }): Module {
    let importedFunctionsLength = importSection.filter(
      (i) => i.description.kind === "function"
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
      ...(customSections === undefined ? {} : { customSections }),
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
