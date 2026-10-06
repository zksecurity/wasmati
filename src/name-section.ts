import { Binable } from "./binable.ts";
import { Name, U32 } from "./immediate.ts";

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

// Bound framing reads before delegating the actual LEB128 decoding to U32.
export function readU32(bytes: number[], offset: number): [number, number] {
  for (let i = 0; i < 5; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) throw Error("truncated u32");
    if (i === 4 && byte > 0x0f) throw Error("u32 out of range");
    if ((byte & 0x80) === 0) return U32.readBytes(bytes, offset);
  }
  throw Error("u32 out of range");
}

function indices(map: Record<number, unknown>) {
  const indices = Object.keys(map).map(Number).sort((a, b) => a - b);
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff || !(String(index) in map)) {
      throw Error(`invalid name index: ${index}`);
    }
  }
  return indices;
}

function indexed<T>(value: Binable<T>): Binable<Record<number, T>> {
  return Binable({
    toBytes(map) {
      const keys = indices(map);
      return [...U32.toBytes(keys.length), ...keys.flatMap((index) => [
        ...U32.toBytes(index), ...value.toBytes(map[index]),
      ])];
    },
    readBytes(bytes, offset) {
      let count: number;
      [count, offset] = readU32(bytes, offset);
      if (count > bytes.length - offset) throw Error("truncated name map");
      const map: Record<number, T> = {};
      let previous = -1;
      for (let i = 0; i < count; i++) {
        let index: number, entry: T;
        [index, offset] = readU32(bytes, offset);
        if (index <= previous) throw Error("name indices must be unique and increasing");
        [entry, offset] = value.readBytes(bytes, offset);
        if (offset > bytes.length) throw Error("truncated name map");
        map[index] = entry;
        previous = index;
      }
      return [map, offset];
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

// Payload only: the enclosing custom section supplies the "name" string.
const NameSection = Binable<NameSection>({
  toBytes(names) {
    const sections: { id: number; data: number[] }[] = [];
    for (const [id, [key, codec]] of subsections.entries()) {
      const value = names[key];
      if (value !== undefined) sections.push({ id, data: (codec as Binable<any>).toBytes(value) });
    }
    for (const section of names.unknown ?? []) {
      if (!Number.isInteger(section.id) || section.id < subsections.length || section.id > 255) {
        throw Error(`invalid unknown name subsection id: ${section.id}`);
      }
      sections.push(section);
    }
    sections.sort((a, b) => a.id - b.id);
    let previous = -1;
    return sections.flatMap(({ id, data }) => {
      if (id <= previous) throw Error("duplicate name subsection");
      previous = id;
      return [id, ...U32.toBytes(data.length), ...data];
    });
  },
  readBytes(bytes, offset) {
    const names: NameSection = {};
    let previous = -1;
    while (offset < bytes.length) {
      const id = bytes[offset++]!;
      let size: number;
      [size, offset] = readU32(bytes, offset);
      const end = offset + size;
      if (end > bytes.length) throw Error("truncated name subsection");
      if (id <= previous) throw Error("name subsections must be unique and increasing");
      previous = id;
      const data = bytes.slice(offset, end);
      const subsection = subsections[id];
      if (subsection === undefined) {
        (names.unknown ??= []).push({ id, data });
      } else {
        const [key, codec] = subsection;
        const [value, consumed] = codec.readBytes(data, 0);
        if (consumed !== data.length) throw Error("invalid name subsection size");
        Object.assign(names, { [key]: value });
      }
      offset = end;
    }
    return [names, offset];
  },
});
