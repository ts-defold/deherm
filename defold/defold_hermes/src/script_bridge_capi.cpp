#include <defold_hermes/script_bridge_capi.hpp>

#include <array>

namespace defold_hermes {
namespace {
ScriptBridgeApi gApi;
const char* gUnavailable = "Defold script bridge is not installed";
}

void installScriptBridgeApi(ScriptBridgeApi api) noexcept { gApi = api; }

void uninstallScriptBridgeApi() noexcept { gApi = {}; }

bool dispatchScriptCall(ScriptCallFrame* frame) noexcept {
  return frame && gApi.dispatch && gApi.dispatch(gApi.context, frame);
}

const char* scriptBridgeLastError() noexcept {
  return gApi.lastError ? gApi.lastError(gApi.context) : gUnavailable;
}

void releaseScriptHandle(
    ScriptHandleKind kind,
    uint32_t runtime,
    uint64_t payload) noexcept {
  if (gApi.releaseHandle) gApi.releaseHandle(gApi.context, kind, runtime, payload);
}

}  // namespace defold_hermes

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
    uint32_t* outStringLength) {
  constexpr uint32_t kMaximumArguments = 6;
  if (argumentCount > kMaximumArguments ||
      (argumentCount != 0 && (!tags || !handleKinds || !numbers || !payloads || !stringOffsets || !stringLengths))) return 0;
  std::array<defold_hermes::ScriptValue, kMaximumArguments> arguments{};
  for (uint32_t index = 0; index < argumentCount; ++index) {
    auto& value = arguments[index];
    value.tag = static_cast<defold_hermes::ScriptValueTag>(tags[index]);
    value.handleKind = static_cast<defold_hermes::ScriptHandleKind>(handleKinds[index]);
    value.number = numbers[index];
    value.payload = payloads[index];
    if (value.tag == defold_hermes::ScriptValueTag::kString) {
      const uint32_t offset = stringOffsets[index];
      const uint32_t length = stringLengths[index];
      if (offset > stringDataLength || length > stringDataLength - offset) return 0;
      if (!stringData && stringDataLength != 0) return 0;
      value.data = stringData ? stringData + stringOffsets[index] : nullptr;
      value.length = length;
    }
  }
  defold_hermes::ScriptValue result;
  defold_hermes::ScriptCallFrame frame;
  frame.stableId = stableId;
  frame.arguments = arguments.data();
  frame.argumentCount = argumentCount;
  frame.results = &result;
  frame.resultCapacity = 1;
  frame.stringScratch = outString;
  frame.stringScratchCapacity = outStringCapacity;
  if (!defold_hermes::dispatchScriptCall(&frame) || frame.resultCount > 1) return 0;
  if (frame.resultCount == 0) result.tag = defold_hermes::ScriptValueTag::kUndefined;
  if (outTag) *outTag = static_cast<uint8_t>(result.tag);
  if (outHandleKind) *outHandleKind = static_cast<uint8_t>(result.handleKind);
  if (outNumber) *outNumber = result.number;
  if (outPayload) *outPayload = result.payload;
  if (outStringLength) *outStringLength = result.length;
  return 1;
}

extern "C" const char* defoldHermesScriptLastError() {
  return defold_hermes::scriptBridgeLastError();
}
