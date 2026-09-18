#include <defold_hermes/generated_script_overload_dispatch.hpp>

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace dispatch = defold_hermes::overload_dispatch;
using defold_hermes::ScriptCallFrame;
using defold_hermes::ScriptDefoldValueKind;
using defold_hermes::ScriptValue;
using defold_hermes::ScriptValueTag;

namespace {
[[noreturn]] void Fail(const char* message) { std::fprintf(stderr, "script-overload-dispatch:error:%s\n", message); std::exit(1); }
void Expect(bool condition, const char* message) { if (!condition) Fail(message); }

ScriptValue Number(double value) { ScriptValue result{}; result.tag = ScriptValueTag::kNumber; result.number = value; return result; }
ScriptValue Defold(ScriptDefoldValueKind kind) { ScriptValue result{}; result.tag = ScriptValueTag::kDefoldValue; result.defoldKind = kind; return result; }

struct Backend { uint32_t calls = 0; bool wrongResult = false; };

dispatch::DispatchStatus Invoke(void* context, const dispatch::Operation&, const dispatch::Shape& shape,
    ScriptCallFrame* frame, char*, size_t) noexcept {
  auto* backend = static_cast<Backend*>(context); ++backend->calls;
  frame->resultCount = 1;
  if (backend->wrongResult) { frame->results[0] = Number(1); return dispatch::DispatchStatus::kSuccess; }
  if (shape.resultMask == dispatch::kNumber) frame->results[0] = Number(1);
  else if (shape.resultMask == dispatch::kVector3) frame->results[0] = Defold(ScriptDefoldValueKind::kVector3);
  else if (shape.resultMask == dispatch::kVector4) frame->results[0] = Defold(ScriptDefoldValueKind::kVector4);
  else if (shape.resultMask == dispatch::kQuaternion) frame->results[0] = Defold(ScriptDefoldValueKind::kQuaternion);
  else frame->results[0] = Defold(ScriptDefoldValueKind::kMatrix4);
  return dispatch::DispatchStatus::kSuccess;
}
}

int main() {
  const dispatch::Operation* lerp = dispatch::find(UINT32_C(4026227879));
  const dispatch::Operation* matrix = dispatch::find(UINT32_C(1238853489));
  Expect(lerp && matrix && dispatch::kBindingCount == 8, "generated descriptors are missing");
  ScriptValue arguments[] = {Number(0.5), Defold(ScriptDefoldValueKind::kVector3), Defold(ScriptDefoldValueKind::kVector3)};
  ScriptValue results[1]{}; char error[256]{};
  ScriptCallFrame frame{}; frame.stableId = lerp->stableId; frame.arguments = arguments; frame.argumentCount = 3; frame.results = results; frame.resultCapacity = 1;
  Backend backend{}; const dispatch::LuaApi api{&backend, Invoke};
  Expect(dispatch::dispatch(&frame, error, sizeof(error), &api) == dispatch::DispatchStatus::kSuccess, "valid reviewed lerp shape failed");
  Expect(backend.calls == 1 && frame.resultCount == 1 && results[0].defoldKind == ScriptDefoldValueKind::kVector3, "valid result was not preserved");

  frame.arguments = arguments + 1; frame.argumentCount = 2; frame.resultCount = 99;
  Expect(dispatch::dispatch(&frame, error, sizeof(error), &api) == dispatch::DispatchStatus::kError, "invalid arity was accepted");
  Expect(backend.calls == 1 && frame.resultCount == 0 && std::strstr(error, "reviewed call shape"), "invalid arity leaked to backend");

  frame.stableId = matrix->stableId; frame.arguments = arguments; frame.argumentCount = 1; frame.resultCount = 0;
  Expect(dispatch::dispatch(&frame, error, sizeof(error), &api) == dispatch::DispatchStatus::kError, "wrong matrix argument tag was accepted");
  Expect(backend.calls == 1, "wrong argument tag reached backend");

  frame.stableId = lerp->stableId; frame.arguments = arguments; frame.argumentCount = 3; backend.wrongResult = true;
  Expect(dispatch::dispatch(&frame, error, sizeof(error), &api) == dispatch::DispatchStatus::kError, "wrong backend result was accepted");
  Expect(frame.resultCount == 0 && std::strstr(error, "result does not match"), "wrong result was not cleared");
  return 0;
}
