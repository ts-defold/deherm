#include <defold_hermes/generated_dmsdk_hash_span_runtime.h>

#include <atomic>
#include <cstdlib>
#include <new>

namespace {
std::atomic<bool> g_Count(false);
std::atomic<unsigned long long> g_Allocations(0);
constexpr uint8_t kFoo[] = { 'f', 'o', 'o' };
constexpr uint8_t kEmbeddedNull[] = { 'f', 0, 'o' };
}

void* operator new(std::size_t size)
{
    if (g_Count.load(std::memory_order_relaxed)) g_Allocations.fetch_add(1, std::memory_order_relaxed);
    if (void* value = std::malloc(size)) return value;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

int main()
{
    if (deherm_dmsdk_hash_span_count() != UINT32_C(2)) return 1;
    const DehermDmSdkHashSpanDescriptor* descriptors = deherm_dmsdk_hash_span_descriptors();
    if (descriptors == nullptr || descriptors[0].id != 0 || descriptors[0].result_bits != 32
        || descriptors[1].id != 1 || descriptors[1].result_bits != 64) return 2;

    uint64_t hash = 0;
    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(2), kFoo, UINT32_C(3), &hash) != DEHERM_DMSDK_HASH_SPAN_UNKNOWN_ID) return 3;
    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(0), kFoo, UINT32_C(3), nullptr) != DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE) return 4;
    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(0), nullptr, UINT32_C(1), &hash) != DEHERM_DMSDK_HASH_SPAN_NULL_STORAGE) return 5;
    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(0), nullptr, UINT32_C(0), &hash) != DEHERM_DMSDK_HASH_SPAN_OK) return 6;

    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(0), kFoo, UINT32_C(3), &hash) != DEHERM_DMSDK_HASH_SPAN_OK
        || hash != UINT64_C(0xd861e2f7)) return 7;
    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(1), kFoo, UINT32_C(3), &hash) != DEHERM_DMSDK_HASH_SPAN_OK
        || hash != UINT64_C(0x97b476b3e71147f7)) return 8;
    const uint64_t fooHash = hash;
    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(1), kEmbeddedNull, UINT32_C(3), &hash) != DEHERM_DMSDK_HASH_SPAN_OK
        || hash == fooHash) return 9;

    deherm_dmsdk_hash_span_dispatch(UINT16_C(1), kFoo, UINT32_C(3), &hash);
    g_Allocations.store(0, std::memory_order_relaxed);
    g_Count.store(true, std::memory_order_relaxed);
    for (uint32_t iteration = 0; iteration < UINT32_C(100000); ++iteration) {
        if (deherm_dmsdk_hash_span_dispatch(UINT16_C(1), kFoo, UINT32_C(3), &hash) != DEHERM_DMSDK_HASH_SPAN_OK) return 10;
    }
    g_Count.store(false, std::memory_order_relaxed);
    return g_Allocations.load(std::memory_order_relaxed) == 0 ? 0 : 11;
}
