// Which lines of a header are live, for a given macro assignment.
//
// The dmSDK is a header SDK, and a handful of its headers declare different
// things - or the same things over different types - depending on the platform
// being compiled for. Answering "which declarations does this target actually
// get" by compiling for that target would need that target's own system
// headers; answering it from the header's own preprocessor structure needs only
// the macro assignment, which Defold itself declares in
// `share/extender/build_input.yml`.
//
// Two rules make the answer trustworthy rather than plausible:
//
//   * **An unknown name is unresolved, never zero.** C says an identifier that
//     survives macro expansion in a `#if` evaluates to 0, which is exactly the
//     assumption that would silently answer "this branch is dead" for every
//     macro we simply did not model. A name the assignment does not decide
//     makes the whole condition unresolved, and an unresolved condition makes
//     every line it controls unresolved for that target rather than absent.
//   * **Anything the grammar does not cover is unresolved too.** Arithmetic,
//     character constants, `__has_include`, an unbalanced directive: each one
//     is reported with a reason instead of being approximated.
//
// This is a `#if` expression evaluator and a directive nesting walk. It is not
// a preprocessor: it does not expand object-like macros inside expressions
// beyond one substitution level, and it does not follow `#include`.

const DIRECTIVE = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif|define|undef)\b[ \t]*(.*)$/;

class Unresolved extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// ── The `#if` expression grammar ────────────────────────────────────────────

const PUNCTUATION = [
  "&&", "||", "==", "!=", "<=", ">=", "<<", ">>", "(", ")", "!", "<", ">", "+", "-", "*", "/", "%", "~", "&", "|", "^", "?", ":", ","
];

export function tokenizeExpression(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_]\w*/.exec(text.slice(index));
      tokens.push({ kind: "name", value: match[0] });
      index += match[0].length;
      continue;
    }
    if (/[0-9]/.test(character)) {
      const match = /^0[xX][0-9a-fA-F]+[uUlL]*|^[0-9]+[uUlL]*/.exec(text.slice(index));
      if (!match) throw new Unresolved(`unparsable numeric literal at "${text.slice(index, index + 12)}"`);
      tokens.push({ kind: "number", value: Number(BigInt(match[0].replace(/[uUlL]+$/, ""))) });
      index += match[0].length;
      continue;
    }
    if (character === "'" || character === '"') {
      throw new Unresolved("character or string literal in a conditional expression");
    }
    const punctuation = PUNCTUATION.find((candidate) => text.startsWith(candidate, index));
    if (!punctuation) throw new Unresolved(`unsupported token "${character}"`);
    tokens.push({ kind: "punctuation", value: punctuation });
    index += punctuation.length;
  }
  return tokens;
}

/**
 * Evaluate one `#if` expression under a macro assignment.
 *
 * @param {string} expression
 * @param {object} environment
 * @param {Map<string, string>} environment.defined  macro name to its replacement text
 * @param {Set<string>} [environment.builtinQueries] function-like queries that answer 1 (`__has_builtin`)
 * @returns {{value: boolean} | {unresolved: string}}
 */
