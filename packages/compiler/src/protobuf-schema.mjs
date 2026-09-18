// Minimal protobuf *definition* reader.
//
// This exists to read Defold's pinned `.proto` sources structurally. It is not
// a general protobuf compiler: it recovers package, java options, message
// nesting, and field declarations (label, type, name, number, options), which
// is exactly what the resource declaration schema is derived from.

const FIELD_LABELS = new Set(["required", "optional", "repeated"]);

function stripComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\"" || character === "'") {
      const quote = character;
      out += character;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") { out += source[index] + (source[index + 1] ?? ""); index += 2; continue; }
        out += source[index];
        index += 1;
        if (source[index - 1] === quote) break;
      }
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      out += " ";
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

function tokenize(source) {
  const tokens = [];
  const pattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_.]*|-?\d+(?:\.\d+)?|[{}()\[\];=,<>]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) tokens.push(match[0]);
  return tokens;
}

function unquote(token) {
  if (token.length >= 2 && (token[0] === "\"" || token[0] === "'")) {
    return token.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("\\'", "'").replaceAll("\\\\", "\\");
  }
  return token;
}

class Reader {
  constructor(tokens) { this.tokens = tokens; this.index = 0; }
  get done() { return this.index >= this.tokens.length; }
  peek(offset = 0) { return this.tokens[this.index + offset]; }
  next() { return this.tokens[this.index++]; }
  expect(token) {
    const value = this.next();
    if (value !== token) throw new Error(`expected ${JSON.stringify(token)}, received ${JSON.stringify(value ?? "<end>")}`);
    return value;
  }
  skipBalanced(open, close) {
    this.expect(open);
    let depth = 1;
    while (!this.done && depth > 0) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }
  skipStatement() {
    let depth = 0;
    while (!this.done) {
      const token = this.next();
      if (token === "{" || token === "[" || token === "(") depth += 1;
      else if (token === "}" || token === "]" || token === ")") depth -= 1;
      else if (token === ";" && depth <= 0) return;
      if (depth < 0) return;
    }
  }
}

function readFieldOptions(reader) {
  const options = Object.create(null);
  if (reader.peek() !== "[") return options;
  reader.expect("[");
  while (!reader.done && reader.peek() !== "]") {
    let name;
    if (reader.peek() === "(") {
      reader.expect("(");
      name = reader.next();
      reader.expect(")");
    } else {
      name = reader.next();
    }
    let value = true;
    if (reader.peek() === "=") {
      reader.expect("=");
      if (reader.peek() === "{") { reader.skipBalanced("{", "}"); value = null; }
      else value = unquote(reader.next());
    }
    options[name] = value === "true" ? true : value === "false" ? false : value;
    if (reader.peek() === ",") reader.expect(",");
  }
  reader.expect("]");
  return options;
}

function readMessageBody(reader, message) {
  reader.expect("{");
  while (!reader.done && reader.peek() !== "}") {
    const token = reader.peek();
    if (token === ";") { reader.next(); continue; }
    if (token === "message") {
      reader.next();
      const name = reader.next();
      const nested = { name, fields: [], messages: [], enums: [] };
      readMessageBody(reader, nested);
      message.messages.push(nested);
      continue;
    }
    if (token === "enum") {
      reader.next();
      const name = reader.next();
      reader.skipBalanced("{", "}");
      message.enums.push({ name });
      continue;
    }
    if (token === "oneof") {
      reader.next();
      reader.next();
      const group = { name: "", fields: [], messages: [], enums: [] };
      readMessageBody(reader, group);
      for (const field of group.fields) message.fields.push({ ...field, label: "optional", oneof: true });
      message.messages.push(...group.messages);
      message.enums.push(...group.enums);
      continue;
    }
    if (token === "option" || token === "extensions" || token === "reserved" || token === "extend") {
      reader.next();
      if (token === "extend") { reader.next(); reader.skipBalanced("{", "}"); continue; }
      if (reader.peek() === "(") { reader.skipBalanced("(", ")"); }
      reader.skipStatement();
      continue;
    }
    let label = "optional";
    if (FIELD_LABELS.has(token)) label = reader.next();
    let type = reader.next();
    if (type === "map" && reader.peek() === "<") {
      reader.skipBalanced("<", ">");
      type = "map";
    }
    const name = reader.next();
    reader.expect("=");
    const number = Number(reader.next());
    const options = readFieldOptions(reader);
    if (reader.peek() === ";") reader.next();
    message.fields.push({ label, type, name, number, options });
  }
  reader.expect("}");
  return message;
}

/** Parse one `.proto` source into a dependency-free schema description. */
export function parseProtoSource(source, file = "<proto>") {
  const reader = new Reader(tokenize(stripComments(source)));
  const result = { file, package: "", options: Object.create(null), messages: [], enums: [] };
  try {
    while (!reader.done) {
      const token = reader.peek();
      if (token === ";") { reader.next(); continue; }
      if (token === "syntax" || token === "import") { reader.next(); reader.skipStatement(); continue; }
      if (token === "package") { reader.next(); result.package = reader.next(); reader.skipStatement(); continue; }
      if (token === "option") {
        reader.next();
        let name = reader.next();
        if (name === "(") { name = reader.next(); reader.expect(")"); }
        if (reader.peek() === "=") {
          reader.expect("=");
          result.options[name] = unquote(reader.next());
        }
        reader.skipStatement();
        continue;
      }
      if (token === "message") {
        reader.next();
        const name = reader.next();
        result.messages.push(readMessageBody(reader, { name, fields: [], messages: [], enums: [] }));
        continue;
      }
      if (token === "enum") { reader.next(); const name = reader.next(); reader.skipBalanced("{", "}"); result.enums.push({ name }); continue; }
      if (token === "extend") { reader.next(); reader.next(); reader.skipBalanced("{", "}"); continue; }
      if (token === "service") { reader.next(); reader.next(); reader.skipBalanced("{", "}"); continue; }
      reader.next();
    }
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  return result;
}

/** Index every message in a parsed file by its fully qualified and simple names. */
export function indexProtoMessages(parsed) {
  const index = new Map();
  function visit(message, prefix) {
    const qualified = prefix ? `${prefix}.${message.name}` : message.name;
    index.set(qualified, message);
    for (const nested of message.messages) visit(nested, qualified);
  }
  for (const message of parsed.messages) visit(message, parsed.package);
  return index;
}
