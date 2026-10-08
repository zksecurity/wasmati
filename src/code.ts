import { Writer } from "./binable.ts";
import type * as Dependency from "./dependency.ts";

export { Code, type Linker, type Immediate, link };

/**
 * How an immediate that refers to other definitions is written, once their indices are known: from the
 * indices of its dependencies and further arguments. Instructions are such immediates, and so are block
 * types and catch clauses.
 */
type Immediate = {
  string: string;
  immediate: { write(writer: Writer, value: any): void } | undefined;
  resolve: (deps: number[], ...args: any) => any;
};

/** An immediate that Module() writes, where it knows the indices of the immediate's dependencies. */
type Hole = { position: number; immediate: Immediate; deps: Dependency.t[]; args: unknown[] };

/** Where Module() finds indices: of dependencies, and of the defined types in immediates. */
type Linker = {
  index(dep: Dependency.t): number;
  /** The immediate with defined types replaced by their indices. */
  types(name: string, immediate: unknown): unknown;
};

/**
 * Code under construction: the encoding of a function body or constant expression, without its final
 * `end`. Immediates that refer to other definitions by index are holes, which Module() fills in.
 * Positions are byte offsets in the code.
 */
class Code extends Writer {
  holes: Hole[] = [];
  /** Branch hints, at the position of their instruction. */
  hints: { position: number; likely: boolean }[] = [];

  hole(immediate: Immediate, deps: Dependency.t[], args: unknown[]) {
    this.holes.push({ position: this.length, immediate, deps, args });
  }
}

/**
 * Write code with its holes filled in, and return the offsets of its branch hints from `start`, by
 * default where the writer is.
 */
function link(
  code: Code,
  writer: Writer,
  linker: Linker,
  start = writer.length,
): { offset: number; likely: boolean }[] {
  let { buffer, holes, hints } = code;
  let offsets: { offset: number; likely: boolean }[] = [];
  let from = 0;
  let h = 0;
  // Hints before `until`, which lie in the code that is copied next, from `from`.
  let hintsBefore = (until: number) => {
    for (; h < hints.length && hints[h].position < until; h++) {
      let { position, likely } = hints[h];
      offsets.push({ offset: writer.length - start + position - from, likely });
    }
  };
  for (let { position, immediate, deps, args } of holes) {
    // A hint at a hole's position is of the instruction after the hole's immediate.
    hintsBefore(position);
    writer.copy(buffer, from, position);
    from = position;
    let indices = deps.map((dep) => linker.index(dep));
    let value = linker.types(immediate.string, immediate.resolve(indices, ...args));
    immediate.immediate!.write(writer, value);
  }
  hintsBefore(Infinity);
  writer.copy(buffer, from, code.length);
  return offsets;
}