export function evaluateCondition(expression, environment) {
  const defined = environment.defined ?? new Map();
  const builtinQueries = environment.builtinQueries ?? new Set();
  let tokens;
  try {
    tokens = tokenizeExpression(expression);
  } catch (error) {
    if (error instanceof Unresolved) return { unresolved: error.reason };
    throw error;
  }
  if (tokens.length === 0) return { unresolved: "empty conditional expression" };

  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const accept = (value) => {
    if (peek()?.kind === "punctuation" && peek().value === value) { position += 1; return true; }
    return false;
  };
  const expect = (value) => {
    if (!accept(value)) throw new Unresolved(`expected "${value}"`);
  };

  // One substitution level: `#if DM_ENDIAN == DM_ENDIAN_LITTLE` needs both
  // names replaced by what the header `#define`d them to. Deeper nesting, and
  // function-like macros other than the declared queries, are unresolved.
  const substitute = (name, depth) => {
    if (depth > 8) throw new Unresolved(`macro substitution for ${name} did not terminate`);
    const replacement = defined.get(name);
    if (replacement === undefined) throw new Unresolved(`${name} is not decided by this macro assignment`);
    const text = String(replacement).trim();
    if (text === "") return 1;
    const integer = /^([+-]?(?:0[xX][0-9a-fA-F]+|\d+))[uUlL]*$/.exec(text);
    if (integer) return Number(integer[1]);
    if (/^[A-Za-z_]\w*$/.test(text)) return substitute(text, depth + 1);
    throw new Unresolved(`${name} expands to "${text}", which is not an integer this evaluator decides`);
  };

  const primary = () => {
    const token = take();
    if (token === undefined) throw new Unresolved("conditional expression ended early");
    if (token.kind === "number") return token.value;
    if (token.kind === "punctuation") {
      if (token.value === "(") { const value = ternary(); expect(")"); return value; }
      if (token.value === "!") return primary() ? 0 : 1;
      if (token.value === "-") return -primary();
      if (token.value === "+") return primary();
      if (token.value === "~") return ~primary();
      throw new Unresolved(`unsupported operator "${token.value}"`);
    }
    if (token.value === "defined") {
      const parenthesised = accept("(");
      const name = take();
      if (name?.kind !== "name") throw new Unresolved("defined() without a macro name");
      if (parenthesised) expect(")");
      // A function-like query the toolchain provides - `__has_builtin` - is
      // itself `defined`, and headers test exactly that before using it.
      return defined.has(name.value) || builtinQueries.has(name.value) ? 1 : 0;
    }
    if (peek()?.kind === "punctuation" && peek().value === "(") {
      if (!builtinQueries.has(token.value)) {
        throw new Unresolved(`${token.value}() is not a query this macro assignment decides`);
      }
      // A declared query answers 1 for whatever it is asked about. Which
      // builtins a toolchain has is a property of that toolchain, and the
      // assignment declares the toolchain.
      let depth = 0;
      do {
        const next = take();
        if (next === undefined) throw new Unresolved(`${token.value}() is unterminated`);
        if (next.kind === "punctuation" && next.value === "(") depth += 1;
        if (next.kind === "punctuation" && next.value === ")") depth -= 1;
      } while (depth > 0);
      return 1;
    }
    return substitute(token.value, 0);
  };

  const binary = (next, operators) => () => {
    let left = next();
    for (;;) {
      const token = peek();
      if (token?.kind !== "punctuation" || !operators.includes(token.value)) return left;
      take();
      const right = next();
      switch (token.value) {
        case "*": left = left * right; break;
        case "/": if (right === 0) throw new Unresolved("division by zero"); left = Math.trunc(left / right); break;
        case "%": if (right === 0) throw new Unresolved("modulo by zero"); left = left % right; break;
        case "+": left = left + right; break;
        case "-": left = left - right; break;
        case "<<": left = left << right; break;
        case ">>": left = left >> right; break;
        case "<": left = left < right ? 1 : 0; break;
        case ">": left = left > right ? 1 : 0; break;
        case "<=": left = left <= right ? 1 : 0; break;
        case ">=": left = left >= right ? 1 : 0; break;
        case "==": left = left === right ? 1 : 0; break;
        case "!=": left = left !== right ? 1 : 0; break;
        case "&": left = left & right; break;
        case "^": left = left ^ right; break;
        case "|": left = left | right; break;
        case "&&": left = left && right ? 1 : 0; break;
        case "||": left = left || right ? 1 : 0; break;
        default: throw new Unresolved(`unsupported operator "${token.value}"`);
      }
    }
  };

  const multiplicative = binary(primary, ["*", "/", "%"]);
  const additive = binary(multiplicative, ["+", "-"]);
  const shift = binary(additive, ["<<", ">>"]);
  const relational = binary(shift, ["<", ">", "<=", ">="]);
  const equality = binary(relational, ["==", "!="]);
  const bitAnd = binary(equality, ["&"]);
  const bitXor = binary(bitAnd, ["^"]);
  const bitOr = binary(bitXor, ["|"]);
  // `&&` and `||` do not short-circuit here on purpose: an unresolved operand
  // is reported even when the other operand would have decided the result, so
  // a partially modelled assignment never looks complete.
  const logicalAnd = binary(bitOr, ["&&"]);
  const logicalOr = binary(logicalAnd, ["||"]);
  const ternary = () => {
    const condition = logicalOr();
    if (!accept("?")) return condition;
    const whenTrue = ternary();
    expect(":");
    const whenFalse = ternary();
    return condition ? whenTrue : whenFalse;
  };

  try {
    const value = ternary();
    if (position !== tokens.length) return { unresolved: "trailing tokens in conditional expression" };
    return { value: value !== 0 };
  } catch (error) {
    if (error instanceof Unresolved) return { unresolved: error.reason };
    throw error;
  }
}

// ── Directive structure ─────────────────────────────────────────────────────

/**
 * Every conditional branch in a source file, with the line range it controls.
 *
 * A branch is one arm of one `#if` group: the `#if` itself, each `#elif`, and
 * the `#else`, whose condition is "none of the preceding arms". Branches nest,
 * and `parent` is the index of the branch a branch sits inside. Arms of the
 * same group share a `group` number, which is what lets a caller ask "is this
 * declaration also declared in the arm the other targets take?" - the
 * difference between an API a target does not have and one it spells
 * differently.
 */
