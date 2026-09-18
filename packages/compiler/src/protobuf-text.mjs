// Protobuf text-format reader for Defold resources.
//
// Defold stores every authored resource as protobuf text, so a resource's
// declared names are readable without the engine. Values keep their source
// line so a diagnostic can point at the declaration.

const STRING_PATTERN = /"(?:\\.|[^"\\])*"/y;
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_.]*/y;
const NUMBER_PATTERN = /-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/y;

function unescape(value) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") { out += value[index]; continue; }
    const escape = value[++index];
    if (escape === "n") out += "\n";
    else if (escape === "r") out += "\r";
    else if (escape === "t") out += "\t";
    else if (escape === "\\") out += "\\";
    else if (escape === "\"") out += "\"";
    else if (escape === "'") out += "'";
    else if (escape === "0") out += "\0";
    else if (escape === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(value.slice(index + 1))?.[0] ?? "";
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += hex.length;
    } else if (escape >= "0" && escape <= "7") {
      const octal = /^[0-7]{1,3}/.exec(value.slice(index))?.[0] ?? escape;
      out += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length - 1;
    } else out += escape;
  }
  return out;
}

class TextReader {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.line = 1;
  }

  skipTrivia() {
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === "\n") { this.line += 1; this.index += 1; continue; }
      if (character === " " || character === "\t" || character === "\r" || character === ",") { this.index += 1; continue; }
      if (character === "#") {
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index += 1;
        continue;
      }
      return;
    }
  }

  match(pattern) {
    pattern.lastIndex = this.index;
    const match = pattern.exec(this.source);
    if (!match) return null;
    this.index = pattern.lastIndex;
    for (const character of match[0]) if (character === "\n") this.line += 1;
    return match[0];
  }

  /** Read one value: a quoted string run, a brace message, or a bare token. */
  readValue(depth) {
    this.skipTrivia();
    const character = this.source[this.index];
    if (character === "{" || character === "<") {
      const close = character === "{" ? "}" : ">";
      this.index += 1;
      const message = this.readMessage(depth + 1, close);
      this.skipTrivia();
      if (this.source[this.index] === close) this.index += 1;
      return { kind: "message", message };
    }
    if (character === "\"") {
      let text = "";
      while (true) {
        this.skipTrivia();
        const literal = this.match(STRING_PATTERN);
        if (literal === null) break;
        text += unescape(literal.slice(1, -1));
        const save = this.index;
        const saveLine = this.line;
        this.skipTrivia();
        if (this.source[this.index] !== "\"") { this.index = save; this.line = saveLine; break; }
      }
      return { kind: "string", value: text };
    }
    if (character === "[") {
      let depthCount = 0;
      const values = [];
      do {
        const token = this.source[this.index];
        if (token === "[") depthCount += 1;
        else if (token === "]") depthCount -= 1;
        this.index += 1;
        if (token === "\n") this.line += 1;
      } while (this.index < this.source.length && depthCount > 0);
      return { kind: "list", values };
    }
    const number = this.match(NUMBER_PATTERN);
    if (number !== null) return { kind: "scalar", value: number };
    const identifier = this.match(IDENTIFIER_PATTERN);
    if (identifier !== null) return { kind: "scalar", value: identifier };
    this.index += 1;
    return { kind: "scalar", value: "" };
  }

  readMessage(depth, close) {
    const fields = [];
    if (depth > 64) return fields;
    while (true) {
      this.skipTrivia();
      if (this.index >= this.source.length) break;
      if (close && this.source[this.index] === close) break;
      const line = this.line;
      const name = this.match(IDENTIFIER_PATTERN);
      if (name === null) { this.index += 1; continue; }
      this.skipTrivia();
      if (this.source[this.index] === ":") this.index += 1;
      const value = this.readValue(depth);
      fields.push({ name, line, ...value });
    }
    return fields;
  }
}

/** Parse a protobuf text-format document into a flat, line-tagged field list. */
export function parseProtobufText(source) {
  return new TextReader(source).readMessage(0, null);
}

/** Every sub-message of `message` at the given dotted field path. */
export function messagesAt(message, fieldPath) {
  const [head, ...rest] = fieldPath.split(".");
  const matches = message.filter((field) => field.name === head && field.kind === "message");
  if (!rest.length) return matches;
  return matches.flatMap((field) => messagesAt(field.message, rest.join(".")));
}

/** First string value of `name` in `message`, with its source line. */
export function stringField(message, name) {
  const field = message.find((entry) => entry.name === name && entry.kind === "string");
  return field ? { value: field.value, line: field.line } : null;
}

/** First scalar (enum, number, bare token) value of `name` in `message`. */
export function scalarField(message, name) {
  const field = message.find((entry) => entry.name === name && (entry.kind === "scalar" || entry.kind === "string"));
  return field ? { value: field.value, line: field.line } : null;
}
