import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { generateScriptBindingDescriptors } from "../packages/compiler/src/script-binding-descriptor-generator.mjs";
import { renderScriptBindingDescriptorJson } from "../packages/compiler/src/script-binding-descriptor-output-emitter.mjs";

export { generateScriptBindingDescriptors };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const check = argv.includes("--check");
  const root = new URL("../", import.meta.url);
  const irUrl = new URL("packages/bindings/generated/defold-script-api-ir.json", root);
  const patternUrl = new URL("packages/bindings/generated/defold-script-binding-patterns.json", root);
  const jsonUrl = new URL("packages/bindings/generated/defold-script-binding-descriptors.json", root);
  const headerUrl = new URL(
    "defold/defold_hermes/include/defold_hermes/generated_script_binding_descriptors.hpp",
    root,
  );
  const [irText, patternText] = await Promise.all([readFile(irUrl, "utf8"), readFile(patternUrl, "utf8")]);
  assert(sha256(irText) === JSON.parse(patternText).sourceSha256, "Pattern report is stale relative to the script IR");
  const { artifact, header } = generateScriptBindingDescriptors(JSON.parse(irText), JSON.parse(patternText));
  const json = renderScriptBindingDescriptorJson(artifact);
  if (check) {
    const [existingJson, existingHeader] = await Promise.all([readFile(jsonUrl, "utf8"), readFile(headerUrl, "utf8")]);
    assert(existingJson === json, `${jsonUrl.pathname} is stale; regenerate script binding descriptors`);
    assert(existingHeader === header, `${headerUrl.pathname} is stale; regenerate script binding descriptors`);
  } else {
    await Promise.all([writeFile(jsonUrl, json), writeFile(headerUrl, header)]);
  }
  console.log(
    `${check ? "Verified" : "Generated"} ${artifact.bindingCount} script binding descriptors (${artifact.parameterSlotCount} parameters, ${artifact.returnSlotCount} returns)`,
  );
  console.log(`Descriptor ABI: ${artifact.descriptorAbiSha256}; executable coverage claimed: no`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
