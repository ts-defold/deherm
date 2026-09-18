// The operator console is authored declaratively in TSX against the
// @rezi-ui/jsx runtime. Node resolves .mjs directly but has no JSX transform,
// so the console registers this synchronous module hook before importing its
// own view modules. esbuild is already a first-class dependency of the
// compiler pipeline, so no new toolchain enters the published package.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { transformSync } from "esbuild";

let registered = false;

export function registerTsxLoader() {
  if (registered) return;
  registered = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
      const file = fileURLToPath(url);
      const { code } = transformSync(readFileSync(file, "utf8"), {
        loader: "tsx",
        format: "esm",
        target: "node22",
        jsx: "automatic",
        jsxImportSource: "@rezi-ui/jsx",
        sourcefile: file,
        sourcemap: "inline"
      });
      return { format: "module", shortCircuit: true, source: code };
    }
  });
}

registerTsxLoader();
