#include <defold_hermes/generated_dmsdk_scalar.h>

int main(void)
{
    if (deherm_dmsdk_endian_swap16_u16(UINT16_C(0x1234)) != UINT16_C(0x3412)) return 1;
    if (deherm_dmsdk_dm_endian_byte_swap_u32(UINT32_C(0x12345678)) != UINT32_C(0x78563412)) return 2;
    return 0;
}
