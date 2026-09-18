#include <defold_hermes/generated_script_universal_value_bindings.hpp>

#include <cassert>
#include <cstring>

using namespace defold_hermes;

namespace {
universal_value::DispatchStatus invoke(
    void*, const universal_value::Operation& operation,
    ScriptCallFrame* frame, char*, size_t) noexcept {
  frame->resultCount = operation.resultCount;
  for (uint8_t index = 0; index < operation.resultCount; ++index) {
    frame->results[index] = {};
    frame->results[index].tag = ScriptValueTag::kNull;
  }
  return universal_value::DispatchStatus::kSuccess;
}
}

int main() {
  static_assert(universal_value::kOperationCount > 100);
  const auto* rows = universal_value::operations();
  for (size_t index = 1; index < universal_value::kOperationCount; ++index) {
    assert(rows[index - 1].stableId < rows[index].stableId);
  }
  assert(universal_value::find(rows[0].stableId) == &rows[0]);
  assert(universal_value::find(0) == nullptr);

  ScriptValue arguments[8]{};
  ScriptValue results[8]{};
  char error[160]{};
  ScriptCallFrame frame{};
  frame.stableId = rows[0].stableId;
  frame.arguments = arguments;
  frame.argumentCount = rows[0].minimumArgumentCount;
  frame.results = results;
  frame.resultCapacity = 8;
  universal_value::LuaApi api{nullptr, invoke};
  assert(universal_value::dispatch(&frame, error, sizeof(error), &api) ==
      universal_value::DispatchStatus::kSuccess);
  assert(frame.resultCount == rows[0].resultCount);

  frame.argumentCount = static_cast<uint32_t>(rows[0].maximumArgumentCount) + 1;
  assert(universal_value::dispatch(&frame, error, sizeof(error), &api) ==
      universal_value::DispatchStatus::kError);
  assert(std::strstr(error, "argument count"));

  frame.argumentCount = rows[0].minimumArgumentCount;
  assert(universal_value::dispatch(&frame, error, sizeof(error), nullptr) ==
      universal_value::DispatchStatus::kError);
  assert(std::strstr(error, "backend is unavailable"));
}
