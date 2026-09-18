#include <defold_hermes/generated_dmsdk_named_scalar.h>
#include <defold_hermes/generated_dmsdk_named_scalar_runtime.h>

int dmsdk_named_scalar_c_abi_header_check(void)
{
    return deherm_dmsdk_named_scalar_count() == 0 ? 0 : 1;
}
