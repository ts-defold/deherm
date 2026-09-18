#include <defold_hermes/generated_dmsdk_scratch_scalar_out.h>

#include <stddef.h>

_Static_assert(DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS == 4, "scratch parameter capacity drifted");
_Static_assert(sizeof(((DehermDmSdkScratchDescriptor*)0)->parameter_kinds) == 4, "scratch kind array drifted");
_Static_assert(sizeof(((DehermDmSdkScratchDescriptor*)0)->handle_kinds) == 8, "scratch handle-kind array drifted");
_Static_assert(offsetof(DehermDmSdkScratchProvider, invoke) > offsetof(DehermDmSdkScratchProvider, validate_handle), "provider ABI ordering drifted");

int deherm_dmsdk_scratch_scalar_out_c_header_test(void)
{
    return (int) DEHERM_DMSDK_SCRATCH_PROVIDER_ABI;
}
