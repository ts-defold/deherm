#include <defold_hermes/generated_script_universal_value_bindings.hpp>

#include <cassert>
#include <cstring>

using namespace defold_hermes;

namespace {
bool useMinimumResults = false;
const universal_value::Operation* expectedOperation = nullptr;
universal_value::DispatchStatus invoke(
    void*, const universal_value::Operation& operation,
    ScriptCallFrame* frame, char*, size_t) noexcept {
  assert(expectedOperation == &operation);
  assert(frame->stableId == operation.stableId);
  assert(frame->argumentCount >= operation.minimumArgumentCount);
  assert(frame->argumentCount <= operation.maximumArgumentCount);
  for (uint32_t index = 0; index < frame->argumentCount; ++index) {
    assert(frame->arguments[index].tag == ScriptValueTag::kNumber);
    assert(frame->arguments[index].number == static_cast<double>(index + 1));
  }
  frame->resultCount = useMinimumResults
      ? operation.minimumResultCount : operation.maximumResultCount;
  for (uint8_t index = 0; index < frame->resultCount; ++index) {
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

  ScriptValue arguments[universal_value::kMaximumArgumentCount]{};
  ScriptValue results[universal_value::kMaximumResultCount]{};
  for (size_t index = 0; index < universal_value::kMaximumArgumentCount; ++index) {
    arguments[index].tag = ScriptValueTag::kNumber;
    arguments[index].number = static_cast<double>(index + 1);
  }
  char error[160]{};
  ScriptCallFrame frame{};
  frame.arguments = arguments;
  frame.results = results;
  frame.resultCapacity = universal_value::kMaximumResultCount;
  universal_value::LuaApi api{nullptr, invoke};
  // Every emitted route crosses the dispatcher. New generated routes join this
  // census automatically; there is no per-function test list to maintain.
  for (size_t index = 0; index < universal_value::kOperationCount; ++index) {
    expectedOperation = &rows[index];
    frame.stableId = rows[index].stableId;
    frame.argumentCount = rows[index].minimumArgumentCount;
    assert(universal_value::dispatch(&frame, error, sizeof(error), &api) ==
        universal_value::DispatchStatus::kSuccess);
    assert(frame.resultCount == rows[index].resultCount);
  }

  const universal_value::Operation* variable = nullptr;
  for (size_t index = 0; index < universal_value::kOperationCount; ++index) {
    if (rows[index].minimumResultCount < rows[index].maximumResultCount) {
      variable = &rows[index];
      break;
    }
  }
  assert(variable);
  useMinimumResults = true;
  expectedOperation = variable;
  frame.stableId = variable->stableId;
  frame.argumentCount = variable->minimumArgumentCount;
  assert(universal_value::dispatch(&frame, error, sizeof(error), &api) ==
      universal_value::DispatchStatus::kSuccess);
  assert(frame.resultCount == variable->minimumResultCount);
  useMinimumResults = false;

  frame.stableId = rows[0].stableId;
  expectedOperation = &rows[0];
  frame.argumentCount = static_cast<uint32_t>(rows[0].maximumArgumentCount) + 1;
  assert(universal_value::dispatch(&frame, error, sizeof(error), &api) ==
      universal_value::DispatchStatus::kError);
  assert(std::strstr(error, "argument count"));

  frame.argumentCount = rows[0].minimumArgumentCount;
  assert(universal_value::dispatch(&frame, error, sizeof(error), nullptr) ==
      universal_value::DispatchStatus::kError);
  assert(std::strstr(error, "backend is unavailable"));
}
