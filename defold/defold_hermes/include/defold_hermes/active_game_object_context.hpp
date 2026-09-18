#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace defold_hermes::game_object {

/**
 * Engine calls used by generated context-bound GO thunks. The extension
 * installs Defold-backed functions once; native proof harnesses install exact
 * in-memory fakes. Function pointers keep generated code independent of
 * private engine layouts and make every dereference observable in tests.
 */
struct TerminalApi {
  void* userData = nullptr;
  uint32_t (*getGeneration)(void* userData, void* instance) noexcept = nullptr;
  void* (*getCollection)(void* userData, void* instance) noexcept = nullptr;
  uint64_t (*getIdentifier)(void* userData, void* instance) noexcept = nullptr;
  void (*getPosition)(void* userData, void* instance, float* xyz) noexcept = nullptr;
  void (*setPosition)(void* userData, void* instance, const float* xyz) noexcept = nullptr;
  void (*setRotation)(void* userData, void* instance, const float* xyzw) noexcept = nullptr;
};

/** Persistent attachment identity checked before a borrowed HInstance is read. */
struct AttachmentToken {
  void* owner = nullptr;
  uint32_t slot = 0;
  uint32_t generation = 0;
  bool (*isLive)(void* owner, uint32_t slot, uint32_t generation) noexcept = nullptr;
};

/** Call-scoped snapshot. No pointer in this record may escape the scope. */
struct ActiveContext {
  void* instance = nullptr;
  void* collection = nullptr;
  uint64_t identifier = 0;
  uint32_t instanceGeneration = 0;
  AttachmentToken attachment{};
};

struct ResolvedCurrent {
  const TerminalApi* api = nullptr;
  void* instance = nullptr;
};

/**
 * Resolves the game object that owns the script component currently dispatching
 * on a Lua state. A component callback must publish its own instance before the
 * generated current-instance thunks run; keeping this a function pointer over an
 * opaque state keeps the header independent of engine and Lua layouts.
 */
struct CurrentInstanceApi {
  void* userData = nullptr;
  bool (*build)(void* userData, void* luaState, ActiveContext* out) noexcept = nullptr;
};

inline constexpr size_t kMaximumContextDepth = 32;

namespace detail {
struct ContextStack {
  std::array<ActiveContext, kMaximumContextDepth> entries{};
  uint32_t depth = 0;
};

inline thread_local ContextStack contextStack;
inline TerminalApi terminalApi;
inline bool terminalApiInstalled = false;
inline CurrentInstanceApi currentInstanceApi;

inline bool fail(char* error, size_t capacity, const char* message) noexcept {
  if (error && capacity) std::snprintf(error, capacity, "%s", message);
  return false;
}
}  // namespace detail

inline bool installTerminalApi(const TerminalApi& api) noexcept {
  if (!api.getGeneration || !api.getCollection || !api.getIdentifier ||
      !api.getPosition || !api.setPosition || !api.setRotation) {
    return false;
  }
  detail::terminalApi = api;
  detail::terminalApiInstalled = true;
  return true;
}

inline void uninstallTerminalApi() noexcept {
  detail::terminalApi = {};
  detail::terminalApiInstalled = false;
}

inline bool installCurrentInstanceApi(const CurrentInstanceApi& api) noexcept {
  if (!api.build) return false;
  detail::currentInstanceApi = api;
  return true;
}

inline void uninstallCurrentInstanceApi() noexcept { detail::currentInstanceApi = {}; }

/** Build the call-scoped context for the component dispatching on `luaState`. */
inline bool buildCurrentInstanceContext(void* luaState, ActiveContext* out) noexcept {
  if (!out) return false;
  *out = {};
  const CurrentInstanceApi& api = detail::currentInstanceApi;
  if (!api.build) return false;
  return api.build(api.userData, luaState, out);
}

inline uint32_t activeDepth() noexcept { return detail::contextStack.depth; }

class Scope {
 public:
  explicit Scope(const ActiveContext& context) noexcept {
    auto& stack = detail::contextStack;
    if (stack.depth == kMaximumContextDepth) return;
    stack.entries[stack.depth++] = context;
    entered_ = true;
  }

  ~Scope() {
    if (!entered_) return;
    auto& stack = detail::contextStack;
    if (stack.depth != 0) {
      stack.entries[--stack.depth] = {};
    }
  }

  Scope(const Scope&) = delete;
  Scope& operator=(const Scope&) = delete;
  bool entered() const noexcept { return entered_; }

 private:
  bool entered_ = false;
};

inline bool resolveCurrent(
    ResolvedCurrent* out,
    char* error,
    size_t errorCapacity) noexcept {
  if (!out) return detail::fail(error, errorCapacity, "Current game-object result storage is null");
  *out = {};
  if (!detail::terminalApiInstalled) {
    return detail::fail(error, errorCapacity, "Game-object terminal API is not installed");
  }
  const auto& stack = detail::contextStack;
  if (stack.depth == 0) {
    return detail::fail(error, errorCapacity, "No active game-object context");
  }
  const ActiveContext& context = stack.entries[stack.depth - 1];
  if (!context.attachment.isLive ||
      !context.attachment.isLive(
          context.attachment.owner,
          context.attachment.slot,
          context.attachment.generation)) {
    return detail::fail(error, errorCapacity, "Active game-object attachment is stale");
  }
  if (!context.instance) {
    return detail::fail(error, errorCapacity, "Active game-object instance is null");
  }
  const TerminalApi& api = detail::terminalApi;
  // Attachment validation intentionally precedes every engine pointer read.
  if (api.getGeneration(api.userData, context.instance) != context.instanceGeneration ||
      api.getCollection(api.userData, context.instance) != context.collection ||
      api.getIdentifier(api.userData, context.instance) != context.identifier) {
    return detail::fail(error, errorCapacity, "Active game-object instance is stale");
  }
  out->api = &api;
  out->instance = context.instance;
  return true;
}

}  // namespace defold_hermes::game_object
