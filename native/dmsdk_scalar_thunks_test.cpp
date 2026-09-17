#include <defold_hermes/generated_dmsdk_scalar.h>

#include <cmath>
#include <cstdint>
#include <cstdio>

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

    if (g_Failures != 0) return 1;
    std::puts("dmsdk-scalar-thunks:ok");
    return 0;
}
