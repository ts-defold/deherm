#include <defold_hermes/generated_script_universal_value_capi.h>
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
ScriptCallback* gRetained = nullptr;
std::array<ScriptCallback*, DEHERM_SCRIPT_UNIVERSAL_BROWSER_CALLBACK_CAPACITY> gRetainedMany{};
uint32_t gRetainedManyCount = 0;
bool gRetainMany = false;
uint32_t gInvocations = 0;
uint32_t gReleases = 0;
bool gNested = false;
bool gFail = false;
bool gExpectHandleResults = false;
ScriptMatrix4Arena* gExpectedMatrices = nullptr;
ScriptUrlArena<32>* gExpectedUrls = nullptr;
ScriptValue gReturnedMatrix{};
ScriptValue gReturnedUrl{};
char gError[128]{};

[[noreturn]] void requireFailed(const char* expression, int line) {
  std::cerr << "requirement failed at line " << line << ": " << expression << '\n';
  std::abort();
}

#define REQUIRE(expression) ((expression) ? static_cast<void>(0) : requireFailed(#expression, __LINE__))

bool Dispatch(void*, ScriptCallFrame* frame) {
  REQUIRE(frame && frame->stableId == UINT32_C(2791701985));
  REQUIRE(frame->argumentCount == 1);
  REQUIRE(frame->arguments[0].tag == ScriptValueTag::kCallback);
  auto* callback = const_cast<ScriptCallback*>(
      static_cast<const ScriptCallback*>(frame->arguments[0].data));
  REQUIRE(callback && callback->invoke && callback->retain && callback->release);
  callback->retain(callback->context);
  if (gRetainMany) {
    REQUIRE(gRetainedManyCount < gRetainedMany.size());
    gRetainedMany[gRetainedManyCount++] = callback;
    frame->resultCount = 0;
    return true;
  }
  if (gRetained) gRetained->release(gRetained->context);
  gRetained = callback;
  frame->resultCount = 0;
  return true;
}

const char* LastError(void*) { return gError; }

bool Consume(void* opaque, const ScriptCallFrame* results) noexcept {
  auto* count = static_cast<uint32_t*>(opaque);
  REQUIRE(results);
  if (gExpectHandleResults) {
    REQUIRE(results->resultCount == 2);
    REQUIRE(results->matrix4Arena == gExpectedMatrices);
    REQUIRE(results->urlArena == gExpectedUrls);
    const float* matrix = results->matrix4Arena->resolve(results->results[0]);
    REQUIRE(matrix && matrix[0] == 101.0f && matrix[15] == 116.0f);
    ScriptResolvedUrl url{};
    REQUIRE(results->urlArena->resolve(
        results->results[1], results->urlArena->runtimeToken(), &url));
    REQUIRE(url.socket == 201 && url.reserved == 202 && url.path == 203 && url.fragment == 204);
    gReturnedMatrix = results->results[0];
    gReturnedUrl = results->results[1];
  } else {
    REQUIRE(results->resultCount == 1);
    REQUIRE(results->results[0].tag == ScriptValueTag::kNumber);
    REQUIRE(results->results[0].number == 42.5);
  }
  ++*count;
  return true;
}
}  // namespace

void* operator new(std::size_t size) {
  gAllocations.fetch_add(1, std::memory_order_relaxed);
  if (void* pointer = std::malloc(size)) return pointer;
  throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }

extern "C" void defoldHermesWebReleaseCallback(
    uint32_t runtime, uint32_t slot, uint32_t generation, uint32_t type) {
  REQUIRE(runtime == 7 && slot != UINT32_MAX && generation == 13 && type == 1);
  ++gReleases;
}

