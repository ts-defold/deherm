#include <defold_hermes/generated_dmsdk_base64_span.h>

#include <string.h>

int main(void)
{
    const uint8_t input[] = { 'a', 'b', 'c' };
    uint8_t output[5] = { 0 };
    uint32_t output_length = sizeof(output);
    if (deherm_dmsdk_base64_span_dm_crypt_base64_encode(input, UINT32_C(3), output, &output_length) != UINT8_C(1)) return 1;
    return output_length == UINT32_C(4) && memcmp(output, "YWJj", 4) == 0 ? 0 : 2;
}
