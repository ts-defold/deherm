// Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
//
// The extension Bob uploads is project-specific: a build materialises the
// emitted C and, with it, the build-time switches that C was assembled under.
// Extender has no equivalent of a CMake option, and `ext.manifest` defines are
// per-extension rather than per-build, so the switch travels as a generated
// header every instrumented translation unit already reaches through
// `deherm_profile.hpp`.
//
// Assembled with telemetry ON. Every generated dispatcher and the JSI bridge
// open a transport span, and the extension update drains the producer ring into
// a per-route census on stdout. This is the instrument that says which
// transport a call actually took; it is off in the shipped skeleton.
//
// The guard keeps the two build systems from fighting over one switch: this
// checkout's CMake build always defines `DEHERM_PROFILE_BUILD_SYSTEM`, so its
// own `DEHERM_PROFILE` option stays the only authority there, and this header
// governs only the packaged extension that Bob and Extender compile.
#pragma once

#if !defined(DEHERM_PROFILE_BUILD_SYSTEM) && !defined(DEHERM_PROFILE)
#define DEHERM_PROFILE 1
#endif
