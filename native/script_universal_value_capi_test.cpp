#include <defold_hermes/generated_script_universal_value_bindings.hpp>
#include <defold_hermes/generated_script_universal_value_capi.h>
#include <defold_hermes/generated_script_universal_static_frame.h>
#include <defold_hermes/script_bridge_capi.hpp>
#include <defold_hermes/script_matrix4_arena.hpp>
#include <defold_hermes/script_url_arena.hpp>

#include <array>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <new>

using namespace defold_hermes;

namespace {
std::atomic<uint64_t> gAllocations{0};

[[noreturn]] void requireFailed(const char* expression, int line) {
  std::cerr << "requirement failed at line " << line << ": " << expression << '\n';
  std::abort();
}

#define REQUIRE(expression) ((expression) ? static_cast<void>(0) : requireFailed(#expression, __LINE__))

struct Backend {
  uint32_t reentrantStableId = 0;
  uint32_t calls = 0;
  uint32_t releases = 0;
  bool nested = false;
  char error[128]{};
};

ScriptValue stringValue(const char* value) {
  ScriptValue result{};
  result.tag = ScriptValueTag::kString;
  result.data = value;
  result.length = static_cast<uint32_t>(std::strlen(value));
  return result;
}

bool Dispatch(void* opaque, ScriptCallFrame* frame) {
  auto& backend = *static_cast<Backend*>(opaque);
  ++backend.calls;
  const auto* operation = universal_value::find(frame->stableId);
  if (!operation) {
    std::snprintf(backend.error, sizeof(backend.error), "missing operation");
    return false;
  }
  if (frame->stableId == backend.reentrantStableId && !backend.nested) {
    backend.nested = true;
    std::array<DehermScriptUniversalValue, DEHERM_SCRIPT_UNIVERSAL_MAX_VALUES> values{};
    std::array<DehermScriptUniversalEntry, DEHERM_SCRIPT_UNIVERSAL_MAX_ENTRIES> entries{};
    std::array<char, DEHERM_SCRIPT_UNIVERSAL_MAX_STRING_BYTES> strings{};
    std::array<float, DEHERM_SCRIPT_UNIVERSAL_MAX_MATRIX4_VALUES * 16> floats{};
    std::array<DehermScriptUniversalUrl, DEHERM_SCRIPT_UNIVERSAL_MAX_URL_VALUES> urls{};
    std::array<uint32_t, DEHERM_SCRIPT_UNIVERSAL_MAX_RESULTS> roots{};
    uint32_t valueCount = 0, entryCount = 0, stringCount = 0, floatCount = 0, urlCount = 0, resultCount = 0;
    char error[128]{};
    const auto status = deherm_script_universal_dispatch(
        frame->stableId, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0,
        nullptr, 0, values.data(), values.size(), &valueCount, entries.data(), entries.size(), &entryCount,
        strings.data(), strings.size(), &stringCount, floats.data(), floats.size(), &floatCount,
        urls.data(), urls.size(), &urlCount, roots.data(), roots.size(), &resultCount, error, sizeof(error));
    backend.nested = false;
    if (status != DEHERM_SCRIPT_UNIVERSAL_OK || resultCount != operation->resultCount) {
      std::snprintf(backend.error, sizeof(backend.error), "nested dispatch failed: %s", error);
      return false;
    }
  }
  if (operation->resultCount == 0) {
    frame->resultCount = 0;
    return true;
  }
  if (!frame->tableScratch || frame->tableScratchCapacity < 3 || !frame->matrix4Arena || !frame->urlArena) {
    std::snprintf(backend.error, sizeof(backend.error), "missing result scratch");
    return false;
  }
  auto* entries = frame->tableScratch;
  entries[0].key = stringValue("echo");
  entries[0].value = frame->argumentCount ? frame->arguments[0] : ScriptValue{};
  entries[1].key = stringValue("url");
  if (!frame->urlArena->store({1, 2, 3, 4}, &entries[1].value)) return false;
  entries[2].key = stringValue("handle");
  entries[2].value.tag = ScriptValueTag::kHandle;
  entries[2].value.handleKind = ScriptHandleKind::kLuaSemanticHandle;
  entries[2].value.reserved = 7;
  entries[2].value.length = 19;
  entries[2].value.payload = (UINT64_C(4) << 32u) | 3u;
  frame->results[0].tag = ScriptValueTag::kTable;
  frame->results[0].reserved = static_cast<uint8_t>(ScriptTableKind::kRecord);
  frame->results[0].length = 3;
  frame->results[0].data = entries;
  for (uint32_t index = 1; index < operation->resultCount; ++index) {
    frame->results[index] = {};
    frame->results[index].tag = ScriptValueTag::kNull;
  }
  frame->tableScratchUsed = 3;
  frame->resultCount = operation->resultCount;
  return true;
}

const char* LastError(void* opaque) { return static_cast<Backend*>(opaque)->error; }

void Release(void* opaque, ScriptHandleKind, uint32_t, uint64_t) noexcept {
  ++static_cast<Backend*>(opaque)->releases;
}

// The fake backend above returns a record carrying a URL and a retained handle,
// and the input frame below carries a record argument. A route's per-call frame
// is sized to its own generated contract, so this test must drive a route whose
// descriptor declares the scratch it uses; asking for it by contract is also the
// check that the descriptor and the frame agree.
const universal_value::Operation* operation(
    uint8_t minimumArguments, uint8_t resultCount, uint16_t inputTableEntries) {
  for (size_t index = 0; index < universal_value::kOperationCount; ++index) {
    const auto& candidate = universal_value::operations()[index];
    if (candidate.minimumArgumentCount == minimumArguments && candidate.resultCount == resultCount &&
        candidate.inputTableEntryCapacity >= inputTableEntries &&
        candidate.outputTableEntryCapacity >= 3 && candidate.urlArena) return &candidate;
  }
  return nullptr;
}

struct Output {
  std::array<DehermScriptUniversalValue, DEHERM_SCRIPT_UNIVERSAL_MAX_VALUES> values{};
  std::array<DehermScriptUniversalEntry, DEHERM_SCRIPT_UNIVERSAL_MAX_ENTRIES> entries{};
  std::array<char, DEHERM_SCRIPT_UNIVERSAL_MAX_STRING_BYTES> strings{};
  std::array<float, DEHERM_SCRIPT_UNIVERSAL_MAX_MATRIX4_VALUES * 16> floats{};
  std::array<DehermScriptUniversalUrl, DEHERM_SCRIPT_UNIVERSAL_MAX_URL_VALUES> urls{};
  std::array<uint32_t, DEHERM_SCRIPT_UNIVERSAL_MAX_RESULTS> roots{};
  uint32_t valueCount = 0, entryCount = 0, stringCount = 0, floatCount = 0, urlCount = 0, resultCount = 0;
  char error[256]{};
};

DehermScriptUniversalStatus Call(
    uint32_t stableId,
    const DehermScriptUniversalValue* values, uint32_t valueCount,
    const DehermScriptUniversalEntry* entries, uint32_t entryCount,
    const char* strings, uint32_t stringCount,
    const float* floats, uint32_t floatCount,
    const DehermScriptUniversalUrl* urls, uint32_t urlCount,
    const uint32_t* roots, uint32_t argumentCount,
    Output& output,
    uint32_t valueCapacity = DEHERM_SCRIPT_UNIVERSAL_MAX_VALUES) {
  return deherm_script_universal_dispatch(
      stableId, values, valueCount, entries, entryCount, strings, stringCount,
      floats, floatCount, urls, urlCount, roots, argumentCount,
      output.values.data(), valueCapacity, &output.valueCount,
      output.entries.data(), output.entries.size(), &output.entryCount,
      output.strings.data(), output.strings.size(), &output.stringCount,
      output.floats.data(), output.floats.size(), &output.floatCount,
      output.urls.data(), output.urls.size(), &output.urlCount,
      output.roots.data(), output.roots.size(), &output.resultCount,
      output.error, sizeof(output.error));
}
}  // namespace

