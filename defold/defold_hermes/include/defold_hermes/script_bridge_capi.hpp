#pragma once

#include <cstddef>
#include <cstdint>

namespace defold_hermes {

/**
 * Runtime-neutral tagged value ABI for the generated Defold script surface.
 * Scalar Lua bindings use the primitive tags today. The remaining tags and
 * multi-result frame shape reserve the same entrypoint for handles, callbacks,
 * tables, Defold values, and tuples without changing the public JS bridge.
 */
enum class ScriptValueTag : uint8_t {
  kUndefined = 0,
  kNull,
  kBoolean,
  kNumber,
  kString,
  kHandle,
  kCallback,
  kTable,
  kDefoldValue,
};

/** Fixed-layout value kinds copied by value across the JS/native boundary. */
enum class ScriptDefoldValueKind : uint8_t {
  kNone = 0,
  kVector3,
  kVector4,
  kQuaternion,
  /** A generation-checked reference into ScriptCallFrame::matrix4Arena. */
  kMatrix4,
};

/** Exact-width engine handle kinds. Hashes are POD values, not owned objects. */
enum class ScriptHandleKind : uint8_t {
  kNone = 0,
  kHash,
  kUrl,
  kGuiNode,
  /** Borrowed Lua userdata retained in the per-runtime registry pool. */
  kLuaUserdata,
  /** Semantically branded userdata retained by the generated handle router. */
  kLuaSemanticHandle,
};

/** Runtime container identity retained across the generic Lua/JS value graph. */
enum class ScriptTableKind : uint8_t {
  kUnspecified = 0,
  kSequence = 1,
  kRecord = 2,
  kMap = 3,
};

struct ScriptValue {
  ScriptValueTag tag = ScriptValueTag::kUndefined;
  ScriptHandleKind handleKind = ScriptHandleKind::kNone;
  ScriptDefoldValueKind defoldKind = ScriptDefoldValueKind::kNone;
  uint8_t reserved = 0;
  uint32_t length = 0;
  double number = 0.0;
  uint64_t payload = 0;
  const void* data = nullptr;
  float defoldValue[4]{};
};

/** Flat bounded table entry used by structured generated Lua calls. */
struct ScriptTableEntry {
  ScriptValue key{};
  ScriptValue value{};
};

struct ScriptMatrix4Arena;
template <uint32_t Capacity> class ScriptUrlArena;

struct ScriptCallFrame {
  uint32_t stableId = 0;
  const ScriptValue* arguments = nullptr;
  uint32_t argumentCount = 0;
  ScriptValue* results = nullptr;
  uint32_t resultCapacity = 0;
  uint32_t resultCount = 0;
  char* stringScratch = nullptr;
  uint32_t stringScratchCapacity = 0;
  uint32_t stringScratchUsed = 0;
  /** Caller-owned, bounded storage for flat generated table results. */
  ScriptTableEntry* tableScratch = nullptr;
  uint32_t tableScratchCapacity = 0;
  uint32_t tableScratchUsed = 0;
  /** Optional fixed-capacity sidecar for canonical column-major Matrix4 values. */
  ScriptMatrix4Arena* matrix4Arena = nullptr;
  /** Optional fixed-capacity sidecar for exact four-lane dmMessage::URL values. */
  ScriptUrlArena<32>* urlArena = nullptr;
};

/**
 * Runtime-neutral retained callback. The producer owns one reference while a
 * call frame is live; Lua closures retain their own reference. invoke must
 * consume results synchronously so every pointed-to scratch region remains
 * caller-owned and bounded.
 */
using ScriptCallbackConsume = bool (*)(
    void* context,
    const ScriptCallFrame* results) noexcept;

struct ScriptCallback {
  void* context = nullptr;
  bool (*invoke)(
      void* context,
      const ScriptCallFrame* arguments,
      void* consumeContext,
      ScriptCallbackConsume consume,
      char* error,
      size_t errorCapacity) noexcept = nullptr;
  void (*retain)(void* context) noexcept = nullptr;
  void (*release)(void* context) noexcept = nullptr;
};

struct ScriptBridgeApi {
  void* context = nullptr;
  bool (*dispatch)(void* context, ScriptCallFrame* frame) = nullptr;
  const char* (*lastError)(void* context) = nullptr;
  void (*releaseHandle)(
      void* context,
      ScriptHandleKind kind,
      uint32_t runtime,
      uint64_t payload) noexcept = nullptr;
};

struct ScriptBridgeReleaseQueueStats {
  uint64_t enqueued = 0;
  uint64_t drained = 0;
  uint64_t dropped = 0;
  uint32_t pending = 0;
  uint32_t capacity = 0;
};

void installScriptBridgeApi(ScriptBridgeApi api) noexcept;
void uninstallScriptBridgeApi() noexcept;
bool dispatchScriptCall(ScriptCallFrame* frame) noexcept;
const char* scriptBridgeLastError() noexcept;
void releaseScriptHandle(
    ScriptHandleKind kind,
    uint32_t runtime,
    uint64_t payload) noexcept;
/** Drain GC-thread finalizer releases on the Lua/runtime thread. */
void drainReleasedScriptHandles() noexcept;
ScriptBridgeReleaseQueueStats scriptBridgeReleaseQueueStats() noexcept;

}  // namespace defold_hermes

/** Flat Emscripten/Static-Hermes entrypoint for the primitive fast lane. */
extern "C" int defoldHermesScriptCall(
    uint32_t stableId,
    uint32_t argumentCount,
    const uint8_t* tags,
    const uint8_t* handleKinds,
    const double* numbers,
    const uint64_t* payloads,
    const uint32_t* stringOffsets,
    const uint32_t* stringLengths,
    const char* stringData,
    uint32_t stringDataLength,
    uint8_t* outTag,
    uint8_t* outHandleKind,
    double* outNumber,
    uint64_t* outPayload,
    char* outString,
    uint32_t outStringCapacity,
    uint32_t* outStringLength);

extern "C" const char* defoldHermesScriptLastError();
