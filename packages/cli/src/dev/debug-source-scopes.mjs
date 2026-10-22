import { readFile } from "node:fs/promises";

import { API } from "typescript/unstable/sync";
import {
  isBindingPattern,
  isBlock,
  isCatchClause,
  isClassDeclaration,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isSourceFile,
  isVariableStatement,
} from "typescript/unstable/ast/is";

function bindingNames(name, result = []) {
  if (isIdentifier(name)) result.push(name.text);
  else if (isBindingPattern(name)) {
    for (const element of name.elements) if (element.name) bindingNames(element.name, result);
  }
  return result;
}

function statementNames(statement) {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
  }
  if ((isFunctionDeclaration(statement) || isClassDeclaration(statement)) && statement.name) {
    return bindingNames(statement.name);
  }
  return [];
}

function containingPath(sourceFile, position) {
  const path = [];
  function visit(node) {
    if (position < node.getStart(sourceFile) || position >= node.end) return;
    path.push(node);
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return path;
}

function namesBefore(statements, position) {
  return statements.flatMap((statement) => (statement.getStart() <= position ? statementNames(statement) : []));
}

function unique(names) {
  return [...new Set(names)];
}

/**
 * Return candidate identifiers, never values. Hermes evaluates each identifier
 * in the paused frame, so optimized-away and not-yet-initialized bindings are
 * omitted rather than being fabricated from source text.
 */
export async function authoredFrameScopes({ sourcePath, sourceText, line, column }) {
  if (!sourcePath?.endsWith(".ts") || typeof sourceText !== "string") return null;
  // A source-map snapshot describes the executing bundle. Do not parse a file
  // that has since been edited, including an HMR build still in flight.
  if ((await readFile(sourcePath, "utf8")) !== sourceText) return null;

  const api = new API();
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openFiles: [sourcePath] });
    const project = snapshot.getDefaultProjectForFile(sourcePath);
    const sourceFile = project?.program.getSourceFile(sourcePath);
    if (!sourceFile || !isSourceFile(sourceFile) || sourceFile.getFullText() !== sourceText) return null;
    if (project.program.getSyntacticDiagnostics(sourcePath).length) return null;
    const position = sourceFile.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, column - 1));
    const path = containingPath(sourceFile, position);
    const activeFunctionIndex = path.findLastIndex(isFunctionLikeDeclaration);
    if (activeFunctionIndex < 0) return null;
    const activeFunction = path[activeFunctionIndex];
    const argumentsInScope = unique(activeFunction.parameters.flatMap((parameter) => bindingNames(parameter.name)));
    const locals = [];
    for (const node of path.slice(activeFunctionIndex + 1)) {
      if (isBlock(node)) locals.push(...namesBefore([...node.statements], position));
      if (isCatchClause(node) && node.variableDeclaration) {
        locals.push(...bindingNames(node.variableDeclaration.name));
      }
    }
    const localNames = unique(locals).filter((name) => !argumentsInScope.includes(name));
    const moduleNames = unique(sourceFile.statements.flatMap(statementNames)).filter(
      (name) => !argumentsInScope.includes(name) && !localNames.includes(name),
    );
    return { arguments: argumentsInScope, locals: localNames, module: moduleNames };
  } finally {
    snapshot?.close?.();
    api.close();
  }
}
