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

#ifdef __cplusplus
extern "C" {
#endif

/// Register one AOT unit creator. Returns 1 when it was recorded, 0 when the
/// fixed table is full or the creator is null. Safe to call before `main`.
int deherm_register_static_unit(DehermStaticUnitCreator creator);

/// The registered creators in registration order. Never null; `*count` may be 0.
const DehermStaticUnitCreator* deherm_static_units(size_t* count);

#ifdef __cplusplus
}
#endif
