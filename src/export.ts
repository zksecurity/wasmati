import { Binable, byteEnum, record } from "./binable.js";
import { Name, U32 } from "./immediate.js";
import {
  FunctionType,
  Type,
  GlobalType,
  JSValue,
  MemoryType,
  TableType,
  TypeIndex,
  ValueType,
  valueTypeLiteral,
  valueTypeLiterals,
} from "./types.js";
import { ToTypeTuple } from "./func.js";
import { Tuple } from "./util.js";
import * as Dependency from "./dependency.js";
import { ImportFunc } from "./func-types.js";

export { Export, Import, ExternType, importFunc, importGlobal };

type ExternType =
  | { kind: "function"; value: FunctionType }
  | { kind: "table"; value: TableType }
  | { kind: "memory"; value: MemoryType }
  | { kind: "global"; value: GlobalType<ValueType> };

type ExportDescription = {
  kind: "function" | "table" | "memory" | "global";
  value: U32;
};
const ExportDescription: Binable<ExportDescription> = byteEnum<{
  0x00: { kind: "function"; value: U32 };
  0x01: { kind: "table"; value: U32 };
  0x02: { kind: "memory"; value: U32 };
  0x03: { kind: "global"; value: U32 };
}>({
  0x00: { kind: "function", value: U32 },
  0x01: { kind: "table", value: U32 },
  0x02: { kind: "memory", value: U32 },
  0x03: { kind: "global", value: U32 },
});

type Export = { name: string; description: ExportDescription };
const Export = record({ name: Name, description: ExportDescription });

type ImportDescription =
  | { kind: "function"; value: TypeIndex }
  | { kind: "table"; value: TableType }
  | { kind: "memory"; value: MemoryType }
  | { kind: "global"; value: GlobalType<ValueType> };
const ImportDescription: Binable<ImportDescription> = byteEnum<{
  0x00: { kind: "function"; value: TypeIndex };
  0x01: { kind: "table"; value: TableType };
  0x02: { kind: "memory"; value: MemoryType };
  0x03: { kind: "global"; value: GlobalType<ValueType> };
}>({
  0x00: { kind: "function", value: TypeIndex },
  0x01: { kind: "table", value: TableType },
  0x02: { kind: "memory", value: MemoryType },
  0x03: { kind: "global", value: GlobalType },
});

type Import = {
  module: string;
  name: string;
  description: ImportDescription;
};
const Import = record<Import>({
  module: Name,
  name: Name,
  description: ImportDescription,
});

function importFunc<
  const Args extends Tuple<ValueType>,
  const Results extends Tuple<ValueType>
>(
  {
    in: args_,
    out: results_,
  }: {
    in: ToTypeTuple<Args>;
    out: ToTypeTuple<Results>;
  },
  run: Function
): ImportFunc<Args, Results> {
  let args = valueTypeLiterals<Args>(args_);
  let results = valueTypeLiterals<Results>(results_);
  let type = { args, results };
  return { kind: "importFunction", type, deps: [], value: run };
}

function importGlobal<V extends ValueType>(
  type: Type<V>,
  value: JSValue<V>,
  { mutable = false } = {}
): Dependency.ImportGlobal<V> {
  let globalType = { value: valueTypeLiteral(type), mutable };
  let valueType: WebAssembly.ValueType =
    type.kind === "funcref" ? "anyfunc" : type.kind;
  let value_ = new WebAssembly.Global({ value: valueType, mutable }, value);
  return { kind: "importGlobal", type: globalType, deps: [], value: value_ };
}
