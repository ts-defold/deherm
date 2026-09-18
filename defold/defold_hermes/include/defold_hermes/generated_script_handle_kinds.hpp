#pragma once
#include <cstdint>

namespace defold_hermes::script_handle_lowering {
inline constexpr const char* kSemanticHandleKindNames[] = {
  nullptr,
  "box2d-body",
  "box2d-chain",
  "box2d-joint",
  "box2d-shape",
  "box2d-world",
  "buffer-data",
  "buffer-stream",
  "bullet-constraint",
  "bullet-object",
  "bullet-shape",
  "bullet-world",
  "graphics-render-target",
  "graphics-texture",
  "gui-node",
  "render-constant-buffer",
};
inline constexpr uint8_t kSemanticHandleKindNameCount = 15;
inline const char* semanticHandleKindName(uint8_t kind) noexcept {
  return kind > 0 && kind <= kSemanticHandleKindNameCount ? kSemanticHandleKindNames[kind] : nullptr;
}
}  // namespace defold_hermes::script_handle_lowering
