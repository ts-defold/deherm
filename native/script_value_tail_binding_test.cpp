#include <defold_hermes/generated_script_value_tail_bindings.hpp>

#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace tail = defold_hermes::value_tail;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptDefoldValueKind;
using defold_hermes::ScriptHandleKind;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

namespace {
[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "script-value-tail:error:%s\n", message);
  std::exit(1);
}
void expect(bool value, const char* message) { if (!value) fail(message); }

struct Backend { uint32_t calls = 0; bool wrongResult = false; };
tail::DispatchStatus invoke(void* raw, const tail::Route& route, ScriptCallFrame* frame, char*, size_t) noexcept {
  auto* backend = static_cast<Backend*>(raw);
  ++backend->calls;
  if (route.resultCodec == tail::Codec::kNone) { frame->resultCount = 0; return tail::DispatchStatus::kSuccess; }
  if (!frame->results || frame->resultCapacity == 0) return tail::DispatchStatus::kError;
  frame->resultCount = 1;
  frame->results[0] = {};
  if (backend->wrongResult) { frame->results[0].tag = ScriptValueTag::kNumber; return tail::DispatchStatus::kSuccess; }
  if (route.resultCodec == tail::Codec::kString) { frame->results[0].tag = ScriptValueTag::kString; frame->results[0].data = "0123"; frame->results[0].length = 4; }
  else if (route.resultCodec == tail::Codec::kMatrix4) { frame->results[0].tag = ScriptValueTag::kDefoldValue; frame->results[0].defoldKind = ScriptDefoldValueKind::kMatrix4; }
  else if (route.resultCodec == tail::Codec::kHash) { frame->results[0].tag = ScriptValueTag::kHandle; frame->results[0].handleKind = ScriptHandleKind::kHash; }
  else if (route.resultCodec == tail::Codec::kBoolean) { frame->results[0].tag = ScriptValueTag::kBoolean; }
  else { frame->results[0].tag = ScriptValueTag::kNumber; }
  return tail::DispatchStatus::kSuccess;
}

struct Storage {
  std::array<ScriptValue, 6> arguments{};
  std::array<ScriptValue, 2> results{};
  std::array<char, 128> error{};
  ScriptCallFrame frame{};
  explicit Storage(uint32_t stableId) { frame.stableId = stableId; frame.arguments = arguments.data(); frame.results = results.data(); frame.resultCapacity = results.size(); }
};
ScriptValue hash() { ScriptValue value{}; value.tag = ScriptValueTag::kHandle; value.handleKind = ScriptHandleKind::kHash; return value; }
ScriptValue vector3() { ScriptValue value{}; value.tag = ScriptValueTag::kDefoldValue; value.defoldKind = ScriptDefoldValueKind::kVector3; return value; }
}  // namespace

