import {
  type DefinedType,
  type FieldType,
  type FunctionType,
  type HeapType,
  referencedTypes,
  refType,
  type StorageType,
  type TypeDefinition,
  type ValueType,
  typeKey,
} from "./types.ts";

export { TypeRegistry };

/**
 * The types of a module under construction. Defined types are added with their recursion group,
 * after the groups they refer to, and equivalent groups are added once.
 */
class TypeRegistry {
  /** Type definitions, which refer to other types by index. */
  types: TypeDefinition[] = [];
  /** Sizes of the recursion groups, in order. */
  groups: number[] = [];
  /** Names of types and of struct fields, by type index. */
  names: Record<number, string> = {};
  fieldNames: Record<number, Record<number, string>> = {};
  private indices = new Map<string, number>();

  /** The index of a defined type, adding its recursion group if needed. */
  index(type: DefinedType): number {
    let known = this.indices.get(typeKey(type));
    if (known !== undefined) return known;
    let group = type.group ?? [type];
    // A type may refer to earlier groups and to its own group only.
    for (let member of group)
      for (let referenced of referencedTypes(member.type))
        if (!group.includes(referenced)) this.index(referenced);
    let start = this.types.length;
    group.forEach((member, i) => this.indices.set(typeKey(member), start + i));
    group.forEach((member, i) => {
      this.types.push(this.definition(member.type));
      if (member.name !== undefined) this.names[start + i] = member.name;
      if (member.fieldNames !== undefined)
        this.fieldNames[start + i] = Object.fromEntries(member.fieldNames.entries());
    });
    this.groups.push(group.length);
    return this.indices.get(typeKey(type))!;
  }

  /** The index of a function type described by its signature, which forms a group of its own. */
  function(type: FunctionType): number {
    return this.index({ kind: "type", type, deps: referencedTypes(type) });
  }

  heap(heap: HeapType): HeapType {
    return typeof heap === "object" ? this.index(heap) : heap;
  }

  value<T extends StorageType>(type: T): T {
    if (typeof type !== "object" || typeof type.ref !== "object") return type;
    return refType(this.index(type.ref), type.nullable) as T;
  }

  signature({ args, results }: FunctionType): FunctionType {
    return { args: args.map((t) => this.value(t)), results: results.map((t) => this.value(t)) };
  }

  private definition(type: TypeDefinition): TypeDefinition {
    let field = ({ type, mutable }: FieldType) => ({ type: this.value(type), mutable });
    let { final, supertype } = type;
    let composite =
      "struct" in type
        ? { struct: type.struct.map(field) }
        : "array" in type
          ? { array: field(type.array) }
          : this.signature(type);
    return {
      ...composite,
      ...(final === false ? { final } : {}),
      ...(supertype === undefined ? {} : { supertype: this.heap(supertype) as number }),
    };
  }

  /**
   * An immediate with defined types replaced by their indices: heap types of null references, tests
   * and casts, value types of typed selects, and block types.
   */
  immediate(name: string, immediate: any): unknown {
    if (name === "ref.null" || name.startsWith("ref.test") || name.startsWith("ref.cast"))
      return this.heap(immediate);
    if (name === "br_on_cast" || name === "br_on_cast_fail") {
      let { from, to } = immediate;
      return { ...immediate, from: this.value(from), to: this.value(to) };
    }
    if (name === "select_t") return immediate.map((t: StorageType) => this.value(t));
    if (name === "blocktype")
      return typeof immediate === "object" ? this.value(immediate) : immediate;
    return immediate;
  }
}
