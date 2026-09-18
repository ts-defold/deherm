#include <defold_hermes/generated_dmsdk_fixed_digest_runtime.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <new>

namespace {
std::atomic<bool> g_Count(false);
std::atomic<unsigned long long> g_Allocations(0);
constexpr uint8_t kInput[] = { 'a', 'b', 'c' };
constexpr uint8_t kExpected[][64] = {
    { 0x90, 0x01, 0x50, 0x98, 0x3c, 0xd2, 0x4f, 0xb0, 0xd6, 0x96, 0x3f, 0x7d, 0x28, 0xe1, 0x7f, 0x72 },
    { 0xa9, 0x99, 0x3e, 0x36, 0x47, 0x06, 0x81, 0x6a, 0xba, 0x3e, 0x25, 0x71, 0x78, 0x50, 0xc2, 0x6c, 0x9c, 0xd0, 0xd8, 0x9d },
    { 0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad },
    { 0xdd, 0xaf, 0x35, 0xa1, 0x93, 0x61, 0x7a, 0xba, 0xcc, 0x41, 0x73, 0x49, 0xae, 0x20, 0x41, 0x31, 0x12, 0xe6, 0xfa, 0x4e, 0x89, 0xa9, 0x7e, 0xa2, 0x0a, 0x9e, 0xee, 0xe6, 0x4b, 0x55, 0xd3, 0x9a, 0x21, 0x92, 0x99, 0x2a, 0x27, 0x4f, 0xc1, 0xa8, 0x36, 0xba, 0x3c, 0x23, 0xa3, 0xfe, 0xeb, 0xbd, 0x45, 0x4d, 0x44, 0x23, 0x64, 0x3c, 0xe8, 0x0e, 0x2a, 0x9a, 0xc9, 0x4f, 0xa5, 0x4c, 0xa4, 0x9f }
};
}

void* operator new(std::size_t size) { if (g_Count.load(std::memory_order_relaxed)) g_Allocations.fetch_add(1, std::memory_order_relaxed); if (void* value = std::malloc(size)) return value; throw std::bad_alloc(); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

int main()
{
    if (deherm_dmsdk_fixed_digest_count() != 4) return 1;
    uint8_t output[DEHERM_DMSDK_FIXED_DIGEST_MAX_BYTES] = {};
    uint32_t written = 0;
    if (deherm_dmsdk_fixed_digest_dispatch(4, kInput, 3, output, sizeof(output), &written) != DEHERM_DMSDK_FIXED_DIGEST_UNKNOWN_ID) return 2;
    if (deherm_dmsdk_fixed_digest_dispatch(0, nullptr, 1, output, sizeof(output), &written) != DEHERM_DMSDK_FIXED_DIGEST_NULL_STORAGE) return 3;
    if (deherm_dmsdk_fixed_digest_dispatch(0, kInput, 3, output, 15, &written) != DEHERM_DMSDK_FIXED_DIGEST_OUTPUT_TOO_SMALL) return 4;
    for (uint16_t id = 0; id < deherm_dmsdk_fixed_digest_count(); ++id) {
        std::memset(output, 0, sizeof(output));
        if (deherm_dmsdk_fixed_digest_dispatch(id, kInput, 3, output, sizeof(output), &written) != DEHERM_DMSDK_FIXED_DIGEST_OK) return 5;
        if (written != deherm_dmsdk_fixed_digest_descriptors()[id].digest_bytes) return 6;
        if (std::memcmp(output, kExpected[id], written) != 0) return 7;
    }
    deherm_dmsdk_fixed_digest_dispatch(2, kInput, 3, output, sizeof(output), &written);
    g_Allocations.store(0, std::memory_order_relaxed);
    g_Count.store(true, std::memory_order_relaxed);
    for (unsigned int iteration = 0; iteration < 100000; ++iteration)
        if (deherm_dmsdk_fixed_digest_dispatch(2, kInput, 3, output, sizeof(output), &written) != DEHERM_DMSDK_FIXED_DIGEST_OK) return 8;
    g_Count.store(false, std::memory_order_relaxed);
    return g_Allocations.load(std::memory_order_relaxed) == 0 ? 0 : 9;
}
