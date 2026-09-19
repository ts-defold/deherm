#include <defold_hermes/static_unit_registry.h>

namespace {

// Bounded on purpose: a build materialises a known number of emitted units, so
// an unbounded list would only hide an assembler defect.
const size_t kMaximumStaticUnits = 16;

// Zero-initialised static storage with no dynamic initialiser, so a
// registration from a pre-`main` constructor cannot observe an unconstructed
// table regardless of translation-unit initialisation order.
DehermStaticUnitCreator gStaticUnits[kMaximumStaticUnits];
size_t gStaticUnitCount;

}  // namespace

extern "C" int deherm_register_static_unit(DehermStaticUnitCreator creator) {
  if (!creator || gStaticUnitCount >= kMaximumStaticUnits) return 0;
  gStaticUnits[gStaticUnitCount++] = creator;
  return 1;
}

extern "C" const DehermStaticUnitCreator* deherm_static_units(size_t* count) {
  if (count) *count = gStaticUnitCount;
  return gStaticUnits;
}
