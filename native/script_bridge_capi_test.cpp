#include <defold_hermes/generated_script_value_bindings.hpp>
#include <defold_hermes/script_bridge_capi.hpp>

#include <dmsdk/dlib/hash.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace value = defold_hermes::value_binding;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptValueTag;

namespace {
char gError[256]{};

[[noreturn]] void Fail(const char* message) {
  std::fprintf(stderr, "script-bridge-capi:error:%s\n", message);
  std::exit(1);
}

void Expect(bool condition, const char* message) {
  if (!condition) Fail(message);
}

bool Dispatch(void*, ScriptCallFrame* frame) noexcept {
  gError[0] = '\0';
  return value::dispatch(frame, gError, sizeof(gError)) == value::DispatchStatus::kSuccess;
}

const char* LastError(void*) noexcept { return gError; }

int CallHash(
    const char* stringData,
    uint32_t stringDataLength,
    uint32_t offset,
    uint32_t length,
    uint64_t* payload) {
  const uint8_t tag = static_cast<uint8_t>(ScriptValueTag::kString);
  const uint8_t handleKind = static_cast<uint8_t>(ScriptHandleKind::kNone);
  const double number = 0.0;
  const uint64_t inputPayload = 0;
  uint8_t outTag = 0;
  uint8_t outHandleKind = 0;
  return defoldHermesScriptCall(
      static_cast<uint32_t>(value::BindingId::Hash),
      1,
      &tag,
      &handleKind,
      &number,
      &inputPayload,
      &offset,
      &length,
      stringData,
      stringDataLength,
      &outTag,
      &outHandleKind,
      nullptr,
      payload,
      nullptr,
      0,
      nullptr) &&
      outTag == static_cast<uint8_t>(ScriptValueTag::kHandle) &&
      outHandleKind == static_cast<uint8_t>(ScriptHandleKind::kHash);
}
}  // namespace

int main() {
  defold_hermes::installScriptBridgeApi({nullptr, Dispatch, LastError});

  const char input[] = "my_hash";
  uint64_t payload = 0;
  Expect(CallHash(input, 7, 0, 7, &payload), "flat ABI hash call failed");
  Expect(payload == UINT64_C(0xa2bc06d97f580aab), "flat ABI hash payload changed");

  payload = UINT64_MAX;
  Expect(!CallHash(input, 7, 6, 2, &payload), "flat ABI accepted an out-of-bounds string span");
  Expect(payload == UINT64_MAX, "rejected flat ABI call wrote an output payload");
  Expect(!CallHash(input, 7, UINT32_MAX, 1, &payload), "flat ABI accepted an overflowing string offset");

  payload = UINT64_MAX;
  Expect(CallHash(nullptr, 0, 0, 0, &payload), "flat ABI rejected an empty string");
  Expect(payload == dmHashString64(""), "flat ABI empty-string hash changed");

  defold_hermes::uninstallScriptBridgeApi();
  std::printf("script-bridge-capi:bounds:ok\nscript-bridge-capi:hash:ok\n");
  return 0;
}
