import { createContentLengthJsonTransport } from "../protocol/content-length-json.mjs";
import { createResourceSemanticIndex } from "./resource-semantics.mjs";

const methodNotFound = -32601;
const internalError = -32603;

function applyContentChanges(source, changes) {
  let text = source;
  for (const change of changes ?? []) {
    if (!change.range) {
      text = change.text;
      continue;
    }
    const offsets = [change.range.start, change.range.end].map((position) => {
      let offset = 0;
      let line = 0;
      while (line < position.line && offset < text.length) {
        const newline = text.indexOf("\n", offset);
        if (newline < 0) return text.length;
        offset = newline + 1;
        line += 1;
      }
      return Math.min(text.length, offset + position.character);
    });
    text = `${text.slice(0, offsets[0])}${change.text}${text.slice(offsets[1])}`;
  }
  return text;
}

/** Run the editor-neutral Defold semantic language server over stdio-like streams. */
export async function runLanguageServer({ projectRoot, input = process.stdin, output = process.stdout, semanticIndex } = {}) {
  const transport = createContentLengthJsonTransport(input, output, { protocol: "LSP" });
  const index = semanticIndex ?? createResourceSemanticIndex(projectRoot);
  const documents = new Map();
  let shutdown = false;
  let finished = false;

  return await new Promise((resolve, reject) => {
    const respond = (request, result) => {
      if (!finished) transport.send({ jsonrpc: "2.0", id: request.id, result });
    };
    const failRequest = (request, code, message) => {
      if (!finished) transport.send({ jsonrpc: "2.0", id: request.id, error: { code, message } });
    };
    const finish = (code) => {
      if (finished) return;
      finished = true;
      transport.close();
      resolve(code);
    };
    const document = (params) => documents.get(params?.textDocument?.uri);

    transport.on("error", (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    });
    transport.on("end", () => finish(shutdown ? 0 : 1));
    transport.on("message", async (message) => {
      try {
        const isRequest = Object.hasOwn(message, "id");
        switch (message.method) {
          case "initialize":
            respond(message, {
              capabilities: {
                textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
                completionProvider: { triggerCharacters: ['"', "'", "`", "#", "/", ":"] },
                hoverProvider: true,
                definitionProvider: true,
                workspace: { workspaceFolders: { supported: true, changeNotifications: false } }
              },
              serverInfo: { name: "deherm" }
            });
            return;
          case "initialized":
          case "$/setTrace":
          case "workspace/didChangeConfiguration":
            return;
          case "textDocument/didOpen":
            documents.set(message.params.textDocument.uri, {
              text: message.params.textDocument.text,
              version: message.params.textDocument.version
            });
            return;
          case "textDocument/didChange": {
            const current = document(message.params);
            if (current) documents.set(message.params.textDocument.uri, {
              text: applyContentChanges(current.text, message.params.contentChanges),
              version: message.params.textDocument.version
            });
            return;
          }
          case "textDocument/didClose":
            documents.delete(message.params.textDocument.uri);
            return;
          case "workspace/didChangeWatchedFiles":
            index.invalidate();
            return;
          case "textDocument/completion": {
            const current = document(message.params);
            respond(message, current ? await index.complete(message.params.textDocument.uri, current.text, message.params.position) : []);
            return;
          }
          case "textDocument/hover": {
            const current = document(message.params);
            respond(message, current ? await index.hover(message.params.textDocument.uri, current.text, message.params.position) : null);
            return;
          }
          case "textDocument/definition": {
            const current = document(message.params);
            respond(message, current ? await index.definition(message.params.textDocument.uri, current.text, message.params.position) : null);
            return;
          }
          case "shutdown":
            shutdown = true;
            respond(message, null);
            return;
          case "exit":
            finish(shutdown ? 0 : 1);
            return;
          default:
            if (isRequest) failRequest(message, methodNotFound, `Method not found: ${message.method}`);
        }
      } catch (error) {
        if (Object.hasOwn(message, "id")) failRequest(message, internalError, error instanceof Error ? error.message : String(error));
      }
    });
  });
}

export { applyContentChanges };