export function readConditionalBranches(source) {
  const lines = source.split(/\r?\n/);
  const branches = [];
  const stack = [];
  const problems = [];
  const defines = new Map();

  let groups = 0;
  const open = (kind, expression, line) => {
    const parent = stack.length ? stack.at(-1).branch : null;
    const branch = branches.length;
    const group = groups++;
    branches.push({ index: branch, kind, expression, line, endLine: lines.length, parent, group, siblings: [] });
    stack.push({ arms: [branch], branch, group });
  };
  const arm = (kind, expression, line) => {
    const frame = stack.at(-1);
    if (!frame) { problems.push({ line, problem: `#${kind} without #if` }); return; }
    branches[frame.branch].endLine = line - 1;
    const parent = branches[frame.branch].parent;
    const branch = branches.length;
    branches.push({
      index: branch, kind, expression, line, endLine: lines.length, parent,
      group: frame.group, siblings: [...frame.arms]
    });
    frame.arms.push(branch);
    frame.branch = branch;
  };

  lines.forEach((text, offset) => {
    const line = offset + 1;
    const match = DIRECTIVE.exec(text);
    if (!match) return;
    const [, kind, rest] = match;
    const expression = rest.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "").trim();
    switch (kind) {
      case "if": open("if", expression, line); break;
      case "ifdef": open("if", `defined(${expression.split(/\s+/)[0] ?? ""})`, line); break;
      case "ifndef": open("if", `!defined(${expression.split(/\s+/)[0] ?? ""})`, line); break;
      case "elif": arm("elif", expression, line); break;
      case "elifdef": arm("elif", `defined(${expression.split(/\s+/)[0] ?? ""})`, line); break;
      case "elifndef": arm("elif", `!defined(${expression.split(/\s+/)[0] ?? ""})`, line); break;
      case "else": arm("else", null, line); break;
      case "endif": {
        const frame = stack.pop();
        if (!frame) { problems.push({ line, problem: "#endif without #if" }); break; }
        branches[frame.branch].endLine = line - 1;
        break;
      }
      case "define": {
        const name = /^([A-Za-z_]\w*)(?:\([^)]*\))?\s*(.*)$/.exec(expression);
        if (name) defines.set(name[1], name[2] ?? "");
        break;
      }
      case "undef": {
        defines.delete(expression.split(/\s+/)[0] ?? "");
        break;
      }
      default: break;
    }
  });
  for (const frame of stack) problems.push({ line: branches[frame.branch].line, problem: "#if without #endif" });
  return { lineCount: lines.length, branches, problems, defines };
}

/**
 * Decide, for one macro assignment, which lines of a source file are live.
 *
 * @returns {{live: (line: number) => boolean, unresolved: (line: number) => string|null, branchStates: object[]}}
 */
export function resolveBranches(structure, environment) {
  const states = structure.branches.map((branch) => {
    if (branch.kind === "else") return { branch: branch.index, selected: null, unresolved: null };
    const result = evaluateCondition(branch.expression ?? "", environment);
    return {
      branch: branch.index,
      selected: result.unresolved === undefined ? result.value : null,
      unresolved: result.unresolved ?? null
    };
  });
  // An `#else` is taken when every preceding arm is decidedly false, is not
  // taken when one of them is decidedly true, and is unresolved when any of
  // them is unresolved.
  for (const branch of structure.branches) {
    if (branch.kind !== "else") continue;
    const state = states[branch.index];
    const priors = branch.siblings.map((index) => states[index]);
    if (priors.some((prior) => prior.selected === true)) state.selected = false;
    else if (priors.some((prior) => prior.unresolved !== null)) {
      state.unresolved = `an earlier arm of this group is unresolved: ${priors.find((prior) => prior.unresolved)?.unresolved}`;
    } else state.selected = true;
  }
  // An `#elif`/`#else` also requires every preceding arm to be false; an
  // `#elif` whose own condition is true is still not taken if an earlier arm was.
  for (const branch of structure.branches) {
    if (branch.kind !== "elif") continue;
    const state = states[branch.index];
    const priors = branch.siblings.map((index) => states[index]);
    if (priors.some((prior) => prior.selected === true)) { state.selected = false; state.unresolved = null; }
    else if (state.selected !== false && priors.some((prior) => prior.unresolved !== null)) {
      state.unresolved = state.unresolved
        ?? `an earlier arm of this group is unresolved: ${priors.find((prior) => prior.unresolved)?.unresolved}`;
      state.selected = null;
    }
  }

  const containing = (line) => {
    const enclosing = [];
    for (const branch of structure.branches) {
      if (line >= branch.line && line <= branch.endLine) enclosing.push(branch);
    }
    return enclosing;
  };

  return {
    branchStates: states,
    live(line) {
      return containing(line).every((branch) => states[branch.index].selected === true);
    },
    unresolved(line) {
      for (const branch of containing(line)) {
        const state = states[branch.index];
        if (state.selected === false) return null;
        if (state.unresolved) return state.unresolved;
      }
      return null;
    }
  };
}
