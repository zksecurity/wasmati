import { Binable, Byte, RemainingBytes, iso, record, sequence, withValidation } from "./binable.ts";
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
  const indices = Object.keys(map)
    .map(Number)
    .sort((a, b) => a - b);
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff || !(String(index) in map)) {
      throw Error(`invalid name index: ${index}`);
    }
  }
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
const NameSection = iso(Subsections, {
  to(names: NameSection) {
    const sections: { id: number; data: number[] }[] = [];
    for (const [id, [key, codec]] of subsections.entries()) {
      const value = names[key];
      // Bytes, which the subsection's codec writes as they are.
      if (value !== undefined)
        sections.push({ id, data: (codec as Binable<any>).encode(value) as unknown as number[] });
    }
    for (const section of names.unknown ?? []) {
      if (!Number.isInteger(section.id) || section.id < subsections.length || section.id > 255) {
        throw Error(`invalid unknown name subsection id: ${section.id}`);
      }
      sections.push(section);
    }
    sections.sort((a, b) => a.id - b.id);
    return sections;
  },
  from(sections): NameSection {
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
  },
});
