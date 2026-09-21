#include <defold_hermes/generated_dmsdk_hash_state.h>

#include <atomic>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>

extern "C" uint32_t deherm_dmsdk_hash_state_exact_calls(uint16_t id);

namespace {
std::atomic<uint64_t> g_allocations{0};
bool g_count_allocations = false;

#define CHECK(expression) do { if (!(expression)) { std::fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #expression); return 1; } } while (0)

DehermDmSdkHashStateStatus call(uint16_t id, uint64_t handle, const uint8_t* input,
                                uint32_t length, uint8_t reverse, uint64_t* output) {
  return deherm_dmsdk_hash_state_dispatch(id, handle, input, length, reverse, output);
}
}

void* operator new(std::size_t size) {
  if (g_count_allocations) ++g_allocations;
  if (void* value = std::malloc(size)) return value;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

int main() {
  CHECK(deherm_dmsdk_hash_state_count() == 10);
  const auto* descriptors = deherm_dmsdk_hash_state_descriptors();
  for (uint16_t id = 0; id < 10; ++id) CHECK(descriptors[id].id == id);

  uint64_t handles[DEHERM_DMSDK_HASH_STATE_CAPACITY_PER_WIDTH]{};
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 0, nullptr, 0, 0, &handles[0]) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(handles[0] != 0);
  for (uint32_t i = 1; i < DEHERM_DMSDK_HASH_STATE_CAPACITY_PER_WIDTH; ++i) {
    CHECK(call(DEHERM_DMSDK_HASH_STATE_CLONE_32, handles[0], nullptr, 0, 0, &handles[i]) == DEHERM_DMSDK_HASH_STATE_OK);
    CHECK(handles[i] != handles[0]);
  }
  uint64_t output = UINT64_C(0xffff);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_CLONE_32, handles[0], nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_CAPACITY_EXHAUSTED);
  CHECK(output == 0);
  for (uint64_t handle : handles) CHECK(call(DEHERM_DMSDK_HASH_STATE_RELEASE_32, handle, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_RELEASE_32, handles[0], nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE);

  uint64_t h32 = 0;
  uint64_t h64 = 0;
  const uint8_t unexpected[] = {0};
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 1, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 0, unexpected, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 0, nullptr, 0, 2, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 0, nullptr, 0, 0, &h32) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_64, 0, nullptr, 0, 0, &h64) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(h32 != handles[0]);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_CLONE_32, h32, unexpected, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_CLONE_32, h32, nullptr, 0, 2, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_32, h64, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_32, h32 ^ UINT64_C(0x1000000000000000), nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_32, h32, nullptr, 0, 1, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_32, h32, nullptr, 1, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  const uint8_t bytes[] = {1, 2, 3, 4};
  CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_32, h32, bytes, UINT32_MAX, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_32, h32, bytes, 4, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_FINAL_32, h32, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(output == 13);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_FINAL_32, h32, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_HANDLE);
  CHECK(output == 0);

  uint64_t strict = 0;
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 0, nullptr, 0, 0, &strict) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_FINAL_32, strict, unexpected, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_RELEASE_32, strict, nullptr, 0, 1, &output) == DEHERM_DMSDK_HASH_STATE_INVALID_ARGUMENT);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_RELEASE_32, strict, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);

  uint64_t clone64 = 0;
  CHECK(call(DEHERM_DMSDK_HASH_STATE_CLONE_64, h64, nullptr, 0, 1, &clone64) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_64, clone64, bytes, 4, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_FINAL_64, clone64, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(output == 25);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_RELEASE_64, h64, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);

  uint64_t warm = 0;
  CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 0, nullptr, 0, 0, &warm) == DEHERM_DMSDK_HASH_STATE_OK);
  CHECK(call(DEHERM_DMSDK_HASH_STATE_RELEASE_32, warm, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
  g_allocations = 0;
  g_count_allocations = true;
  for (uint32_t i = 0; i < 100000; ++i) {
    CHECK(call(DEHERM_DMSDK_HASH_STATE_INIT_32, 0, nullptr, 0, 0, &warm) == DEHERM_DMSDK_HASH_STATE_OK);
    CHECK(call(DEHERM_DMSDK_HASH_STATE_UPDATE_BUFFER_32, warm, bytes, 4, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
    CHECK(call(DEHERM_DMSDK_HASH_STATE_FINAL_32, warm, nullptr, 0, 0, &output) == DEHERM_DMSDK_HASH_STATE_OK);
  }
  g_count_allocations = false;
  CHECK(g_allocations.load() == 0);
  for (uint16_t id = 0; id < 10; ++id) CHECK(deherm_dmsdk_hash_state_exact_calls(id) > 0);
  std::puts("dmsdk-hash-state:ok allocations=0 iterations=100000");
  return 0;
}
