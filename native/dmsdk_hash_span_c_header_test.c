#include <defold_hermes/generated_dmsdk_hash_span.h>
#include <defold_hermes/generated_dmsdk_hash_span_runtime.h>

int main(void)
{
    static const uint8_t input[] = { 'f', 'o', 'o' };
    uint32_t raw_hash = 0;
    uint64_t hash = 0;
    if (deherm_dmsdk_hash_span_count() != UINT32_C(2)) return 1;
    if (deherm_dmsdk_hash_span_dm_hash_buffer32(input, UINT32_C(3), &raw_hash) != UINT8_C(1)
        || raw_hash != UINT32_C(0xd861e2f7)) return 2;
    if (deherm_dmsdk_hash_span_dispatch(UINT16_C(0), input, UINT32_C(3), &hash) != DEHERM_DMSDK_HASH_SPAN_OK) return 3;
    return hash == UINT64_C(0xd861e2f7) ? 0 : 4;
}