void* operator new(std::size_t size) {
  gAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* pointer = std::malloc(size)) return pointer;
  throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }

int main() {
  Backend backend;
  installScriptBridgeApi({&backend, Dispatch, LastError, Release});
  const auto* oneResult = operation(1, 1, 2);
  const auto* zeroArgument = operation(0, 1, 0);
  REQUIRE(oneResult && zeroArgument);
  backend.reentrantStableId = zeroArgument->stableId;

  std::array<DehermScriptUniversalValue, 7> input{};
  std::array<DehermScriptUniversalEntry, 2> inputEntries{{{1, 2}, {3, 4}}};
  const char inputStrings[] = "namechild";
  input[0].tag = static_cast<uint8_t>(ScriptValueTag::kTable);
  input[0].auxiliary = static_cast<uint8_t>(ScriptTableKind::kRecord);
  input[0].length = 2;
  input[0].data_offset = 0;
  input[1].tag = static_cast<uint8_t>(ScriptValueTag::kString);
  input[1].length = 4;
  input[1].data_offset = 0;
  input[2].tag = static_cast<uint8_t>(ScriptValueTag::kNumber);
  input[2].number = 42;
  input[3].tag = static_cast<uint8_t>(ScriptValueTag::kString);
  input[3].length = 5;
  input[3].data_offset = 4;
  input[4].tag = static_cast<uint8_t>(ScriptValueTag::kBoolean);
  input[4].number = 1;
  const uint32_t argumentRoot = 0;
  Output output;
  REQUIRE(Call(oneResult->stableId, input.data(), input.size(), inputEntries.data(), inputEntries.size(),
      inputStrings, sizeof(inputStrings) - 1, nullptr, 0, nullptr, 0, &argumentRoot, 1, output) ==
      DEHERM_SCRIPT_UNIVERSAL_OK);
  REQUIRE(output.resultCount == 1 && output.valueCount >= 7 && output.entryCount >= 5 && output.urlCount == 1);
  const auto& root = output.values[output.roots[0]];
  REQUIRE(root.tag == static_cast<uint8_t>(ScriptValueTag::kTable));

  Output nestedOutput;
  REQUIRE(Call(zeroArgument->stableId, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0,
      nullptr, 0, nestedOutput) == DEHERM_SCRIPT_UNIVERSAL_OK);
  REQUIRE(backend.calls >= 3);

  // The Static Hermes materializer owns a bounded frame from a thread-local
  // reentrant pool; typed code never performs pointer arithmetic itself.
  auto* staticFrame = deherm_script_static_frame_acquire();
  auto* nestedStaticFrame = deherm_script_static_frame_acquire();
  REQUIRE(staticFrame && nestedStaticFrame && staticFrame != nestedStaticFrame);
  deherm_script_static_frame_release(nestedStaticFrame);
  REQUIRE(deherm_script_static_frame_pool_bytes() ==
      deherm_script_static_frame_bytes() * DEHERM_SCRIPT_STATIC_FRAME_REENTRANCY);
  REQUIRE(deherm_script_static_frame_pool_bytes() <= 512u * 1024u);
  const uint32_t staticRecord = deherm_script_static_push_table(staticFrame, 2, 1);
  const uint32_t staticKey = deherm_script_static_push_string(staticFrame, 4);
  REQUIRE(staticRecord != UINT32_MAX && staticKey != UINT32_MAX);
  REQUIRE(deherm_script_static_write_string_byte(staticFrame, staticKey, 0, 'n'));
  REQUIRE(deherm_script_static_write_string_byte(staticFrame, staticKey, 1, 'a'));
  REQUIRE(deherm_script_static_write_string_byte(staticFrame, staticKey, 2, 'm'));
  REQUIRE(deherm_script_static_write_string_byte(staticFrame, staticKey, 3, 'e'));
  const uint32_t staticValue = deherm_script_static_push_number(staticFrame, 42.0);
  REQUIRE(deherm_script_static_set_entry(staticFrame, staticRecord, 0, staticKey, staticValue));
  REQUIRE(deherm_script_static_set_argument(staticFrame, 0, staticRecord));
  REQUIRE(deherm_script_static_dispatch(staticFrame, oneResult->stableId, 1) == DEHERM_SCRIPT_UNIVERSAL_OK);
  REQUIRE(deherm_script_static_result_count(staticFrame) == 1);
  const uint32_t staticRoot = deherm_script_static_result_root(staticFrame, 0);
  REQUIRE(deherm_script_static_value_tag(staticFrame, staticRoot) == static_cast<uint8_t>(ScriptValueTag::kTable));
  REQUIRE(deherm_script_static_value_auxiliary(staticFrame, staticRoot) == static_cast<uint8_t>(ScriptTableKind::kRecord));
  REQUIRE(deherm_script_static_value_length(staticFrame, staticRoot) == 3);
  const uint32_t echoedRecord = deherm_script_static_entry_value(staticFrame, staticRoot, 0);
  REQUIRE(deherm_script_static_value_tag(staticFrame, echoedRecord) == static_cast<uint8_t>(ScriptValueTag::kTable));
  const uint32_t echoedNumber = deherm_script_static_entry_value(staticFrame, echoedRecord, 0);
  REQUIRE(deherm_script_static_value_number(staticFrame, echoedNumber) == 42.0);
  const uint32_t returnedHandle = deherm_script_static_entry_value(staticFrame, staticRoot, 2);
  REQUIRE(deherm_script_static_value_handle_kind(staticFrame, returnedHandle) == static_cast<uint8_t>(ScriptHandleKind::kLuaSemanticHandle));
  REQUIRE(deherm_script_static_value_runtime(staticFrame, returnedHandle) == 19);
  REQUIRE(deherm_script_static_value_payload_low(staticFrame, returnedHandle) == 3);
  REQUIRE(deherm_script_static_value_payload_high(staticFrame, returnedHandle) == 4);
  deherm_script_static_frame_reset(staticFrame);
  const uint32_t cyclicTable = deherm_script_static_push_table(staticFrame, 3, 1);
  const uint32_t cyclicKey = deherm_script_static_push_number(staticFrame, 1.0);
  REQUIRE(deherm_script_static_set_entry(staticFrame, cyclicTable, 0, cyclicKey, cyclicTable));
  REQUIRE(deherm_script_static_set_argument(staticFrame, 0, cyclicTable));
  REQUIRE(deherm_script_static_dispatch(staticFrame, oneResult->stableId, 1) == DEHERM_SCRIPT_UNIVERSAL_INVALID_VALUE);
  REQUIRE(std::strstr(deherm_script_static_error(staticFrame), "cycle"));
  deherm_script_static_frame_reset(staticFrame);
  REQUIRE(deherm_script_static_push_string(staticFrame, DEHERM_SCRIPT_STATIC_FRAME_STRING_BYTES + 1) == UINT32_MAX);
  REQUIRE(deherm_script_static_push_number(staticFrame, 7.0) == 0);
  deherm_script_static_frame_reset(staticFrame);
  REQUIRE(deherm_script_static_push_table(staticFrame, 2, DEHERM_SCRIPT_UNIVERSAL_MAX_ENTRIES + 1) == UINT32_MAX);
  REQUIRE(deherm_script_static_push_number(staticFrame, 8.0) == 0);
  deherm_script_static_frame_reset(staticFrame);
  REQUIRE(deherm_script_static_dispatch(staticFrame, 0, 0) == DEHERM_SCRIPT_UNIVERSAL_ROUTE_MISSING);
  deherm_script_static_frame_release(staticFrame);

  input[0].length = 1;
  inputEntries[0] = {1, 0};
  Output cycleOutput;
  REQUIRE(Call(oneResult->stableId, input.data(), input.size(), inputEntries.data(), 1,
      inputStrings, sizeof(inputStrings) - 1, nullptr, 0, nullptr, 0, &argumentRoot, 1, cycleOutput) ==
      DEHERM_SCRIPT_UNIVERSAL_INVALID_VALUE);
  REQUIRE(std::strstr(cycleOutput.error, "cycle"));
  input[0].length = 2;
  inputEntries[0] = {1, 2};

  Output exhausted;
  REQUIRE(Call(oneResult->stableId, input.data(), input.size(), inputEntries.data(), inputEntries.size(),
      inputStrings, sizeof(inputStrings) - 1, nullptr, 0, nullptr, 0, &argumentRoot, 1, exhausted, 1) ==
      DEHERM_SCRIPT_UNIVERSAL_ARENA_EXHAUSTED);
  REQUIRE(exhausted.resultCount == 0);

  DehermScriptUniversalValue retained{};
  retained.tag = static_cast<uint8_t>(ScriptValueTag::kHandle);
  retained.handle_kind = static_cast<uint8_t>(ScriptHandleKind::kLuaSemanticHandle);
  retained.runtime = 19;
  retained.payload = 7;
  drainReleasedScriptHandles();
  const uint32_t releasesBeforeIdempotence = backend.releases;
  deherm_script_universal_release(&retained);
  deherm_script_universal_release(&retained);
  drainReleasedScriptHandles();
  REQUIRE(backend.releases == releasesBeforeIdempotence + 1);

  Output warm;
  REQUIRE(Call(zeroArgument->stableId, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0,
      nullptr, 0, warm) == DEHERM_SCRIPT_UNIVERSAL_OK);
  for (uint32_t index = 0; index < warm.valueCount; ++index) deherm_script_universal_release(&warm.values[index]);
  drainReleasedScriptHandles();
  const uint64_t baseline = gAllocations.load(std::memory_order_relaxed);
  for (uint32_t iteration = 0; iteration < 256; ++iteration) {
    Output current;
    REQUIRE(Call(zeroArgument->stableId, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, 0,
        nullptr, 0, current) == DEHERM_SCRIPT_UNIVERSAL_OK);
    for (uint32_t index = 0; index < current.valueCount; ++index) deherm_script_universal_release(&current.values[index]);
    drainReleasedScriptHandles();
  }
  REQUIRE(gAllocations.load(std::memory_order_relaxed) == baseline);

  uninstallScriptBridgeApi();
  std::cout << "script-universal-capi:recursive-reentrant-cycle-exhaustion-idempotence:ok allocations:0"
            << " static-frame-bytes:" << deherm_script_static_frame_bytes()
            << " static-frame-pool-bytes:" << deherm_script_static_frame_pool_bytes() << '\n';
}
