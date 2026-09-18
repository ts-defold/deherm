#include <defold_hermes/generated_dmsdk_enum_value.h>

// Host-only link stubs for bindings whose real implementations require a live
// Defold graphics or sound context. The host runtime test never dispatches to
// these IDs; packaged-SDK object compilation still validates the real wrappers.
extern "C" {
int32_t deherm_dmsdk_enum_dm_graphics_get_installed_adapter_family_v(void) { return -1; }
int32_t deherm_dmsdk_enum_dm_sound_set_group_mute_u64_bool(uint64_t, uint8_t) { return -1000; }
int32_t deherm_dmsdk_enum_dm_sound_toggle_group_mute_u64(uint64_t) { return -1000; }
}
