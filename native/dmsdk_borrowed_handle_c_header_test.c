#include <defold_hermes/generated_dmsdk_borrowed_handle.h>

_Static_assert(sizeof(DehermDmSdkBorrowedStatus) == sizeof(unsigned int), "status ABI width");
_Static_assert(DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS == 8, "argument storage drift");

int deherm_dmsdk_borrowed_c_header_probe(void)
{
    DehermDmSdkBorrowedProvider provider = {0};
    return (int) provider.abi_version;
}
