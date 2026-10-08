export { toJSONValue, fromJSONValue, type JSONValue };

type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

/**
 * Plain JS data as JSON. Values that JSON can't hold become tagged objects: bigints
 * `{ $bigint: "123" }`, bytes `{ $bytes: "00ff" }` in hex, and numbers that are not finite, or -0,
 * `{ $number: "Infinity" }`. Properties that are undefined are left out.
 */
function toJSONValue(value: unknown): JSONValue {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return { $number: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (value instanceof Uint8Array) {
    let hex = "";
    for (let i = 0; i < value.length; i++) hex += value[i].toString(16).padStart(2, "0");
    return { $bytes: hex };
  }
  if (Array.isArray(value)) return value.map(toJSONValue);
  if (typeof value === "object" && value !== null) {
    let object: { [key: string]: JSONValue } = {};
    for (let [key, entry] of Object.entries(value)) {
      if (entry !== undefined) object[key] = toJSONValue(entry);
    }
    return object;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  throw Error(`toJSON: can't represent ${typeof value} as JSON`);
}

/** The plain JS data that `toJSONValue()` turned into JSON. */
function fromJSONValue(value: JSONValue): unknown {
  if (Array.isArray(value)) return value.map(fromJSONValue);
  if (typeof value !== "object" || value === null) return value;
  let keys = Object.keys(value);
  if (keys.length === 1) {
    let tagged = value[keys[0]];
    if (keys[0] === "$bigint" && typeof tagged === "string") return BigInt(tagged);
    if (keys[0] === "$number" && typeof tagged === "string") return Number(tagged);
    if (keys[0] === "$bytes" && typeof tagged === "string") {
      let bytes = new Uint8Array(tagged.length / 2);
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(tagged.slice(2 * i, 2 * i + 2), 16);
      return bytes;
    }
  }
  let object: { [key: string]: unknown } = {};
  for (let key of keys) object[key] = fromJSONValue(value[key]);
  return object;
}
