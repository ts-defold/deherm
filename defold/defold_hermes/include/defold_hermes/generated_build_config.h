// Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
//
// The extension Bob uploads is project-specific: a build materialises the
// emitted C and, with it, the build-time switches that C was assembled under.
// Extender has no equivalent of a CMake option, and `ext.manifest` defines are
// per-extension rather than per-build, so the switch travels as a generated
// header every instrumented translation unit already reaches through
// `deherm_profile.hpp`.
//
// This is the skeleton the package ships: it defines nothing, so an unassembled
// extension compiles exactly as it did before the seam existed.
#pragma once