extern "C" int defoldHermesWebInvokeUniversalCallback(
    uint32_t runtime, uint32_t slot, uint32_t generation, uint32_t type,
    const DehermScriptUniversalValue* inputValues, uint32_t inputValueCount,
    const DehermScriptUniversalEntry* inputEntries, uint32_t inputEntryCount,
    const char* inputStrings, uint32_t inputStringBytes,
    const float* inputFloats, uint32_t inputFloatCount,
    const DehermScriptUniversalUrl* inputUrls, uint32_t inputUrlCount,
    const uint32_t* argumentRoots, uint32_t argumentCount,
    DehermScriptUniversalValue* outputValues, uint32_t outputValueCapacity,
    uint32_t* outputValueCount,
    DehermScriptUniversalEntry*, uint32_t, uint32_t* outputEntryCount,
    char*, uint32_t, uint32_t* outputStringBytes,
    float* outputFloats, uint32_t outputFloatCapacity, uint32_t* outputFloatCount,
    DehermScriptUniversalUrl* outputUrls, uint32_t outputUrlCapacity, uint32_t* outputUrlCount,
    uint32_t* resultRoots, uint32_t resultCapacity, uint32_t* resultCount,
    char* error, uint32_t errorCapacity) {
  REQUIRE(runtime == 7 && slot == 11 && generation == 13 && type == 1);
  REQUIRE((argumentCount == 2 || argumentCount == 4) && argumentRoots && inputValues && inputValueCount >= 4);
  const auto& number = inputValues[argumentRoots[0]];
  REQUIRE(number.tag == static_cast<uint8_t>(ScriptValueTag::kNumber));
  REQUIRE(number.number == 9.25);
  const auto& record = inputValues[argumentRoots[1]];
  REQUIRE(record.tag == static_cast<uint8_t>(ScriptValueTag::kTable));
  REQUIRE(record.auxiliary == static_cast<uint8_t>(ScriptTableKind::kRecord));
  REQUIRE(record.length == 1 && record.data_offset < inputEntryCount);
  const auto& key = inputValues[inputEntries[record.data_offset].key_index];
  REQUIRE(key.tag == static_cast<uint8_t>(ScriptValueTag::kString));
  REQUIRE(key.length == 4 && key.data_offset + key.length <= inputStringBytes);
  REQUIRE(std::memcmp(inputStrings + key.data_offset, "kind", 4) == 0);
  if (argumentCount == 4) {
    const auto& matrix = inputValues[argumentRoots[2]];
    REQUIRE(matrix.tag == static_cast<uint8_t>(ScriptValueTag::kDefoldValue));
    REQUIRE(matrix.defold_kind == static_cast<uint8_t>(ScriptDefoldValueKind::kMatrix4));
    REQUIRE(matrix.length == 16 && matrix.data_offset + 16 <= inputFloatCount);
    REQUIRE(inputFloats[matrix.data_offset] == 1.0f && inputFloats[matrix.data_offset + 15] == 16.0f);
    const auto& url = inputValues[argumentRoots[3]];
    REQUIRE(url.tag == static_cast<uint8_t>(ScriptValueTag::kHandle));
    REQUIRE(url.handle_kind == static_cast<uint8_t>(ScriptHandleKind::kUrl));
    REQUIRE(url.data_offset < inputUrlCount);
    REQUIRE(inputUrls[url.data_offset].socket == 11 && inputUrls[url.data_offset].reserved == 12 &&
        inputUrls[url.data_offset].path == 13 && inputUrls[url.data_offset].fragment == 14);
  }
  ++gInvocations;
  if (!gNested && !gFail) {
    gNested = true;
    ScriptValue nestedArguments[2]{};
    nestedArguments[0].tag = ScriptValueTag::kNumber;
    nestedArguments[0].number = 9.25;
    ScriptTableEntry nestedEntry{};
    const char nestedKey[] = "kind";
    nestedEntry.key.tag = ScriptValueTag::kString;
    nestedEntry.key.data = nestedKey;
    nestedEntry.key.length = 4;
    nestedEntry.value.tag = ScriptValueTag::kBoolean;
    nestedEntry.value.number = 1;
    nestedArguments[1].tag = ScriptValueTag::kTable;
    nestedArguments[1].reserved = static_cast<uint8_t>(ScriptTableKind::kRecord);
    nestedArguments[1].length = 1;
    nestedArguments[1].data = &nestedEntry;
    ScriptCallFrame nested{};
    nested.arguments = nestedArguments;
    nested.argumentCount = 2;
    uint32_t consumed = 0;
    char nestedError[128]{};
    const bool previousHandleExpectation = gExpectHandleResults;
    gExpectHandleResults = false;
    if (!gRetained->invoke(gRetained->context, &nested, &consumed, Consume,
            nestedError, sizeof(nestedError))) {
      std::cerr << "nested callback failed: " << nestedError << '\n';
      requireFailed("nested callback invocation", __LINE__);
    }
    gExpectHandleResults = previousHandleExpectation;
    REQUIRE(consumed == 1);
    gNested = false;
  }
  if (gFail) {
    std::snprintf(error, errorCapacity, "%s", "callback exploded");
    return 0;
  }
  if (argumentCount == 4) {
    REQUIRE(outputValueCapacity >= 2 && resultCapacity >= 2);
    REQUIRE(outputFloatCapacity >= 16 && outputFloats);
    REQUIRE(outputUrlCapacity >= 1 && outputUrls);
    outputValues[0] = {};
    outputValues[0].tag = static_cast<uint8_t>(ScriptValueTag::kDefoldValue);
    outputValues[0].defold_kind = static_cast<uint8_t>(ScriptDefoldValueKind::kMatrix4);
    outputValues[0].data_offset = 0;
    outputValues[0].length = 16;
    for (uint32_t index = 0; index < 16; ++index) outputFloats[index] = 101.0f + index;
    outputValues[1] = {};
    outputValues[1].tag = static_cast<uint8_t>(ScriptValueTag::kHandle);
    outputValues[1].handle_kind = static_cast<uint8_t>(ScriptHandleKind::kUrl);
    outputValues[1].data_offset = 0;
    outputValues[1].length = 1;
    outputUrls[0] = {201, 202, 203, 204};
    resultRoots[0] = 0;
    resultRoots[1] = 1;
    *outputValueCount = 2;
    *outputEntryCount = *outputStringBytes = 0;
    *outputFloatCount = 16;
    *outputUrlCount = 1;
    *resultCount = 2;
    return 1;
  }
  REQUIRE(outputValueCapacity >= 1 && resultCapacity >= 1);
  outputValues[0] = {};
  outputValues[0].tag = static_cast<uint8_t>(ScriptValueTag::kNumber);
  outputValues[0].number = 42.5;
  resultRoots[0] = 0;
  *outputValueCount = 1;
  *outputEntryCount = *outputStringBytes = *outputFloatCount = *outputUrlCount = 0;
  *resultCount = 1;
  return 1;
}

