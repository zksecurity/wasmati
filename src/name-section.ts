import { Binable, Byte, RemainingBytes, record, sequence, withValidation } from "./binable.ts";
import { Name, U32, vec, withByteLength } from "./immediate.ts";

export { NameSection, type NameMap, type IndirectNameMap };

type NameMap = Record<number, string>;
type IndirectNameMap = Record<number, NameMap>;

type NameSection = {
  module?: string;
  functions?: NameMap;
  locals?: IndirectNameMap;
  labels?: IndirectNameMap;
  types?: NameMap;
  tables?: NameMap;
  memories?: NameMap;
  globals?: NameMap;
  elements?: NameMap;
  data?: NameMap;
  fields?: IndirectNameMap;
  tags?: NameMap;
  unknown?: { id: number; data: number[] }[];
};

function indices(map: Record<number, unknown>) {
  // Keys that are array indices come in increasing order, so sorting is rarely needed.
  const keys = Object.keys(map);
  const indices: number[] = [];
  let sorted = true;
  for (let i = 0; i < keys.length; i++) {
    const index = Number(keys[i]);
    if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff || String(index) !== keys[i]) {
      throw Error(`invalid name index: ${keys[i]}`);
    }
    if (i > 0 && index < indices[i - 1]) sorted = false;
    indices.push(index);
  }
  if (!sorted) indices.sort((a, b) => a - b);
  return indices;
}

/**
 * Encode a numeric-keyed record as a Wasm vector of { index: u32, value } entries. Encoding sorts the keys; decoding requires unique, increasing indices.
 *
 * For example, indexed(Name) maps { 2: "add" } to [{ index: 2, value: "add" }]. Nesting it as indexed(indexed(Name)) represents local names grouped by function index.
 */
function indexed<T>(value: Binable<T>): Binable<Record<number, T>> {
  const entries = withValidation(vec(record({ index: U32, value })), (entries) => {
    let previous = -1;
    for (const { index } of entries) {
      if (index <= previous) throw Error("name indices must be unique and increasing");
      previous = index;
    }
  });
  return Binable({
    write(writer, map: Record<number, T>) {
      let keys = indices(map);
      writer.unsigned(keys.length);
      for (let index of keys) {
        writer.unsigned(index);
        value.write(writer, map[index]);
      }
    },
    readBytes(bytes, offset) {
      let [list, end] = entries.readBytes(bytes, offset);
      return [Object.fromEntries(list.map(({ index, value }) => [index, value])), end];
    },
  });
}

const NameMap = indexed(Name);
const IndirectNameMap = indexed(NameMap);
const subsections = [
  ["module", Name],
  ["functions", NameMap],
  ["locals", IndirectNameMap],
  ["labels", IndirectNameMap],
  ["types", NameMap],
  ["tables", NameMap],
  ["memories", NameMap],
  ["globals", NameMap],
  ["elements", NameMap],
  ["data", NameMap],
  ["fields", IndirectNameMap],
  ["tags", NameMap],
] as const;

const Subsection = record({ id: Byte, data: withByteLength(RemainingBytes) });
const Subsections = withValidation(sequence(Subsection), (sections) => {
  let previous = -1;
  for (const { id } of sections) {
    if (!Number.isInteger(id) || id < 0 || id > 255) throw Error("invalid name subsection id");
    if (id <= previous)
      throw Error("name subsections must be unique and increasing (no duplicates)");
    previous = id;
  }
});

// Payload only: the enclosing custom section supplies the "name" string.
function fromSubsections(sections: { id: number; data: number[] }[]): NameSection {
  const names: NameSection = {};
  for (const { id, data } of sections) {
    const subsection = subsections[id];
    if (subsection === undefined) {
      (names.unknown ??= []).push({ id, data });
    } else {
      const [key, codec] = subsection;
      const value = codec.fromBytes(data);
      // The subsection pairs each key with its codec; TS loses that correlation.
      (names as Record<typeof key, typeof value>)[key] = value;
    }
  }
  return names;
}

const NameSection = Binable<NameSection>({
  // Subsections are written in place, in the order of their ids; unknown ones come last.
  write(writer, names) {
    for (let id = 0; id < subsections.length; id++) {
      const [key, codec] = subsections[id];
      const value = names[key];
      if (value === undefined) continue;
      writer.byte(id);
      writer.withLength(() => (codec as Binable<any>).write(writer, value));
    }
    const unknown = [...(names.unknown ?? [])].sort((a, b) => a.id - b.id);
    let previous = -1;
    for (const { id, data } of unknown) {
      if (!Number.isInteger(id) || id < subsections.length || id > 255)
        throw Error(`invalid unknown name subsection id: ${id}`);
      if (id === previous)
        throw Error("name subsections must be unique and increasing (no duplicates)");
      previous = id;
      writer.byte(id);
      writer.unsigned(data.length);
      writer.bytes(data);
    }
  },
  readBytes(bytes, offset) {
    const [sections, end] = Subsections.readBytes(bytes, offset);
    return [fromSubsections(sections), end];
  },
});
