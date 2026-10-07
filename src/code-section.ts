import { Binable, record } from "./binable.ts";
import { encodeWithOffsets } from "./branch-hints.ts";
import { Locals } from "./func.ts";
import { withByteLength } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import { Expression } from "./instruction/binable.ts";
import type { ValueType } from "./types.ts";

export { CodeEntry, withEncodedBody, encodedHints, type Code };

/** A function's code: its locals and body. */
type Code = { locals: ValueType[]; body: ResolvedInstruction[] };

type Encoded = { bytes: Uint8Array; hints: { offset: number; likely: boolean }[] };

/** Functions of modules built here, with their code already encoded, with locals. */
const encodings = new WeakMap<object, Encoded>();

const DecodedEntry = withByteLength(record({ locals: Locals, body: Expression }));

/** An entry of the code section, which functions with an encoding write as is. */
const CodeEntry = Binable<Code>({
  write(writer, code) {
    let encoded = encodings.get(code);
    if (encoded === undefined) return DecodedEntry.write(writer, code);
    writer.unsigned(encoded.bytes.length);
    writer.bytes(encoded.bytes);
  },
  readBytes: DecodedEntry.readBytes,
});

/** Branch hints of a function's encoding, by their offset from its locals; none if not encoded. */
function encodedHints(code: Code): Encoded["hints"] | undefined {
  return encodings.get(code)?.hints;
}

/**
 * A function whose body is given by its encoding, with locals, and its branch hints. The body is
 * decoded where it is read; from then on, the function is encoded from its body, which may change.
 */
function withEncodedBody<F extends { locals: ValueType[] }>(
  func: F,
  bytes: Uint8Array,
  hints: Encoded["hints"],
): F & { body: ResolvedInstruction[] } {
  encodings.set(func, { bytes, hints });
  let set = (body: ResolvedInstruction[]) => {
    encodings.delete(func);
    Object.defineProperty(func, "body", {
      value: body,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  Object.defineProperty(func, "body", {
    get() {
      let body = decodeBody(bytes, hints);
      set(body);
      return body;
    },
    set,
    enumerable: true,
    configurable: true,
  });
  return func as F & { body: ResolvedInstruction[] };
}

function decodeBody(bytes: Uint8Array, hints: Encoded["hints"]): ResolvedInstruction[] {
  let [locals, offset] = Locals.readBytes(bytes as unknown as number[], 0);
  let [body] = Expression.readBytes(bytes as unknown as number[], offset);
  if (hints.length > 0) {
    let instructions = new Map(
      encodeWithOffsets({ locals, body }, () => true).offsets.map(([instruction, offset]) => [
        offset,
        instruction,
      ]),
    );
    for (let { offset, likely } of hints) instructions.get(offset)!.likely = likely;
  }
  return body;
}
