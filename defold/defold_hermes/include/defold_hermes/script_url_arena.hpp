#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include <defold_hermes/script_bridge_capi.hpp>

namespace defold_hermes {

enum class ScriptAddressRepresentation : uint8_t {
  kInvalid = 0,
  kFullUrl,
  kStringShorthand,
  kHashShorthand,
};

/** Exact fixed-width copy of dmMessage::URL. Never narrow these lanes to JS Number. */
struct ScriptResolvedUrl {
  uint64_t socket;
  uint64_t reserved;
  uint64_t path;
  uint64_t fragment;
};

static_assert(sizeof(ScriptResolvedUrl) == 32, "Defold URL sidecar must retain all four 64-bit lanes");
static_assert(std::is_trivial_v<ScriptResolvedUrl> && std::is_standard_layout_v<ScriptResolvedUrl>,
  "Defold URL sidecar values must remain POD");

/**
 * Fixed-capacity, per-call storage for complete Defold URLs.
 *
 * A URL ScriptValue is valid only when all of these agree: runtime token,
 * slot index, slot generation, slot pointer, and this arena. A legacy kUrl
 * value that carries only one uint64_t has no slot pointer and therefore fails
 * closed. Strings and hashes are deliberately not stored here: the Lua adapter
 * must leave those values distinct so dmScript::ResolveURL can apply caller
 * context exactly as Defold does.
 */
template <uint32_t Capacity = 32>
class ScriptUrlArena {
 public:
  static_assert(Capacity > 0, "URL arena needs at least one slot");
  static constexpr uint32_t kCapacity = Capacity;

  struct Slot {
    ScriptResolvedUrl value{};
    uint32_t generation = 1;
  };

  class Mark {
   public:
    Mark() = default;
    uint32_t index() const noexcept { return index_; }

   private:
    friend class ScriptUrlArena;
    Mark(const ScriptUrlArena* owner, uint32_t index, uint32_t runtimeToken) noexcept
        : owner_(owner), index_(index), runtimeToken_(runtimeToken) {}
    const ScriptUrlArena* owner_ = nullptr;
    uint32_t index_ = 0;
    uint32_t runtimeToken_ = 0;
  };

  class Frame {
   public:
    explicit Frame(ScriptUrlArena& arena) noexcept : arena_(&arena), mark_(arena.mark()) {}
    Frame(const Frame&) = delete;
    Frame& operator=(const Frame&) = delete;
    ~Frame() { if (arena_) arena_->rewind(mark_); }
    Mark mark() const noexcept { return mark_; }

   private:
    ScriptUrlArena* arena_ = nullptr;
    Mark mark_{};
  };

  ScriptUrlArena() noexcept = default;
  explicit ScriptUrlArena(uint32_t runtimeToken) noexcept : runtimeToken_(runtimeToken) {}
  ScriptUrlArena(const ScriptUrlArena&) = delete;
  ScriptUrlArena& operator=(const ScriptUrlArena&) = delete;

  uint32_t runtimeToken() const noexcept { return runtimeToken_; }
  uint32_t used() const noexcept { return used_; }
  uint64_t exhaustionCount() const noexcept { return exhaustionCount_; }
  Mark mark() const noexcept { return Mark(this, used_, runtimeToken_); }

  static ScriptAddressRepresentation representation(const ScriptValue& input) noexcept {
    if (input.tag == ScriptValueTag::kString && (input.length == 0 || input.data != nullptr)) {
      return ScriptAddressRepresentation::kStringShorthand;
    }
    if (input.tag == ScriptValueTag::kHandle && input.handleKind == ScriptHandleKind::kHash) {
      return ScriptAddressRepresentation::kHashShorthand;
    }
    if (input.tag == ScriptValueTag::kHandle && input.handleKind == ScriptHandleKind::kUrl &&
        input.data != nullptr) return ScriptAddressRepresentation::kFullUrl;
    return ScriptAddressRepresentation::kInvalid;
  }

