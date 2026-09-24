import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("the Static Hermes registry separates one application from bounded auxiliary units", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "deherm-static-unit-registry-"));
  const source = path.join(output, "main.cpp");
  const executable = path.join(output, "registry");
  await writeFile(source, String.raw`
#include <defold_hermes/static_unit_registry.h>

#include <cstdint>

struct SHUnit {};
SHUnit* auxiliaryA() { return reinterpret_cast<SHUnit*>(static_cast<uintptr_t>(1)); }
SHUnit* auxiliaryB() { return reinterpret_cast<SHUnit*>(static_cast<uintptr_t>(2)); }
SHUnit* application() { return reinterpret_cast<SHUnit*>(static_cast<uintptr_t>(3)); }
#define EXTRA(N) SHUnit* extra##N() { return reinterpret_cast<SHUnit*>(static_cast<uintptr_t>(4 + N)); }
EXTRA(0) EXTRA(1) EXTRA(2) EXTRA(3) EXTRA(4) EXTRA(5) EXTRA(6)
EXTRA(7) EXTRA(8) EXTRA(9) EXTRA(10) EXTRA(11) EXTRA(12) EXTRA(13)

int main() {
  size_t count = 99;
  if (deherm_static_application() != nullptr) return 1;
  if (deherm_static_units(&count) == nullptr || count != 0) return 2;
  if (!deherm_register_static_unit(auxiliaryA)) return 3;
  if (!deherm_register_static_unit(auxiliaryB)) return 4;
  if (!deherm_register_static_unit(auxiliaryA)) return 5;
  if (!deherm_register_static_application(application)) return 6;
  if (!deherm_register_static_application(application)) return 7;
  if (deherm_register_static_application(extra0)) return 8;
  if (deherm_register_static_unit(application)) return 9;
  const DehermStaticUnitCreator* units = deherm_static_units(&count);
  if (count != 2 || units[0] != auxiliaryA || units[1] != auxiliaryB) return 10;
  if (deherm_static_application() != application) return 11;
  // One application plus fifteen auxiliaries is the complete fixed table.
  DehermStaticUnitCreator extras[] = {
    extra0, extra1, extra2, extra3, extra4, extra5, extra6,
    extra7, extra8, extra9, extra10, extra11, extra12
  };
  for (DehermStaticUnitCreator creator : extras) {
    if (!deherm_register_static_unit(creator)) return 12;
  }
  if (deherm_register_static_unit(extra13)) return 13;
  units = deherm_static_units(&count);
  if (count != DEHERM_MAX_STATIC_UNITS - 1 || units[count - 1] != extra12) return 14;
  return 0;
}
`);
  try {
    execFileSync(process.env.CXX ?? "clang++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
      `-I${path.join(repositoryRoot, "defold/defold_hermes/include")}`,
      path.join(repositoryRoot, "defold/defold_hermes/src/static_unit_registry.cpp"),
      source,
      "-o", executable
    ], { cwd: repositoryRoot, stdio: "pipe" });
    execFileSync(executable, [], { stdio: "pipe" });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
