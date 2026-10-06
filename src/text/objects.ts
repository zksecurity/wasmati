import * as C from "../codec.ts";
import type { GlobalType as GlobalTypeValue, RefType } from "../types.ts";
import { Instructions, label } from "./instructions.ts";
import { Name, U32, type Expression } from "./text.ts";
import {
  form,
  Index,
  isIndex,
  optional,
  record,
  repeated,
  token,
  ValueType,
  type IndexValue,
  word,
} from "./grammar.ts";
import { TextSyntaxError, UnsupportedTextError } from "./lexer.ts";

export { Memory, Global, Table };

const Exports = repeated(form("export", token(Name)), "export");
const Limits = record({ min: token(U32), max: optional(token(U32), isIndex) });
const MemoryFields = record({ name: label, exports: Exports, limits: Limits });
const Memory: typeof MemoryFields = {
  ...MemoryFields,
  decode(input, offset) {
    if (input.slice(offset).some((node) => word(node) === "i64" || word(node) === "shared")) {
      throw new UnsupportedTextError("memory64 and shared-memory text syntax is not implemented");
    }
    return MemoryFields.decode(input, offset);
  },
};
const mutable = C.iso(form("mut", ValueType), {
  to: (type: GlobalTypeValue) => type.value,
  from: (value) => ({ value, mutable: true }),
});
const immutable = C.iso(ValueType, {
  to: (type: GlobalTypeValue) => type.value,
  from: (value) => ({ value, mutable: false }),
});
const GlobalType = C.or<[GlobalTypeValue, GlobalTypeValue], Expression>(
  [mutable, immutable],
  (type) => (type.mutable ? 0 : 1),
);
const Global = record({ name: label, exports: Exports, type: GlobalType, init: Instructions });
const ReferenceType = C.withValidation(ValueType, (type) => {
  if (type !== "funcref" && type !== "externref")
    throw new TextSyntaxError("expected reference type");
}) as C.Codec<RefType, Expression>;

type Storage = {
  limits: { min: number; max: number | undefined };
  type: RefType;
  init?: IndexValue[];
};
const explicit = record({ limits: Limits, type: ReferenceType });
const inline = record({ type: ReferenceType, init: form("elem", C.sequence(Index)) });
const Storage: C.Codec<Storage, Expression> = {
  encode(storage) {
    return storage.init === undefined
      ? explicit.encode(storage)
      : inline.encode({ type: storage.type, init: storage.init });
  },
  decode(input, offset) {
    if (isIndex(input[offset])) return explicit.decode(input, offset);
    const [value, end] = inline.decode(input, offset);
    return [{ ...value, limits: { min: value.init.length, max: value.init.length } }, end];
  },
};
const Table = record({ name: label, exports: Exports, storage: Storage });
