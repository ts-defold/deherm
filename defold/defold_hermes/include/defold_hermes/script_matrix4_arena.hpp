#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include <defold_hermes/script_bridge_capi.hpp>

namespace defold_hermes {

/**
 * Fixed-capacity, allocation-free Matrix4 storage for one ScriptCallFrame.
 *
 * Elements use Defold/dmVMath's canonical column-major order:
 *   [m00,m10,m20,m30,m01,...,m33].
 * ScriptValue::data binds a token to this exact arena and payload contains the
 * slot generation and index. Both must match before a matrix is dereferenced.
 */
struct alignas(16) ScriptMatrix4Arena {
  static constexpr uint32_t kCapacity = 16;

  struct alignas(16) Slot {
    float elements[16]{};
    uint32_t generation = 1;
  };

  Slot slots[kCapacity]{};
  uint32_t used = 0;

  bool store(const float* columnMajor, ScriptValue* output) noexcept {
    if (!columnMajor || !output || used >= kCapacity) return false;
    const uint32_t index = used++;
    Slot& slot = slots[index];
    bump(slot.generation);
    std::memcpy(slot.elements, columnMajor, sizeof(slot.elements));
    *output = {};
    output->tag = ScriptValueTag::kDefoldValue;
    output->defoldKind = ScriptDefoldValueKind::kMatrix4;
    output->payload = (static_cast<uint64_t>(slot.generation) << 32u) | index;
    output->data = &slot;
    return true;
  }

  const float* resolve(const ScriptValue& value) const noexcept {
    if (value.tag != ScriptValueTag::kDefoldValue ||
        value.defoldKind != ScriptDefoldValueKind::kMatrix4) return nullptr;
    const uint32_t index = static_cast<uint32_t>(value.payload);
    const uint32_t generation = static_cast<uint32_t>(value.payload >> 32u);
    if (index >= used || index >= kCapacity) return nullptr;
    const Slot& slot = slots[index];
    if (value.data != &slot || generation == 0 || generation != slot.generation) return nullptr;
    return slot.elements;
  }

  void rewind(uint32_t mark) noexcept {
    if (mark > used) return;
    for (uint32_t index = mark; index < used; ++index) bump(slots[index].generation);
    used = mark;
  }

 private:
  static void bump(uint32_t& generation) noexcept {
    ++generation;
    if (generation == 0) ++generation;
  }
};

/** Nested/reentrant-safe arena checkpoint. Tokens allocated after it go stale on unwind. */
class ScriptMatrix4ArenaMark {
 public:
  explicit ScriptMatrix4ArenaMark(ScriptMatrix4Arena& arena) noexcept
      : arena_(&arena), mark_(arena.used) {}
  ScriptMatrix4ArenaMark(const ScriptMatrix4ArenaMark&) = delete;
  ScriptMatrix4ArenaMark& operator=(const ScriptMatrix4ArenaMark&) = delete;
  ~ScriptMatrix4ArenaMark() { if (arena_) arena_->rewind(mark_); }
  uint32_t mark() const noexcept { return mark_; }

 private:
  ScriptMatrix4Arena* arena_ = nullptr;
  uint32_t mark_ = 0;
};

}  // namespace defold_hermes
