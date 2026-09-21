#include <defold_hermes/generated_dmsdk_named_scalar_runtime.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>

extern "C" int dmsdk_named_scalar_c_abi_header_check(void);
extern "C" int deherm_dmsdk_named_scalar_exact_verify(void);

namespace {
std::atomic<bool> g_count_allocations(false);
std::atomic<uint64_t> g_allocations(0);
}

void* operator new(std::size_t size)
{
    if (g_count_allocations.load(std::memory_order_relaxed)) g_allocations.fetch_add(1, std::memory_order_relaxed);
    if (void* result = std::malloc(size)) return result;
    throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }

int main()
{
    if (dmsdk_named_scalar_c_abi_header_check() != 0) return 1;
    if (deherm_dmsdk_named_scalar_count() != UINT32_C(20)) return 1;
    if (deherm_dmsdk_named_scalar_descriptors() == nullptr) return 1;
    if (deherm_dmsdk_named_scalar_exact_verify() != 0) return 1;
    uint64_t result = 0;
    if (deherm_dmsdk_named_scalar_dispatch(UINT16_C(20), nullptr, 0, &result) != DEHERM_DMSDK_NAMED_SCALAR_UNKNOWN_ID) return 1;
    g_allocations.store(0, std::memory_order_relaxed);
    g_count_allocations.store(true, std::memory_order_relaxed);
    for (uint32_t index = 0; index < UINT32_C(100000); ++index)
        if (deherm_dmsdk_named_scalar_dispatch(UINT16_C(0), nullptr, 0, &result) != DEHERM_DMSDK_NAMED_SCALAR_OK) return 1;
    g_count_allocations.store(false, std::memory_order_relaxed);
    if (g_allocations.load(std::memory_order_relaxed) != UINT64_C(0)) return 1;
    std::puts("dmsdk-named-scalar-runtime:ok");
    return 0;
}
