#include <defold_hermes/generated_dmsdk_fixed_digest.h>

int main(void)
{
    const uint8_t input[] = { 'a', 'b', 'c' };
    uint8_t output[64] = { 0 };
    if (deherm_dmsdk_fixed_digest_dm_crypt_hash_md5(input, UINT32_C(3), output, UINT32_C(15)) != UINT8_C(0)) return 1;
    if (deherm_dmsdk_fixed_digest_dm_crypt_hash_md5(input, UINT32_C(3), output, UINT32_C(16)) != UINT8_C(1)) return 2;
    return output[0] == UINT8_C(0x90) ? 0 : 3;
}
