import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildDmSdkBorrowedHandleArtifacts,
  DMSDK_BORROWED_HANDLE_INPUT_PATHS,
  DMSDK_BORROWED_HANDLE_RECIPE_FACTS_PATH,
} from "../packages/compiler/src/dmsdk-borrowed-handle-output-emitter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = { outputRoot: root, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") options.check = true;
    else if (argv[index] === "--output-root") options.outputRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

async function loadInputs() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(DMSDK_BORROWED_HANDLE_INPUT_PATHS).map(async ([key, path]) => [
        key,
        await readFile(resolve(root, path), "utf8"),
      ]),
    ),
  );
}

async function writeOrCheck(outputRoot, path, content, check) {
  const destination = resolve(outputRoot, path);
  if (check) {
    if ((await readFile(destination, "utf8")) !== content) throw new Error(`${path} is stale`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

export async function build(inputs = undefined) {
  const result = buildDmSdkBorrowedHandleArtifacts(inputs ?? (await loadInputs()));
  result.artifacts.set(DMSDK_BORROWED_HANDLE_RECIPE_FACTS_PATH, `${JSON.stringify(result.recipe, null, 2)}\n`);
  return result;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await build();
  for (const [path, content] of result.artifacts) await writeOrCheck(options.outputRoot, path, content, options.check);
  process.stdout.write(
    `${options.check ? "Verified" : "Generated"} ${result.report.coverage.generated}/${result.report.coverage.candidates} borrowed-handle bindings; ${result.report.coverage.blocked} structurally blocked.\n`,
  );
  return result.report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