int main() {
  expect(tail::kRouteCount == 26 && tail::kCandidateCount == 16, "generated tail census drifted");
  const tail::Route* hashToHex = tail::find(UINT32_C(0x2cf8087e));
  const tail::Route* blocked = tail::find(UINT32_C(0xf6c4cfba));
  const tail::Route* namedEnum = tail::find(UINT32_C(0xcfd38b11));
  const tail::Route* cameraView = tail::find(UINT32_C(0x3ac6e427));
  const tail::Route* gravity = tail::find(UINT32_C(0x4c2011da));
  const tail::Route* guiLayout = tail::find(UINT32_C(3027276460));
  const tail::Route* renderView = tail::find(UINT32_C(1992852954));
  expect(hashToHex && std::strcmp(hashToHex->sourceSymbol, "HashToHex") == 0, "hash_to_hex registration proof is missing");
  expect(blocked && blocked->disposition == tail::Disposition::kBlocked && std::strcmp(blocked->blocker, "image-type-union-codec") == 0, "unsafe image union was not blocked");
  expect(namedEnum && namedEnum->disposition == tail::Disposition::kBlocked && std::strcmp(namedEnum->blocker, "named-enum-domain-codec") == 0, "unconstrained named enum was not blocked");
  expect(cameraView && cameraView->resultCodec == tail::Codec::kMatrix4, "matrix4 candidate metadata drifted");
  expect(gravity && gravity->resultCodec == tail::Codec::kNone, "vector3 setter metadata drifted");
  expect(guiLayout && guiLayout->disposition == tail::Disposition::kBlocked &&
      std::strcmp(guiLayout->blocker, "gui-script-instance-attachment-unavailable") == 0,
    "GUI-script context route was not blocked");
  expect(renderView && renderView->disposition == tail::Disposition::kBlocked &&
      std::strcmp(renderView->blocker, "render-script-instance-attachment-unavailable") == 0,
    "render-script context route was not blocked");

  Backend backend; const tail::LuaApi api{&backend, invoke};
  Storage valid(hashToHex->stableId); valid.frame.argumentCount = 1; valid.arguments[0] = hash();
  expect(tail::dispatch(&valid.frame, valid.error.data(), valid.error.size(), &api) == tail::DispatchStatus::kSuccess, "exact hash codec candidate was rejected");
  expect(backend.calls == 1 && valid.frame.resultCount == 1 && valid.results[0].tag == ScriptValueTag::kString, "candidate result contract drifted");

  Storage invalid(hashToHex->stableId); invalid.frame.argumentCount = 1; invalid.arguments[0].tag = ScriptValueTag::kString;
  expect(tail::dispatch(&invalid.frame, invalid.error.data(), invalid.error.size(), &api) == tail::DispatchStatus::kError, "wrong candidate argument codec was accepted");
  expect(backend.calls == 1 && std::strstr(invalid.error.data(), "reviewed exact codec shape"), "wrong codec did not fail closed");

  Storage absentApi(gravity->stableId); absentApi.frame.argumentCount = 1; absentApi.arguments[0] = vector3();
  expect(tail::dispatch(&absentApi.frame, absentApi.error.data(), absentApi.error.size(), nullptr) == tail::DispatchStatus::kError, "uninstalled captured Lua backend was accepted");
  expect(std::strstr(absentApi.error.data(), "backend is unavailable"), "missing backend error drifted");

  Storage matrix(cameraView->stableId); backend.wrongResult = false;
  expect(tail::dispatch(&matrix.frame, matrix.error.data(), matrix.error.size(), &api) == tail::DispatchStatus::kSuccess, "matrix4 result candidate was rejected");
  backend.wrongResult = true;
  expect(tail::dispatch(&matrix.frame, matrix.error.data(), matrix.error.size(), &api) == tail::DispatchStatus::kError, "wrong matrix4 result codec was accepted");
  expect(matrix.frame.resultCount == 0 && std::strstr(matrix.error.data(), "result does not match"), "bad result did not fail closed");

  Storage blockedCall(blocked->stableId); blockedCall.frame.argumentCount = 6;
  expect(tail::dispatch(&blockedCall.frame, blockedCall.error.data(), blockedCall.error.size(), &api) == tail::DispatchStatus::kError, "blocked image enum route was dispatched");
  expect(backend.calls == 3 && std::strcmp(blockedCall.error.data(), "image-type-union-codec") == 0, "blocked route called the backend");
  Storage enumCall(namedEnum->stableId); enumCall.frame.argumentCount = 1; enumCall.arguments[0] = hash();
  enumCall.results[0].tag = ScriptValueTag::kNumber; enumCall.results[0].number = 999.0;
  expect(tail::dispatch(&enumCall.frame, enumCall.error.data(), enumCall.error.size(), &api) == tail::DispatchStatus::kError, "arbitrary numeric named-enum result was allowed to cross the ABI");
  expect(enumCall.frame.resultCount == 0 && backend.calls == 3 && std::strcmp(enumCall.error.data(), "named-enum-domain-codec") == 0,
    "blocked named enum route called the backend");
  Storage guiCall(guiLayout->stableId);
  expect(tail::dispatch(&guiCall.frame, guiCall.error.data(), guiCall.error.size(), &api) == tail::DispatchStatus::kError,
    "GUI-script context route was dispatched through a game-object instance");
  expect(backend.calls == 3 && std::strcmp(guiCall.error.data(), "gui-script-instance-attachment-unavailable") == 0,
    "blocked GUI-script route called the backend");
  Storage renderCall(renderView->stableId); renderCall.frame.argumentCount = 1;
  expect(tail::dispatch(&renderCall.frame, renderCall.error.data(), renderCall.error.size(), &api) == tail::DispatchStatus::kError,
    "render-script context route was dispatched through a game-object instance");
  expect(backend.calls == 3 && std::strcmp(renderCall.error.data(), "render-script-instance-attachment-unavailable") == 0,
    "blocked render-script route called the backend");
  std::puts("script-value-tail:ok");
}
