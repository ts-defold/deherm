// Materialised by scripts/assemble-typed-native-extension.mjs. Do not edit.
//
// C++ adaptation for one `shermes -emit-c` unit. See the note at the top of
// the assembler: Extender compiles this extension's sources with the same C++
// settings as `defold_hermes`, and `void*` does not implicitly convert to a
// typed pointer there. One overload per `extern_c` callee restores the exact
// call, with the cast written out instead of implied.
#pragma once

#include <defold_hermes/generated_script_universal_static_frame.h>
#include <hermes/VM/static_h.h>

static inline uint32_t deherm_script_static_dispatch(void* frame, uint32_t stable_id, uint32_t argument_count) { return deherm_script_static_dispatch(static_cast<DehermScriptUniversalStaticFrame*>(frame), stable_id, argument_count); }
static inline uint32_t deherm_script_static_entry_key(void* frame, uint32_t table_index, uint32_t entry) { return deherm_script_static_entry_key(static_cast<const DehermScriptUniversalStaticFrame*>(frame), table_index, entry); }
static inline uint32_t deherm_script_static_entry_value(void* frame, uint32_t table_index, uint32_t entry) { return deherm_script_static_entry_value(static_cast<const DehermScriptUniversalStaticFrame*>(frame), table_index, entry); }
static inline char* deherm_script_static_error(void* frame) { return deherm_script_static_error(static_cast<DehermScriptUniversalStaticFrame*>(frame)); }
static inline void deherm_script_static_frame_release(void* frame) { deherm_script_static_frame_release(static_cast<DehermScriptUniversalStaticFrame*>(frame)); }
static inline uint32_t deherm_script_static_push_boolean(void* frame, uint8_t value) { return deherm_script_static_push_boolean(static_cast<DehermScriptUniversalStaticFrame*>(frame), value); }
static inline uint32_t deherm_script_static_push_defold_value(void* frame, uint8_t kind, float x, float y, float z, float w) { return deherm_script_static_push_defold_value(static_cast<DehermScriptUniversalStaticFrame*>(frame), kind, x, y, z, w); }
static inline uint32_t deherm_script_static_push_handle(void* frame, uint8_t kind, uint8_t semantic_kind, uint32_t runtime, uint32_t payload_low, uint32_t payload_high) { return deherm_script_static_push_handle(static_cast<DehermScriptUniversalStaticFrame*>(frame), kind, semantic_kind, runtime, payload_low, payload_high); }
static inline uint32_t deherm_script_static_push_matrix4(void* frame, float e0, float e1, float e2, float e3, float e4, float e5, float e6, float e7, float e8, float e9, float e10, float e11, float e12, float e13, float e14, float e15) { return deherm_script_static_push_matrix4(static_cast<DehermScriptUniversalStaticFrame*>(frame), e0, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12, e13, e14, e15); }
static inline uint32_t deherm_script_static_push_null(void* frame) { return deherm_script_static_push_null(static_cast<DehermScriptUniversalStaticFrame*>(frame)); }
static inline uint32_t deherm_script_static_push_number(void* frame, double value) { return deherm_script_static_push_number(static_cast<DehermScriptUniversalStaticFrame*>(frame), value); }
static inline uint32_t deherm_script_static_push_string(void* frame, uint32_t byte_length) { return deherm_script_static_push_string(static_cast<DehermScriptUniversalStaticFrame*>(frame), byte_length); }
static inline uint32_t deherm_script_static_push_table(void* frame, uint8_t kind, uint32_t length) { return deherm_script_static_push_table(static_cast<DehermScriptUniversalStaticFrame*>(frame), kind, length); }
static inline uint32_t deherm_script_static_push_undefined(void* frame) { return deherm_script_static_push_undefined(static_cast<DehermScriptUniversalStaticFrame*>(frame)); }
static inline uint32_t deherm_script_static_push_url(void* frame, uint32_t socket_low, uint32_t socket_high, uint32_t reserved_low, uint32_t reserved_high, uint32_t path_low, uint32_t path_high, uint32_t fragment_low, uint32_t fragment_high) { return deherm_script_static_push_url(static_cast<DehermScriptUniversalStaticFrame*>(frame), socket_low, socket_high, reserved_low, reserved_high, path_low, path_high, fragment_low, fragment_high); }
static inline uint32_t deherm_script_static_result_count(void* frame) { return deherm_script_static_result_count(static_cast<const DehermScriptUniversalStaticFrame*>(frame)); }
static inline uint32_t deherm_script_static_result_root(void* frame, uint32_t slot) { return deherm_script_static_result_root(static_cast<const DehermScriptUniversalStaticFrame*>(frame), slot); }
static inline uint8_t deherm_script_static_set_argument(void* frame, uint32_t slot, uint32_t value_index) { return deherm_script_static_set_argument(static_cast<DehermScriptUniversalStaticFrame*>(frame), slot, value_index); }
static inline uint8_t deherm_script_static_set_entry(void* frame, uint32_t table_index, uint32_t entry, uint32_t key_index, uint32_t value_index) { return deherm_script_static_set_entry(static_cast<DehermScriptUniversalStaticFrame*>(frame), table_index, entry, key_index, value_index); }
static inline uint8_t deherm_script_static_value_auxiliary(void* frame, uint32_t value_index) { return deherm_script_static_value_auxiliary(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline uint8_t deherm_script_static_value_defold_kind(void* frame, uint32_t value_index) { return deherm_script_static_value_defold_kind(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline float deherm_script_static_value_element(void* frame, uint32_t value_index, uint32_t element) { return deherm_script_static_value_element(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index, element); }
static inline uint8_t deherm_script_static_value_handle_kind(void* frame, uint32_t value_index) { return deherm_script_static_value_handle_kind(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline float deherm_script_static_value_lane(void* frame, uint32_t value_index, uint32_t lane) { return deherm_script_static_value_lane(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index, lane); }
static inline uint32_t deherm_script_static_value_length(void* frame, uint32_t value_index) { return deherm_script_static_value_length(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline double deherm_script_static_value_number(void* frame, uint32_t value_index) { return deherm_script_static_value_number(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline uint32_t deherm_script_static_value_payload_high(void* frame, uint32_t value_index) { return deherm_script_static_value_payload_high(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline uint32_t deherm_script_static_value_payload_low(void* frame, uint32_t value_index) { return deherm_script_static_value_payload_low(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline uint32_t deherm_script_static_value_runtime(void* frame, uint32_t value_index) { return deherm_script_static_value_runtime(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline char* deherm_script_static_value_string(void* frame, uint32_t value_index) { return deherm_script_static_value_string(static_cast<DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline uint8_t deherm_script_static_value_tag(void* frame, uint32_t value_index) { return deherm_script_static_value_tag(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index); }
static inline uint32_t deherm_script_static_value_url_high(void* frame, uint32_t value_index, uint32_t lane) { return deherm_script_static_value_url_high(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index, lane); }
static inline uint32_t deherm_script_static_value_url_low(void* frame, uint32_t value_index, uint32_t lane) { return deherm_script_static_value_url_low(static_cast<const DehermScriptUniversalStaticFrame*>(frame), value_index, lane); }
static inline uint8_t deherm_script_static_write_string_byte(void* frame, uint32_t value_index, uint32_t byte_offset, uint8_t value) { return deherm_script_static_write_string_byte(static_cast<DehermScriptUniversalStaticFrame*>(frame), value_index, byte_offset, value); }
static inline SHLegacyValue _sh_asciiz_to_string(void* shr, void* str, ptrdiff_t len) { return _sh_asciiz_to_string(static_cast<SHRuntime *>(shr), static_cast<const char *>(str), len); }
