const ARRAY_TAG = -1;

/** Losslessly encode JSON as interned strings, object shapes, and values. */
export function encodePolicyObject(value) {
  const strings = [];
  const stringIndices = new Map();
  const shapes = [];
  const shapeIndices = new Map();
  const encode = (current) => {
    if (typeof current === "string") {
      let index = stringIndices.get(current);
      if (index === undefined) {
        index = strings.length;
        strings.push(current);
        stringIndices.set(current, index);
      }
      return -index - 1;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Policy recipe facts may contain only finite numbers");
      return current < 0 ? `!${JSON.stringify(current)}` : current;
    }
    if (Array.isArray(current)) return [ARRAY_TAG, ...current.map(encode)];
    if (current && typeof current === "object") {
      const keys = Object.keys(current);
      const signature = JSON.stringify(keys);
      let shape = shapeIndices.get(signature);
      if (shape === undefined) {
        shape = shapes.length;
        shapes.push(keys);
        shapeIndices.set(signature, shape);
      }
      return [shape, ...keys.map((key) => encode(current[key]))];
    }
    if (current === null || typeof current === "boolean") return current;
    throw new Error(`Policy recipe facts cannot encode ${typeof current}`);
  };
  return { strings, shapes, root: encode(value) };
}

/** Reconstruct JSON while restoring source property order exactly. */
export function decodePolicyObject(facts, label = "Policy recipe") {
  if (!facts || !Array.isArray(facts.strings) || !Array.isArray(facts.shapes) || !Array.isArray(facts.root)) {
    throw new Error(`${label} facts are malformed`);
  }
  if (
    facts.strings.some((value) => typeof value !== "string") ||
    facts.shapes.some(
      (shape) => !Array.isArray(shape) || shape.some((key) => typeof key !== "string" || key.length === 0),
    )
  ) {
    throw new Error(`${label} dictionaries are malformed`);
  }
  const decode = (encoded) => {
    if (typeof encoded === "number") {
      if (!Number.isInteger(encoded)) return encoded;
      if (encoded >= 0) return encoded;
      const value = facts.strings[-encoded - 1];
      if (value === undefined) throw new Error(`${label} string index is out of range: ${encoded}`);
      return value;
    }
    if (typeof encoded === "string") {
      if (!/^!-(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(encoded)) {
        throw new Error(`${label} contains an invalid numeric escape`);
      }
      return Number(encoded.slice(1));
    }
    if (encoded === null || typeof encoded === "boolean") return encoded;
    if (!Array.isArray(encoded) || encoded.length === 0 || !Number.isInteger(encoded[0])) {
      throw new Error(`${label} contains an invalid node`);
    }
    if (encoded[0] === ARRAY_TAG) return encoded.slice(1).map(decode);
    const shape = facts.shapes[encoded[0]];
    if (!shape || encoded.length !== shape.length + 1) throw new Error(`${label} shape is invalid: ${encoded[0]}`);
    return Object.fromEntries(shape.map((key, index) => [key, decode(encoded[index + 1])]));
  };
  return decode(facts.root);
}