  bool store(const ScriptResolvedUrl& url, ScriptValue* output) noexcept {
    if (!output || runtimeToken_ == 0 || used_ >= Capacity) {
      if (used_ >= Capacity) ++exhaustionCount_;
      return false;
    }
    const uint32_t index = used_++;
    Slot& slot = slots_[index];
    bump(slot.generation);
    slot.value = url;
    *output = {};
    output->tag = ScriptValueTag::kHandle;
    output->handleKind = ScriptHandleKind::kUrl;
    output->length = runtimeToken_;
    output->payload = (static_cast<uint64_t>(slot.generation) << 32u) | index;
    output->data = &slot;
    return true;
  }

  bool store(uint64_t socket, uint64_t path, uint64_t fragment, ScriptValue* output) noexcept {
    return store({socket, 0, path, fragment}, output);
  }

  template <typename DmUrl>
  bool copyBeforeLuaPop(const DmUrl& url, ScriptValue* output) noexcept {
    static_assert(sizeof(url.m_Socket) == sizeof(uint64_t));
    static_assert(sizeof(url._reserved) == sizeof(uint64_t));
    static_assert(sizeof(url.m_Path) == sizeof(uint64_t));
    static_assert(sizeof(url.m_Fragment) == sizeof(uint64_t));
    return store({
      static_cast<uint64_t>(url.m_Socket), static_cast<uint64_t>(url._reserved),
      static_cast<uint64_t>(url.m_Path), static_cast<uint64_t>(url.m_Fragment)
    }, output);
  }

  bool resolve(const ScriptValue& input, uint32_t expectedRuntime, ScriptResolvedUrl* output) const noexcept {
    if (!output || expectedRuntime == 0 || runtimeToken_ != expectedRuntime ||
        input.tag != ScriptValueTag::kHandle || input.handleKind != ScriptHandleKind::kUrl ||
        input.length != expectedRuntime || input.data == nullptr) return false;
    const uint32_t index = static_cast<uint32_t>(input.payload);
    const uint32_t generation = static_cast<uint32_t>(input.payload >> 32u);
    if (index >= used_ || index >= Capacity || generation == 0) return false;
    const Slot& slot = slots_[index];
    if (input.data != &slot || generation != slot.generation) return false;
    *output = slot.value;
    return true;
  }

  template <typename DmUrl>
  bool copyForPushUrl(const ScriptValue& input, uint32_t expectedRuntime, DmUrl* output) const noexcept {
    if (!output) return false;
    ScriptResolvedUrl url{};
    if (!resolve(input, expectedRuntime, &url)) return false;
    output->m_Socket = static_cast<decltype(output->m_Socket)>(url.socket);
    output->_reserved = static_cast<decltype(output->_reserved)>(url.reserved);
    output->m_Path = static_cast<decltype(output->m_Path)>(url.path);
    output->m_Fragment = static_cast<decltype(output->m_Fragment)>(url.fragment);
    return true;
  }

  bool rewind(Mark target) noexcept {
    if (target.owner_ != this || target.runtimeToken_ != runtimeToken_ || target.index_ > used_) return false;
    for (uint32_t index = target.index_; index < used_; ++index) bump(slots_[index].generation);
    used_ = target.index_;
    return true;
  }

  bool resetRuntime(uint32_t runtimeToken) noexcept {
    if (runtimeToken == 0) return false;
    for (uint32_t index = 0; index < Capacity; ++index) bump(slots_[index].generation);
    used_ = 0;
    runtimeToken_ = runtimeToken;
    return true;
  }

 private:
  static void bump(uint32_t& generation) noexcept {
    ++generation;
    if (generation == 0) ++generation;
  }

  Slot slots_[Capacity]{};
  uint32_t runtimeToken_ = 0;
  uint32_t used_ = 0;
  uint64_t exhaustionCount_ = 0;
};

}  // namespace defold_hermes
