import { Binable, record } from "./binable.ts";
import { Locals } from "./func.ts";
import { withByteLength } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import { Expression } from "./instruction/binable.ts";
import type { ValueType } from "./types.ts";

export { CodeEntry, encodedHints, type Code, type EncodedCode };

/** A function's code: its locals and body. */
type Code = { locals: ValueType[]; body: ResolvedInstruction[] };

/**
 * A function's code that is encoded already: its locals and body, and the offsets of its branch
 * hints from the locals. Modules built here encode their functions while they build them.
 */
type EncodedCode = { encoded: { bytes: Uint8Array; hints: { offset: number; likely: boolean }[] } };

const DecodedEntry = withByteLength(record({ locals: Locals, body: Expression }));

/** An entry of the code section. Decoding gives locals and body; encoded code is written as is. */
const CodeEntry = Binable<Code | EncodedCode>({
  write(writer, code) {
    if (!("encoded" in code)) return DecodedEntry.write(writer, code);
    writer.unsigned(code.encoded.bytes.length);
    writer.bytes(code.encoded.bytes);
  },
  readBytes: DecodedEntry.readBytes,
});

/** Branch hints of encoded code, by their offset from the locals; undefined for other code. */
function encodedHints(code: Code | EncodedCode) {
  return "encoded" in code ? code.encoded.hints : undefined;
}
