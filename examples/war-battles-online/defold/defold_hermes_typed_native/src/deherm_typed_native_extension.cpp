// Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
//
// Two jobs, both small.
//
// Defold requires every extension directory to declare an extension symbol
// named after itself - the engine's exported-symbol table references it - so
// this unit-carrying extension declares one.
//
// It also hands the emitted unit to `defold_hermes` through the static-unit
// registry. `AppInitialize` runs before any game code and long before the
// bundle is activated, which is the only ordering that matters: the registry is
// read when a Hermes runtime is constructed for the bundle. Declaring the unit
// here rather than editing `defold_hermes`'s sources is what keeps the shared
// extension identical across projects.
#define LIB_NAME "defold_hermes_typed_native"
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN LIB_NAME
#endif

#include <dmsdk/dlib/log.h>
#include <dmsdk/extension/extension.hpp>

#include <defold_hermes/static_unit_registry.h>

// Declared with C++ linkage to match the emitted unit, which `shermes` writes
// as an ordinary function and the assembler compiles as C++.
SHUnit* sh_export_deherm_typed_native(void);

namespace {

dmExtension::Result AppInitializeTypedNative(dmExtension::AppParams*) {
  if (!deherm_register_static_unit(sh_export_deherm_typed_native)) {
    dmLogError("deherm typed-native unit could not be registered; the static unit table is full");
    return dmExtension::RESULT_INIT_ERROR;
  }
  dmLogInfo("DEHERM_EVENT typed-native-unit-registered unit=sh_export_deherm_typed_native");
  return dmExtension::RESULT_OK;
}

dmExtension::Result AppFinalizeTypedNative(dmExtension::AppParams*) { return dmExtension::RESULT_OK; }
dmExtension::Result InitializeTypedNative(dmExtension::Params*) { return dmExtension::RESULT_OK; }
dmExtension::Result FinalizeTypedNative(dmExtension::Params*) { return dmExtension::RESULT_OK; }

}  // namespace

namespace deherm_typed_native_registration {
DM_DECLARE_EXTENSION(
    defold_hermes_typed_native,
    LIB_NAME,
    AppInitializeTypedNative,
    AppFinalizeTypedNative,
    InitializeTypedNative,
    0,
    0,
    FinalizeTypedNative)
}  // namespace deherm_typed_native_registration
