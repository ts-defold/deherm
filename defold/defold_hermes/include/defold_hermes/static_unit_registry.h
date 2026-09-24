// Registry of AOT (`shermes -emit-c`) units contributed by sibling extensions.
//
// `shermes` emits C, and Extender compiles a `.c` source only when the
// extension carrying it asks for the C language front end, which is a
// per-extension setting. The emitted units therefore arrive as their own
// materialised extension rather than inside this one, and they announce
// themselves here from a pre-`main` constructor instead of being named by a
// hand-edited source list.
//
// The table is plain zero-initialised static storage with no dynamic
// initialiser, so a registration that runs before any other static constructor
// is still well defined. With no units registered the behaviour is exactly the
// bytecode-over-JSI behaviour that existed before this seam.
//
// This header is C-compatible on purpose: the registering translation unit is
// the emitted C unit itself.
#pragma once

#include <stddef.h>

struct SHUnit;

typedef struct SHUnit* (*DehermStaticUnitCreator)(void);

// One bounded table owns both auxiliary transport units and the optional
// application unit. Keeping the capacity in the C contract lets the extension
// stage the complete ordered unit list on its stack without allocating.
#define DEHERM_MAX_STATIC_UNITS 16

#ifdef __cplusplus
extern "C" {
#endif

/// Register one AOT unit creator. Repeating the same auxiliary creator is an
/// idempotent success. Returns 0 when the fixed table is full, the creator is
/// null, or the creator already owns the application role. Safe before `main`.
int deherm_register_static_unit(DehermStaticUnitCreator creator);

/// Register the one AOT application unit. Auxiliary units are evaluated first,
/// then this unit is evaluated last and supplies __defoldAppV1 and/or
/// __defoldComponentsV1. Repeating the selected application creator is an
/// idempotent success. Returns 0 for null, conflicting, second-application, or
/// over-capacity registration. Safe to call before `main`.
int deherm_register_static_application(DehermStaticUnitCreator creator);

/// The registered creators in registration order. Never null; `*count` may be 0.
const DehermStaticUnitCreator* deherm_static_units(size_t* count);

/// The registered application creator, or null when this build uses a Dynamic
/// Hermes application bundle beside auxiliary AOT transport units.
DehermStaticUnitCreator deherm_static_application(void);

#ifdef __cplusplus
}
#endif
