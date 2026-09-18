#include <dmsdk/dlib/log.h>
#include <dmsdk/dlib/profile.h>
#include <dmsdk/graphics/graphics.h>

namespace
{
    using VoidFunction = void (*)();

    // These address-takes deliberately produce unresolved symbol references in
    // the object file. The audit test verifies that every blocked declaration is
    // present with the expected native signature without executing destructive
    // process-global lifecycle operations.
    VoidFunction const kBlockedLifecycleSymbols[] = {
        &dmGraphics::Finalize,
        &dmLog::LogFinalize,
        &dmLogFinalize,
        &ProfileInitialize,
        &ProfileFinalize,
    };
}

static_assert(sizeof(kBlockedLifecycleSymbols) / sizeof(kBlockedLifecycleSymbols[0]) == 5,
              "all lifecycle-policy blockers must remain represented");

extern "C" const void* deherm_dmsdk_blocked_lifecycle_symbol_table()
{
    return kBlockedLifecycleSymbols;
}
