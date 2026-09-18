#pragma once

#if !defined(DM_PLATFORM_HTML5)
#include <jsi/jsi.h>

namespace defold_hermes {

/** Installs the single stable-ID script bridge used by every generated SDK wrapper. */
void installScriptJsiBridge(facebook::jsi::Runtime& runtime);

}  // namespace defold_hermes
#endif
