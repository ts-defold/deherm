#include <defold_hermes/generated_dmsdk_base64_span_runtime.h>

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <new>

namespace { std::atomic<bool> g_Count(false); std::atomic<unsigned long long> g_Allocations(0); constexpr uint8_t kPlain[] = { 'a', 'b', 'c' }; constexpr uint8_t kEncoded[] = { 'Y', 'W', 'J', 'j' }; }
void* operator new(std::size_t size) { if (g_Count.load(std::memory_order_relaxed)) g_Allocations.fetch_add(1, std::memory_order_relaxed); if (void* value = std::malloc(size)) return value; throw std::bad_alloc(); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

int main()
{
    uint8_t output[8] = {}; uint32_t written = 0;
    if (deherm_dmsdk_base64_span_count() != 2) return 1;
    if (deherm_dmsdk_base64_span_dispatch(2, kPlain, 3, nullptr, 0, &written) != DEHERM_DMSDK_BASE64_SPAN_UNKNOWN_ID) return 2;
    if (deherm_dmsdk_base64_span_dispatch(0, kPlain, 3, nullptr, 0, &written) != DEHERM_DMSDK_BASE64_SPAN_NONCANONICAL_INPUT) return 3;
    const uint8_t invalid[] = { '!', '!', '!', '!' };
    if (deherm_dmsdk_base64_span_dispatch(0, invalid, 4, nullptr, 0, &written) != DEHERM_DMSDK_BASE64_SPAN_NONCANONICAL_INPUT) return 10;
    const uint8_t noncanonical_two_pad[] = { 'A', 'B', '=', '=' };
    if (deherm_dmsdk_base64_span_dispatch(0, noncanonical_two_pad, 4, nullptr, 0, &written) != DEHERM_DMSDK_BASE64_SPAN_NONCANONICAL_INPUT) return 11;
    const uint8_t noncanonical_one_pad[] = { 'A', 'A', 'B', '=' };
    if (deherm_dmsdk_base64_span_dispatch(0, noncanonical_one_pad, 4, nullptr, 0, &written) != DEHERM_DMSDK_BASE64_SPAN_NONCANONICAL_INPUT) return 12;
    if (deherm_dmsdk_base64_span_dispatch(1, kPlain, 3, nullptr, 0, &written) != DEHERM_DMSDK_BASE64_SPAN_QUERY || written != 5) return 4;
    if (deherm_dmsdk_base64_span_dispatch(1, kPlain, 3, output, 5, &written) != DEHERM_DMSDK_BASE64_SPAN_OK || written != 4 || std::memcmp(output, kEncoded, 4) != 0) return 5;
    if (deherm_dmsdk_base64_span_dispatch(0, kEncoded, 4, nullptr, 0, &written) != DEHERM_DMSDK_BASE64_SPAN_QUERY || written != 3) return 6;
    if (deherm_dmsdk_base64_span_dispatch(0, kEncoded, 4, output, 3, &written) != DEHERM_DMSDK_BASE64_SPAN_OK || written != 3 || std::memcmp(output, kPlain, 3) != 0) return 7;
    deherm_dmsdk_base64_span_dispatch(0, kEncoded, 4, output, 3, &written);
    g_Allocations.store(0, std::memory_order_relaxed); g_Count.store(true, std::memory_order_relaxed);
    for (unsigned int iteration = 0; iteration < 100000; ++iteration) if (deherm_dmsdk_base64_span_dispatch(0, kEncoded, 4, output, 3, &written) != DEHERM_DMSDK_BASE64_SPAN_OK) return 8;
    g_Count.store(false, std::memory_order_relaxed);
    return g_Allocations.load(std::memory_order_relaxed) == 0 ? 0 : 9;
}
