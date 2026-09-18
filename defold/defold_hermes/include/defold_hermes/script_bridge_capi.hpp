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
  /** Optional fixed-capacity sidecar for canonical column-major Matrix4 values. */
  ScriptMatrix4Arena* matrix4Arena = nullptr;
  /** Optional fixed-capacity sidecar for exact four-lane dmMessage::URL values. */
  ScriptUrlArena<32>* urlArena = nullptr;
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

void installScriptBridgeApi(ScriptBridgeApi api) noexcept;
void uninstallScriptBridgeApi() noexcept;
bool dispatchScriptCall(ScriptCallFrame* frame) noexcept;
const char* scriptBridgeLastError() noexcept;
void releaseScriptHandle(
    ScriptHandleKind kind,
    uint32_t runtime,
    uint64_t payload) noexcept;

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
