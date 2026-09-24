#include <defold_hermes/static_unit_registry.h>

namespace {

// Bounded on purpose: a build materialises a known number of emitted units, so
// an unbounded list would only hide an assembler defect.
// Zero-initialised static storage with no dynamic initialiser, so a
// registration from a pre-`main` constructor cannot observe an unconstructed
// table regardless of translation-unit initialisation order.
DehermStaticUnitCreator gStaticUnits[DEHERM_MAX_STATIC_UNITS];
size_t gStaticUnitCount;
DehermStaticUnitCreator gStaticApplication;

bool ContainsAuxiliary(DehermStaticUnitCreator creator) {
  for (size_t index = 0; index < gStaticUnitCount; ++index) {
    if (gStaticUnits[index] == creator) return true;
  }
  return false;
}

bool HasCapacity() {
  return gStaticUnitCount + (gStaticApplication ? 1u : 0u) <
      DEHERM_MAX_STATIC_UNITS;
}

}  // namespace

extern "C" int deherm_register_static_unit(DehermStaticUnitCreator creator) {
  if (!creator || gStaticApplication == creator) return 0;
  // Defold may run AppInitialize more than once during an in-process engine
  // reboot. Re-registering the same creator in the same role is therefore a
  // successful no-op, while cross-role aliases still fail closed.
  if (ContainsAuxiliary(creator)) return 1;
  if (!HasCapacity()) return 0;
  gStaticUnits[gStaticUnitCount++] = creator;
  return 1;
}

extern "C" int deherm_register_static_application(
    DehermStaticUnitCreator creator) {
  if (!creator || ContainsAuxiliary(creator)) return 0;
  if (gStaticApplication == creator) return 1;
  if (gStaticApplication || !HasCapacity()) return 0;
  gStaticApplication = creator;
  return 1;
}

extern "C" const DehermStaticUnitCreator* deherm_static_units(size_t* count) {
  if (count) *count = gStaticUnitCount;
  return gStaticUnits;
}

extern "C" DehermStaticUnitCreator deherm_static_application(void) {
  return gStaticApplication;
}
