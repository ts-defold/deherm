#include <defold_hermes/generated_dmsdk_enum_value.h>

// Host-runner-only link stand-ins. Shipping Defold extensions compile the
// generated per-module wrappers instead, so those builds resolve the actual
// dmSDK functions from the engine.
extern "C" {
uint32_t deherm_dmsdk_enum_dm_buffer_get_size_for_value_type_i32(int32_t) {
  return 0;
}

int32_t deherm_dmsdk_enum_dm_graphics_get_installed_adapter_family_v(void) {
  return -1;
}

void deherm_dmsdk_enum_dm_log_setlevel_i32(int32_t) {}

int32_t deherm_dmsdk_enum_dm_log_get_level_v(void) {
  return 0;
}

void deherm_dmsdk_enum_dm_log_set_level_i32(int32_t) {}

int32_t deherm_dmsdk_enum_dm_sound_set_group_mute_u64_bool(uint64_t, uint8_t) {
  return -1000;
}

int32_t deherm_dmsdk_enum_dm_sound_toggle_group_mute_u64(uint64_t) {
  return -1000;
}
}
