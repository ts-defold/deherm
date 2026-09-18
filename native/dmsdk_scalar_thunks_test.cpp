#include <defold_hermes/generated_dmsdk_scalar.h>
#include <defold_hermes/generated_dmsdk_scalar_runtime.h>

#include <cmath>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <new>

namespace
{
    std::atomic<bool> g_CountAllocations(false);
    std::atomic<uint64_t> g_AllocationCount(0);
}

void* operator new(std::size_t size)
{
    if (g_CountAllocations.load(std::memory_order_relaxed))
        g_AllocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* result = std::malloc(size)) return result;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size)
{
    return ::operator new(size);
}

void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete[](void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { std::free(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { std::free(pointer); }

namespace
{
    int g_Failures = 0;

    void Check(bool condition, const char* expression, int line)
    {
        if (!condition)
        {
            std::fprintf(stderr, "dmsdk-scalar check failed at line %d: %s\n", line, expression);
            ++g_Failures;
        }
    }
}

#define CHECK(expression) Check((expression), #expression, __LINE__)

int main()
{
    CHECK(deherm_dmsdk_scalar_count() == UINT32_C(26));
    const DehermDmSdkScalarDescriptor* descriptors = deherm_dmsdk_scalar_descriptors();
    uint32_t native_js_count = 0;
    uint32_t browser_js_count = 0;
    for (uint16_t id = 0; id < deherm_dmsdk_scalar_count(); ++id)
    {
        const DehermDmSdkScalarDescriptor& descriptor = descriptors[id];
        CHECK(descriptor.id == id);
        CHECK(descriptor.declaration_id != nullptr);
        CHECK(descriptor.symbol != nullptr);
        native_js_count += (descriptor.flags & DEHERM_DMSDK_SCALAR_NATIVE_JS) != 0;
        browser_js_count += (descriptor.flags & DEHERM_DMSDK_SCALAR_BROWSER_JS) != 0;

        uint64_t arguments[DEHERM_DMSDK_SCALAR_MAX_ARGUMENTS] = { UINT64_C(0) };
        if (descriptor.argument_count != 0)
        {
            switch (descriptor.argument_kinds[0])
            {
                case DEHERM_DMSDK_SCALAR_U16: arguments[0] = UINT16_C(0x1234); break;
                case DEHERM_DMSDK_SCALAR_U32: arguments[0] = UINT32_C(0x20); break;
                case DEHERM_DMSDK_SCALAR_U64: arguments[0] = UINT64_C(0x0123456789abcdef); break;
                case DEHERM_DMSDK_SCALAR_F32: {
                    const float value = 0.375f;
                    uint32_t bits = 0;
                    std::memcpy(&bits, &value, sizeof(bits));
                    arguments[0] = bits;
                    break;
                }
                default: break;
            }
        }
        uint64_t result = UINT64_C(0);
        CHECK(deherm_dmsdk_scalar_dispatch(id, arguments, descriptor.argument_count, &result) ==
              DEHERM_DMSDK_SCALAR_OK);
    }
    CHECK(native_js_count == UINT32_C(26));
    CHECK(browser_js_count == UINT32_C(16));
    uint64_t ignored = 0;
    CHECK(deherm_dmsdk_scalar_dispatch(UINT16_C(26), nullptr, 0, &ignored) ==
          DEHERM_DMSDK_SCALAR_UNKNOWN_ID);

    // The generated dispatch hot path is stack-only. Warm it first so any
    // process/runtime one-time work cannot be mistaken for glue allocation.
    uint64_t allocationArguments[DEHERM_DMSDK_SCALAR_MAX_ARGUMENTS] = { UINT32_C(0x12345678) };
    CHECK(deherm_dmsdk_scalar_dispatch(UINT16_C(1), allocationArguments, 1, &ignored) ==
          DEHERM_DMSDK_SCALAR_OK);
    g_AllocationCount.store(0, std::memory_order_relaxed);
    g_CountAllocations.store(true, std::memory_order_relaxed);
    for (uint32_t iteration = 0; iteration < UINT32_C(100000); ++iteration)
    {
        if (deherm_dmsdk_scalar_dispatch(UINT16_C(1), allocationArguments, 1, &ignored) !=
            DEHERM_DMSDK_SCALAR_OK)
            ++g_Failures;
    }
    g_CountAllocations.store(false, std::memory_order_relaxed);
    CHECK(g_AllocationCount.load(std::memory_order_relaxed) == UINT64_C(0));

    CHECK(deherm_dmsdk_endian_swap16_u16(UINT16_C(0x1234)) == UINT16_C(0x3412));
    CHECK(deherm_dmsdk_endian_swap32_u32(UINT32_C(0x12345678)) == UINT32_C(0x78563412));
    CHECK(deherm_dmsdk_endian_swap64_u64(UINT64_C(0x0123456789abcdef)) == UINT64_C(0xefcdab8967452301));
    CHECK(deherm_dmsdk_dm_endian_byte_swap_u16(UINT16_C(0x1234)) == UINT16_C(0x3412));
    CHECK(deherm_dmsdk_dm_endian_byte_swap_u32(UINT32_C(0x12345678)) == UINT32_C(0x78563412));
    CHECK(deherm_dmsdk_dm_endian_byte_swap_u64(UINT64_C(0x0123456789abcdef)) == UINT64_C(0xefcdab8967452301));

    const uint16_t u16 = UINT16_C(0x1357);
    const uint32_t u32 = UINT32_C(0x13579bdf);
    const uint64_t u64 = UINT64_C(0x0123456789abcdef);
    const bool littleEndian = *reinterpret_cast<const uint8_t*>(&u16) == UINT8_C(0x57);
    const uint16_t network16 = littleEndian ? UINT16_C(0x5713) : u16;
    const uint32_t network32 = littleEndian ? UINT32_C(0xdf9b5713) : u32;
    const uint64_t network64 = littleEndian ? UINT64_C(0xefcdab8967452301) : u64;
    CHECK(deherm_dmsdk_endian_to_network16_u16(u16) == network16);
    CHECK(deherm_dmsdk_endian_to_network32_u32(u32) == network32);
    CHECK(deherm_dmsdk_endian_to_network64_u64(u64) == network64);
    CHECK(deherm_dmsdk_endian_to_host16_u16(network16) == u16);
    CHECK(deherm_dmsdk_endian_to_host32_u32(network32) == u32);
    CHECK(deherm_dmsdk_endian_to_host64_u64(network64) == u64);
    CHECK(deherm_dmsdk_dm_endian_to_network_u16(u16) == network16);
    CHECK(deherm_dmsdk_dm_endian_to_network_u32(u32) == network32);
    CHECK(deherm_dmsdk_dm_endian_to_network_u64(u64) == network64);
    CHECK(deherm_dmsdk_dm_endian_to_host_u16(network16) == u16);
    CHECK(deherm_dmsdk_dm_endian_to_host_u32(network32) == u32);
    CHECK(deherm_dmsdk_dm_endian_to_host_u64(network64) == u64);
    CHECK(deherm_dmsdk_endian_to_host16_u16(deherm_dmsdk_endian_to_network16_u16(u16)) == u16);
    CHECK(deherm_dmsdk_endian_to_host32_u32(deherm_dmsdk_endian_to_network32_u32(u32)) == u32);
    CHECK(deherm_dmsdk_endian_to_host64_u64(deherm_dmsdk_endian_to_network64_u64(u64)) == u64);
    CHECK(deherm_dmsdk_dm_endian_to_host_u16(deherm_dmsdk_dm_endian_to_network_u16(u16)) == u16);
    CHECK(deherm_dmsdk_dm_endian_to_host_u32(deherm_dmsdk_dm_endian_to_network_u32(u32)) == u32);
    CHECK(deherm_dmsdk_dm_endian_to_host_u64(deherm_dmsdk_dm_endian_to_network_u64(u64)) == u64);

    CHECK(deherm_dmsdk_dm_utf8_is_white_space_u32(UINT32_C(0x20)) == UINT8_C(1));
    CHECK(deherm_dmsdk_dm_utf8_is_white_space_u32(UINT32_C(65)) == UINT8_C(0));
    CHECK(deherm_dmsdk_dm_utf8_is_breaking_u32(UINT32_C(0x0a)) == UINT8_C(1));
    CHECK(deherm_dmsdk_dm_utf8_is_breaking_u32(UINT32_C(0x00a0)) == UINT8_C(0));

    const float angle = 0.375f;
    CHECK(std::fabs(deherm_dmsdk_dm_trig_lookup_cos_f32(angle) - std::cos(angle)) < 0.0011f);
    CHECK(std::fabs(deherm_dmsdk_dm_trig_lookup_sin_f32(angle) - std::sin(angle)) < 0.0011f);

    CHECK(deherm_dmsdk_dm_time_get_time_v() > UINT64_C(0));
    const uint64_t before = deherm_dmsdk_dm_time_get_monotonic_time_v();
    deherm_dmsdk_dm_time_sleep_u32(UINT32_C(1000));
    const uint64_t after = deherm_dmsdk_dm_time_get_monotonic_time_v();
    CHECK(after >= before);
    CHECK(after - before >= UINT64_C(500));
    CHECK(deherm_dmsdk_profile_is_initialized_v() == UINT8_C(0));

    if (g_Failures != 0) return 1;
    std::puts("dmsdk-scalar-thunks:ok");
    return 0;
}
