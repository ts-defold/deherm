#pragma once

#if !defined(DM_PLATFORM_HTML5)
#include <jsi/jsi.h>
#include <memory>

namespace defold_hermes {

class ScriptJsiBridgeLifetime;

/** Installs the single stable-ID script bridge used by every generated SDK wrapper. */
std::shared_ptr<ScriptJsiBridgeLifetime> installScriptJsiBridge(
    facebook::jsi::Runtime& runtime);

/**
 * Invalidates every retained JavaScript callback while its owning JSI runtime
 * is still alive. Runtime owners must call this explicitly before destroying
 * the JSI runtime; the operation is idempotent.
 */
void shutdownScriptJsiBridge(
    const std::shared_ptr<ScriptJsiBridgeLifetime>& lifetime) noexcept;

}  // namespace defold_hermes
#endif