int main() {
  installScriptBridgeApi({nullptr, Dispatch, LastError, nullptr});
  DehermScriptUniversalValue callback{};
  callback.tag = static_cast<uint8_t>(ScriptValueTag::kCallback);
  callback.auxiliary = 1;
  callback.runtime = 7;
  callback.payload = (UINT64_C(13) << 32u) | 11u;
  const uint32_t root = 0;
  std::array<DehermScriptUniversalValue, DEHERM_SCRIPT_UNIVERSAL_MAX_VALUES> outputValues{};
  std::array<DehermScriptUniversalEntry, DEHERM_SCRIPT_UNIVERSAL_MAX_ENTRIES> outputEntries{};
  std::array<char, DEHERM_SCRIPT_UNIVERSAL_MAX_STRING_BYTES> outputStrings{};
  std::array<float, DEHERM_SCRIPT_UNIVERSAL_MAX_MATRIX4_VALUES * 16> outputFloats{};
  std::array<DehermScriptUniversalUrl, DEHERM_SCRIPT_UNIVERSAL_MAX_URL_VALUES> outputUrls{};
  std::array<uint32_t, DEHERM_SCRIPT_UNIVERSAL_MAX_RESULTS> resultRoots{};
  uint32_t outputValueCount = 0, outputEntryCount = 0, outputStringBytes = 0;
  uint32_t outputFloatCount = 0, outputUrlCount = 0, resultCount = 0;
  char error[128]{};
  REQUIRE(deherm_script_universal_dispatch(
      UINT32_C(2791701985), &callback, 1, nullptr, 0, nullptr, 0,
      nullptr, 0, nullptr, 0, &root, 1,
      outputValues.data(), outputValues.size(), &outputValueCount,
      outputEntries.data(), outputEntries.size(), &outputEntryCount,
      outputStrings.data(), outputStrings.size(), &outputStringBytes,
      outputFloats.data(), outputFloats.size(), &outputFloatCount,
      outputUrls.data(), outputUrls.size(), &outputUrlCount,
      resultRoots.data(), resultRoots.size(), &resultCount,
      error, sizeof(error)) == DEHERM_SCRIPT_UNIVERSAL_OK);
  REQUIRE(gRetained && gReleases == 0);

  ScriptValue arguments[4]{};
  arguments[0].tag = ScriptValueTag::kNumber;
  arguments[0].number = 9.25;
  ScriptTableEntry entry{};
  const char key[] = "kind";
  entry.key.tag = ScriptValueTag::kString;
  entry.key.data = key;
  entry.key.length = 4;
  entry.value.tag = ScriptValueTag::kBoolean;
  entry.value.number = 1;
  arguments[1].tag = ScriptValueTag::kTable;
  arguments[1].reserved = static_cast<uint8_t>(ScriptTableKind::kRecord);
  arguments[1].length = 1;
  arguments[1].data = &entry;
  ScriptMatrix4Arena callerMatrices{};
  ScriptUrlArena<32> callerUrls{91};
  alignas(16) float inputMatrix[16]{};
  for (uint32_t index = 0; index < 16; ++index) inputMatrix[index] = 1.0f + index;
  REQUIRE(callerMatrices.store(inputMatrix, &arguments[2]));
  REQUIRE(callerUrls.store({11, 12, 13, 14}, &arguments[3]));
  const ScriptValue originalMatrix = arguments[2];
  const ScriptValue originalUrl = arguments[3];
  ScriptCallFrame callbackFrame{};
  callbackFrame.arguments = arguments;
  callbackFrame.argumentCount = 4;
  callbackFrame.matrix4Arena = &callerMatrices;
  callbackFrame.urlArena = &callerUrls;
  gExpectedMatrices = &callerMatrices;
  gExpectedUrls = &callerUrls;
  gExpectHandleResults = true;
  uint32_t consumed = 0;
  REQUIRE(gRetained->invoke(gRetained->context, &callbackFrame, &consumed, Consume,
      error, sizeof(error)));
  REQUIRE(consumed == 1 && gInvocations == 2);
  REQUIRE(callerMatrices.used == 1 && callerUrls.used() == 1);
  REQUIRE(callerMatrices.resolve(originalMatrix));
  ScriptResolvedUrl originalResolved{};
  REQUIRE(callerUrls.resolve(originalUrl, 91, &originalResolved));
  REQUIRE(!callerMatrices.resolve(gReturnedMatrix));
  REQUIRE(!callerUrls.resolve(gReturnedUrl, 91, &originalResolved));

  gFail = true;
  REQUIRE(!gRetained->invoke(gRetained->context, &callbackFrame, &consumed, Consume,
      error, sizeof(error)));
  REQUIRE(std::strstr(error, "callback exploded"));
  gFail = false;

  const uint64_t baseline = gAllocations.load(std::memory_order_relaxed);
  for (uint32_t iteration = 0; iteration < 256; ++iteration) {
    uint32_t warmConsumed = 0;
    gNested = true;
    REQUIRE(gRetained->invoke(gRetained->context, &callbackFrame, &warmConsumed, Consume,
        error, sizeof(error)));
    gNested = false;
    REQUIRE(warmConsumed == 1);
  }
  REQUIRE(gAllocations.load(std::memory_order_relaxed) == baseline);
  gRetained->release(gRetained->context);
  gRetained = nullptr;
  REQUIRE(gReleases == 1);

  // Fill the fixed native descriptor pool without allocating, prove the next
  // token fails closed, then release and reuse every slot.
  const uint64_t poolBaseline = gAllocations.load(std::memory_order_relaxed);
  gRetainMany = true;
  for (uint32_t index = 0; index < DEHERM_SCRIPT_UNIVERSAL_BROWSER_CALLBACK_CAPACITY; ++index) {
    callback.payload = (UINT64_C(13) << 32u) | (UINT64_C(100) + index);
    REQUIRE(deherm_script_universal_dispatch(
        UINT32_C(2791701985), &callback, 1, nullptr, 0, nullptr, 0,
        nullptr, 0, nullptr, 0, &root, 1,
        outputValues.data(), outputValues.size(), &outputValueCount,
        outputEntries.data(), outputEntries.size(), &outputEntryCount,
        outputStrings.data(), outputStrings.size(), &outputStringBytes,
        outputFloats.data(), outputFloats.size(), &outputFloatCount,
        outputUrls.data(), outputUrls.size(), &outputUrlCount,
        resultRoots.data(), resultRoots.size(), &resultCount,
        error, sizeof(error)) == DEHERM_SCRIPT_UNIVERSAL_OK);
  }
  callback.payload = (UINT64_C(13) << 32u) | UINT64_C(5000);
  REQUIRE(deherm_script_universal_dispatch(
      UINT32_C(2791701985), &callback, 1, nullptr, 0, nullptr, 0,
      nullptr, 0, nullptr, 0, &root, 1,
      outputValues.data(), outputValues.size(), &outputValueCount,
      outputEntries.data(), outputEntries.size(), &outputEntryCount,
      outputStrings.data(), outputStrings.size(), &outputStringBytes,
      outputFloats.data(), outputFloats.size(), &outputFloatCount,
      outputUrls.data(), outputUrls.size(), &outputUrlCount,
      resultRoots.data(), resultRoots.size(), &resultCount,
      error, sizeof(error)) == DEHERM_SCRIPT_UNIVERSAL_ARENA_EXHAUSTED);
  REQUIRE(std::strstr(error, "callback pool is exhausted"));
  while (gRetainedManyCount) {
    ScriptCallback* retained = gRetainedMany[--gRetainedManyCount];
    gRetainedMany[gRetainedManyCount] = nullptr;
    retained->release(retained->context);
  }
  REQUIRE(gReleases == 1 + DEHERM_SCRIPT_UNIVERSAL_BROWSER_CALLBACK_CAPACITY);
  REQUIRE(gAllocations.load(std::memory_order_relaxed) == poolBaseline);
  gRetainMany = false;
  uninstallScriptBridgeApi();
  std::cout << "script-browser-callback:direct-memory-reentrant-error-lifetime-exhaustion:ok allocations:0\n";
}
