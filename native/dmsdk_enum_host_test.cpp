#include <defold_hermes/generated_dmsdk_enum_value.h>
#include <defold_hermes/generated_dmsdk_enum_value_runtime.h>

#include <atomic>
#include <cstdlib>
#include <new>

namespace
{
    std::atomic<bool> g_Count(false);
    std::atomic<unsigned long long> g_Allocations(0);
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
    if (deherm_dmsdk_enum_count() != 7) return 1;
    uint64_t argument = 0;
    uint64_t result = 0;
    if (deherm_dmsdk_enum_dispatch(0, &argument, 1, &result) != DEHERM_DMSDK_ENUM_OK || result != 1) return 2;
    argument = 3;
    if (deherm_dmsdk_enum_dispatch(0, &argument, 1, &result) != DEHERM_DMSDK_ENUM_OK || result != 8) return 3;
    argument = 8;
    if (deherm_dmsdk_enum_dispatch(0, &argument, 1, &result) != DEHERM_DMSDK_ENUM_OK || result != 4) return 4;
    argument = 9;
    if (deherm_dmsdk_enum_dispatch(0, &argument, 1, &result) != DEHERM_DMSDK_ENUM_INVALID_ENUM) return 5;

    if (deherm_dmsdk_enum_dispatch(3, nullptr, 0, &result) != DEHERM_DMSDK_ENUM_OK) return 6;
    const uint64_t previous = result;
    argument = 4;
    if (deherm_dmsdk_enum_dispatch(4, &argument, 1, &result) != DEHERM_DMSDK_ENUM_OK) return 7;
    if (deherm_dmsdk_enum_dispatch(3, nullptr, 0, &result) != DEHERM_DMSDK_ENUM_OK || result != 4) return 8;
    if (deherm_dmsdk_enum_dispatch(4, &previous, 1, &result) != DEHERM_DMSDK_ENUM_OK) return 9;

    argument = 0;
    deherm_dmsdk_enum_dispatch(0, &argument, 1, &result);
    g_Allocations.store(0, std::memory_order_relaxed);
    g_Count.store(true, std::memory_order_relaxed);
    for (unsigned int iteration = 0; iteration < 100000; ++iteration)
        if (deherm_dmsdk_enum_dispatch(0, &argument, 1, &result) != DEHERM_DMSDK_ENUM_OK) return 10;
    g_Count.store(false, std::memory_order_relaxed);
    if (g_Allocations.load(std::memory_order_relaxed) != 0) return 11;
    return 0;
}
