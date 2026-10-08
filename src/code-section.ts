import { RemainingBytes, record } from "./binable.ts";
import { Locals } from "./func.ts";
import { withByteLength } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import { Expression } from "./instruction/binable.ts";
import type { ValueType } from "./types.ts";

export { CodeEntry, FunctionCode, type Code };

/** A function's code: its locals and body. */
type Code = { locals: ValueType[]; body: ResolvedInstruction[] };

/** The encoding of a function's code, which is an entry of the code section. */
const FunctionCode = record<Code>({ locals: Locals, body: Expression });

/** An entry of the code section: a function's encoded code, with its length. */
const CodeEntry = withByteLength(RemainingBytes);
