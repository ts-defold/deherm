// A `shermes -emit-c` unit is a transport of the 'hermes' runtime. The web
// targets run game code on the browser's own JavaScript engine and embed no
// Hermes, so this translation unit has nothing to call there. Saying so here
// turns a pile of undefined _sh_* symbols at link time into one named refusal
// at compile time. The build-time gate that normally prevents this is the
// .defignore entry maintained by packages/cli/src/typed-native.mjs.
#if defined(__EMSCRIPTEN__) || defined(DM_PLATFORM_HTML5)
#error "deherm typed-native-requires-hermes-runtime: this unit is a Hermes-runtime transport and cannot be compiled for a browser-runtime target"
#endif

// The packaged libhermes.a is an asserts-off build: its symbol table exports
// _sh_model..._rel. Hermes turns that into a link-time check that a client
// translation unit agrees, and `libhermesvm-config.h` picks the suffix from
// NDEBUG. Extender's debug variant defines no NDEBUG, so this one translation
// unit - not the engine, not the rest of the extension - declares the state of
// the archive it is being linked against.
#ifndef NDEBUG
#define NDEBUG 1
#endif

#include "hermes/VM/static_h.h"

#include <stdlib.h>

#include <deherm_typed_native_prelude.h>


static uint32_t unit_index;
static inline SHSymbolID* get_symbols(SHUnit *);
static inline SHWritePropertyCacheEntry* get_write_prop_cache(SHUnit *);
static inline SHReadPropertyCacheEntry* get_read_prop_cache(SHUnit *);
static inline SHPrivateNameCacheEntry* get_private_name_cache(SHUnit *);
static const SHSrcLoc s_source_locations[] = {
  { .filename_idx = 8, .line = 0, .column = 0 },
};
static SHNativeFuncInfo s_function_info_table[] = {
  { .name_index = 80, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 32, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 32, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 32, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 32, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 32, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 81, .arg_count = 2, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 82, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 83, .arg_count = 2, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 84, .arg_count = 2, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 85, .arg_count = 1, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 86, .arg_count = 2, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 87, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 1, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 2, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 3, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 88, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 89, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 90, .arg_count = 1, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 91, .arg_count = 1, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 92, .arg_count = 1, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 1, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 93, .arg_count = 5, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 3, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 4, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 94, .arg_count = 5, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 3, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 95, .arg_count = 1, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 2, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 3, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 96, .arg_count = 8, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 2, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 3, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 97, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 5, .arg_count = 5, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 6, .arg_count = 1, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 98, .arg_count = 1, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 2, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 99, .arg_count = 2, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 2, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 100, .arg_count = 2, .prohibit_invoke = 0, .kind = 0 },
  { .name_index = 0, .arg_count = 3, .prohibit_invoke = 2, .kind = 0 },
  { .name_index = 2, .arg_count = 0, .prohibit_invoke = 2, .kind = 0 },
};
static SHLegacyValue _0_global(SHRuntime *shr);
static SHLegacyValue _1_Array(SHRuntime *shr);
static SHLegacyValue _2_Array_1_(SHRuntime *shr);
static SHLegacyValue _3_Array_2_(SHRuntime *shr);
static SHLegacyValue _4_Array_3_(SHRuntime *shr);
static SHLegacyValue _5_Array_4_(SHRuntime *shr);
static SHLegacyValue _6___writeUtf8(SHRuntime *shr);
static SHLegacyValue _7___decode(SHRuntime *shr);
static SHLegacyValue _8_dispatchScriptUniversalValue(SHRuntime *shr);
static SHLegacyValue _9___dehermToStatic(SHRuntime *shr);
static SHLegacyValue _10___dehermFromStatic(SHRuntime *shr);
static SHLegacyValue _11___dehermTypedNativeCall(SHRuntime *shr);
static SHLegacyValue _12_DehermStaticValue(SHRuntime *shr);
static SHLegacyValue _13_encode(SHRuntime *shr);
static SHLegacyValue _14_asString(SHRuntime *shr);
static SHLegacyValue _15_probeSize(SHRuntime *shr);
static SHLegacyValue _16_probeChecksum(SHRuntime *shr);
static SHLegacyValue _17_DehermStaticUndefined(SHRuntime *shr);
static SHLegacyValue _18_encode_1_(SHRuntime *shr);
static SHLegacyValue _19_DehermStaticNull(SHRuntime *shr);
static SHLegacyValue _20_encode_2_(SHRuntime *shr);
static SHLegacyValue _21_DehermStaticBoolean(SHRuntime *shr);
static SHLegacyValue _22_encode_3_(SHRuntime *shr);
static SHLegacyValue _23_DehermStaticNumber(SHRuntime *shr);
static SHLegacyValue _24_encode_4_(SHRuntime *shr);
static SHLegacyValue _25_DehermStaticString(SHRuntime *shr);
static SHLegacyValue _26_encode_5_(SHRuntime *shr);
static SHLegacyValue _27_asString_1_(SHRuntime *shr);
static SHLegacyValue _28_DehermStaticHandle(SHRuntime *shr);
static SHLegacyValue _29_encode_6_(SHRuntime *shr);
static SHLegacyValue _30_probeChecksum_1_(SHRuntime *shr);
static SHLegacyValue _31_dispose(SHRuntime *shr);
static SHLegacyValue _32_DehermStaticDefoldValue(SHRuntime *shr);
static SHLegacyValue _33_encode_7_(SHRuntime *shr);
static SHLegacyValue _34_probeChecksum_2_(SHRuntime *shr);
static SHLegacyValue _35_DehermStaticMatrix4(SHRuntime *shr);
static SHLegacyValue _36_encode_8_(SHRuntime *shr);
static SHLegacyValue _37_probeSize_1_(SHRuntime *shr);
static SHLegacyValue _38_probeChecksum_3_(SHRuntime *shr);
static SHLegacyValue _39_DehermStaticUrl(SHRuntime *shr);
static SHLegacyValue _40_encode_9_(SHRuntime *shr);
static SHLegacyValue _41_probeSize_2_(SHRuntime *shr);
static SHLegacyValue _42_probeChecksum_4_(SHRuntime *shr);
static SHLegacyValue _43_DehermStaticContainer(SHRuntime *shr);
static SHLegacyValue _44_begin(SHRuntime *shr);
static SHLegacyValue _45_end(SHRuntime *shr);
static SHLegacyValue _46_DehermStaticArray(SHRuntime *shr);
static SHLegacyValue _47_encode_10_(SHRuntime *shr);
static SHLegacyValue _48_probeSize_3_(SHRuntime *shr);
static SHLegacyValue _49_DehermStaticRecord(SHRuntime *shr);
static SHLegacyValue _50_encode_11_(SHRuntime *shr);
static SHLegacyValue _51_probeSize_4_(SHRuntime *shr);
static SHLegacyValue _52_DehermStaticMap(SHRuntime *shr);
static SHLegacyValue _53_encode_12_(SHRuntime *shr);
static SHLegacyValue _54_probeSize_5_(SHRuntime *shr);
// .deherm/build/generated/typed-native/deherm_typed_native.ts:3:1
static SHLegacyValue _0_global(SHRuntime *shr) {
  _SH_MODEL();
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
    SHLegacyValue t4;
    SHLegacyValue t5;
    SHLegacyValue t6;
    SHLegacyValue t7;
    SHLegacyValue t8;
    SHLegacyValue t9;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 10);
  locals.head.count =10;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_undefined();
  locals.t5 = _sh_ljs_undefined();
  locals.t6 = _sh_ljs_undefined();
  locals.t7 = _sh_ljs_undefined();
  locals.t8 = _sh_ljs_undefined();
  locals.t9 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = _sh_ljs_create_environment(shr, NULL, 5);
  np1 = _sh_ljs_null();
  locals.t2 = _sh_ljs_new_object_with_parent(shr, &np1);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 0);
  locals.t1 = _sh_ljs_create_closure(shr, NULL, _1_Array, &s_function_info_table[1], shUnit);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[30] /*prototype*/, &locals.t2, get_write_prop_cache(shUnit) + 0);
  locals.t1 = _sh_ljs_new_object_with_parent(shr, &np1);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t1, 1);
  locals.t2 = _sh_ljs_create_closure(shr, NULL, _2_Array_1_, &s_function_info_table[2], shUnit);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[30] /*prototype*/, &locals.t1, get_write_prop_cache(shUnit) + 1);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &np1);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 2);
  locals.t2 = _sh_ljs_create_closure(shr, NULL, _3_Array_2_, &s_function_info_table[3], shUnit);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 2);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &np1);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 3);
  locals.t2 = _sh_ljs_create_closure(shr, NULL, _4_Array_3_, &s_function_info_table[4], shUnit);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 3);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &np1);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 4);
  locals.t2 = _sh_ljs_create_closure(shr, NULL, _5_Array_4_, &s_function_info_table[5], shUnit);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 4);
  locals.t0 = _sh_ljs_create_environment(shr, &locals.t0, 42);
  np0 = _sh_ljs_undefined();
  _sh_ljs_store_to_env(shr, locals.t0,np0, 0);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 1);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 2);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 3);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 4);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 5);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 6);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 7);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 8);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 9);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 10);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 11);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 12);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 16);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 17);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 18);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 19);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 20);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 21);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 22);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 23);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 24);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 25);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 26);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 29);
  locals.t2 = _sh_ljs_create_closure(shr, NULL, _6___writeUtf8, &s_function_info_table[6], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 13);
  locals.t2 = _sh_ljs_create_closure(shr, &locals.t0, _7___decode, &s_function_info_table[7], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 14);
  locals.t2 = _sh_ljs_create_closure(shr, &locals.t0, _8_dispatchScriptUniversalValue, &s_function_info_table[8], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 15);
  locals.t2 = _sh_ljs_create_closure(shr, &locals.t0, _9___dehermToStatic, &s_function_info_table[9], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 27);
  locals.t2 = _sh_ljs_create_closure(shr, &locals.t0, _10___dehermFromStatic, &s_function_info_table[10], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 28);
  locals.t2 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &np1, 0, 0);
  locals.t3 = _sh_ljs_create_closure(shr, NULL, _13_encode, &s_function_info_table[13], shUnit);
  _sh_prstore_object(shr, &locals.t2, 0, &locals.t3);
  locals.t3 = _sh_ljs_create_closure(shr, NULL, _14_asString, &s_function_info_table[14], shUnit);
  _sh_prstore_object(shr, &locals.t2, 1, &locals.t3);
  locals.t3 = _sh_ljs_create_closure(shr, NULL, _15_probeSize, &s_function_info_table[15], shUnit);
  _sh_prstore_object(shr, &locals.t2, 2, &locals.t3);
  locals.t3 = _sh_ljs_create_closure(shr, NULL, _16_probeChecksum, &s_function_info_table[16], shUnit);
  _sh_prstore_object(shr, &locals.t2, 3, &locals.t3);
  locals.t3 = _sh_ljs_create_closure(shr, NULL, _12_DehermStaticValue, &s_function_info_table[12], shUnit);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t3, get_symbols(shUnit)[30] /*prototype*/, &locals.t2, get_write_prop_cache(shUnit) + 5);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _17_DehermStaticUndefined, &s_function_info_table[17], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 0);
  locals.t7 = _sh_prload(shr, locals.t2, 1);
  locals.t6 = _sh_prload(shr, locals.t2, 2);
  locals.t5 = _sh_prload(shr, locals.t2, 3);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t8 = _sh_ljs_create_closure(shr, NULL, _18_encode_1_, &s_function_info_table[18], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t8);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 30);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 6);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _19_DehermStaticNull, &s_function_info_table[19], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 1);
  locals.t7 = _sh_prload(shr, locals.t2, 1);
  locals.t6 = _sh_prload(shr, locals.t2, 2);
  locals.t5 = _sh_prload(shr, locals.t2, 3);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t8 = _sh_ljs_create_closure(shr, NULL, _20_encode_2_, &s_function_info_table[20], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t8);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 31);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 7);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _21_DehermStaticBoolean, &s_function_info_table[21], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 2);
  locals.t7 = _sh_prload(shr, locals.t2, 1);
  locals.t6 = _sh_prload(shr, locals.t2, 2);
  locals.t5 = _sh_prload(shr, locals.t2, 3);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t8 = _sh_ljs_create_closure(shr, NULL, _22_encode_3_, &s_function_info_table[22], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t8);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 32);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 8);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _23_DehermStaticNumber, &s_function_info_table[23], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 3);
  locals.t7 = _sh_prload(shr, locals.t2, 1);
  locals.t6 = _sh_prload(shr, locals.t2, 2);
  locals.t5 = _sh_prload(shr, locals.t2, 3);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t8 = _sh_ljs_create_closure(shr, NULL, _24_encode_4_, &s_function_info_table[24], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t8);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 33);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 9);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _25_DehermStaticString, &s_function_info_table[25], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 4);
  locals.t6 = _sh_prload(shr, locals.t2, 2);
  locals.t5 = _sh_prload(shr, locals.t2, 3);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t7 = _sh_ljs_create_closure(shr, &locals.t0, _26_encode_5_, &s_function_info_table[26], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t7);
  locals.t7 = _sh_ljs_create_closure(shr, NULL, _27_asString_1_, &s_function_info_table[27], shUnit);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 34);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 10);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _28_DehermStaticHandle, &s_function_info_table[28], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 5);
  locals.t6 = _sh_prload(shr, locals.t2, 1);
  locals.t5 = _sh_prload(shr, locals.t2, 2);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 1, 1);
  locals.t7 = _sh_ljs_create_closure(shr, NULL, _29_encode_6_, &s_function_info_table[29], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t5);
  locals.t5 = _sh_ljs_create_closure(shr, NULL, _30_probeChecksum_1_, &s_function_info_table[30], shUnit);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  locals.t5 = _sh_ljs_create_closure(shr, NULL, _31_dispose, &s_function_info_table[31], shUnit);
  _sh_prstore_object(shr, &locals.t3, 4, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 35);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 11);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _32_DehermStaticDefoldValue, &s_function_info_table[32], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 6);
  locals.t6 = _sh_prload(shr, locals.t2, 1);
  locals.t5 = _sh_prload(shr, locals.t2, 2);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t7 = _sh_ljs_create_closure(shr, NULL, _33_encode_7_, &s_function_info_table[33], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t5);
  locals.t5 = _sh_ljs_create_closure(shr, NULL, _34_probeChecksum_2_, &s_function_info_table[34], shUnit);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 36);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 12);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _35_DehermStaticMatrix4, &s_function_info_table[35], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 7);
  locals.t5 = _sh_prload(shr, locals.t2, 1);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t6 = _sh_ljs_create_closure(shr, NULL, _36_encode_8_, &s_function_info_table[36], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t5);
  locals.t5 = _sh_ljs_create_closure(shr, NULL, _37_probeSize_1_, &s_function_info_table[37], shUnit);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t5);
  locals.t5 = _sh_ljs_create_closure(shr, NULL, _38_probeChecksum_3_, &s_function_info_table[38], shUnit);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 37);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 13);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _39_DehermStaticUrl, &s_function_info_table[39], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 8);
  locals.t5 = _sh_prload(shr, locals.t2, 1);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 0, 0);
  locals.t6 = _sh_ljs_create_closure(shr, NULL, _40_encode_9_, &s_function_info_table[40], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t5);
  locals.t5 = _sh_ljs_create_closure(shr, NULL, _41_probeSize_2_, &s_function_info_table[41], shUnit);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t5);
  locals.t5 = _sh_ljs_create_closure(shr, NULL, _42_probeChecksum_4_, &s_function_info_table[42], shUnit);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 38);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 14);
  locals.t3 = _sh_ljs_create_closure(shr, NULL, _43_DehermStaticContainer, &s_function_info_table[43], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 9);
  locals.t7 = _sh_prload(shr, locals.t2, 0);
  locals.t6 = _sh_prload(shr, locals.t2, 1);
  locals.t5 = _sh_prload(shr, locals.t2, 2);
  locals.t4 = _sh_prload(shr, locals.t2, 3);
  locals.t2 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 2, 2);
  _sh_prstore_object(shr, &locals.t2, 0, &locals.t7);
  _sh_prstore_object(shr, &locals.t2, 1, &locals.t6);
  _sh_prstore_object(shr, &locals.t2, 2, &locals.t5);
  _sh_prstore_object(shr, &locals.t2, 3, &locals.t4);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _44_begin, &s_function_info_table[44], shUnit);
  _sh_prstore_object(shr, &locals.t2, 4, &locals.t4);
  locals.t4 = _sh_ljs_create_closure(shr, NULL, _45_end, &s_function_info_table[45], shUnit);
  _sh_prstore_object(shr, &locals.t2, 5, &locals.t4);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t3, get_symbols(shUnit)[30] /*prototype*/, &locals.t2, get_write_prop_cache(shUnit) + 15);
  locals.t4 = _sh_ljs_create_closure(shr, &locals.t0, _46_DehermStaticArray, &s_function_info_table[46], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 10);
  locals.t8 = _sh_prload(shr, locals.t2, 1);
  locals.t7 = _sh_prload(shr, locals.t2, 3);
  locals.t6 = _sh_prload(shr, locals.t2, 4);
  locals.t5 = _sh_prload(shr, locals.t2, 5);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 2, 2);
  locals.t9 = _sh_ljs_create_closure(shr, NULL, _47_encode_10_, &s_function_info_table[47], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t9);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t8);
  locals.t8 = _sh_ljs_create_closure(shr, NULL, _48_probeSize_3_, &s_function_info_table[48], shUnit);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t8);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 4, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 5, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 39);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 16);
  locals.t4 = _sh_ljs_create_closure(shr, &locals.t0, _49_DehermStaticRecord, &s_function_info_table[49], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 11);
  locals.t8 = _sh_prload(shr, locals.t2, 1);
  locals.t7 = _sh_prload(shr, locals.t2, 3);
  locals.t6 = _sh_prload(shr, locals.t2, 4);
  locals.t5 = _sh_prload(shr, locals.t2, 5);
  locals.t3 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 2, 2);
  locals.t9 = _sh_ljs_create_closure(shr, &locals.t0, _50_encode_11_, &s_function_info_table[50], shUnit);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t9);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t8);
  locals.t8 = _sh_ljs_create_closure(shr, NULL, _51_probeSize_4_, &s_function_info_table[51], shUnit);
  _sh_prstore_object(shr, &locals.t3, 2, &locals.t8);
  _sh_prstore_object(shr, &locals.t3, 3, &locals.t7);
  _sh_prstore_object(shr, &locals.t3, 4, &locals.t6);
  _sh_prstore_object(shr, &locals.t3, 5, &locals.t5);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 40);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t4, get_symbols(shUnit)[30] /*prototype*/, &locals.t3, get_write_prop_cache(shUnit) + 17);
  locals.t3 = _sh_ljs_create_closure(shr, &locals.t0, _52_DehermStaticMap, &s_function_info_table[52], shUnit);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 12);
  locals.t7 = _sh_prload(shr, locals.t2, 1);
  locals.t6 = _sh_prload(shr, locals.t2, 3);
  locals.t5 = _sh_prload(shr, locals.t2, 4);
  locals.t4 = _sh_prload(shr, locals.t2, 5);
  locals.t2 = _sh_new_typed_non_enum_object_with_buffer(shr, shUnit, &locals.t2, 2, 2);
  locals.t8 = _sh_ljs_create_closure(shr, NULL, _53_encode_12_, &s_function_info_table[53], shUnit);
  _sh_prstore_object(shr, &locals.t2, 0, &locals.t8);
  _sh_prstore_object(shr, &locals.t2, 1, &locals.t7);
  locals.t7 = _sh_ljs_create_closure(shr, NULL, _54_probeSize_5_, &s_function_info_table[54], shUnit);
  _sh_prstore_object(shr, &locals.t2, 2, &locals.t7);
  _sh_prstore_object(shr, &locals.t2, 3, &locals.t6);
  _sh_prstore_object(shr, &locals.t2, 4, &locals.t5);
  _sh_prstore_object(shr, &locals.t2, 5, &locals.t4);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 41);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t3, get_symbols(shUnit)[30] /*prototype*/, &locals.t2, get_write_prop_cache(shUnit) + 18);
  locals.t2 = _sh_new_fastarray_with_proto(shr, &locals.t1, 325);
  np1 = _sh_ljs_double(350770);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2636616);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(10300768);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(12859057);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(16978861);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(94225445);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(96184340);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(109392419);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(143800718);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(161653622);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(172398549);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(182835960);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(206098425);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(236701305);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(250460089);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(286597108);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(294035082);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(309934808);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(314843756);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(333496520);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(366027815);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(384109339);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(389692837);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(457161058);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(466939425);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(475687915);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(497116905);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(507784421);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(530608877);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(543852986);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(553650099);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(578552117);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(583164307);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(593473189);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(603084884);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(606958618);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(608141138);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(610646079);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(619862503);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(621943862);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(638454056);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(653417741);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(665323993);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(684194101);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(721632055);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(754452606);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(780726310);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(798578280);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(803274747);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(806414134);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(815384074);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(821977639);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(826508291);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(844414261);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(851073219);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(851439019);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(889923285);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(902564824);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(984377853);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(986113063);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1001666066);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1027591192);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1039973353);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1050223476);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1053915798);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1055817377);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1058276904);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1066639565);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1070053126);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1089182856);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1111726479);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1120188142);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1130709659);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1151793552);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1174885233);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1183026732);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1193509462);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1220373797);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1238853489);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1242286766);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1244117951);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1244796042);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1244951420);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1260100361);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1269208753);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1277170138);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1282948964);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1292408212);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1294659359);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1298827590);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1311027776);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1329930197);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1345946881);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1367399751);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1380158343);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1389820634);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1421868765);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1431636929);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1439789256);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1450101103);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1458980654);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1477563324);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1483760217);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1486569517);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1495634860);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1502096075);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1514123934);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1547570734);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1547809370);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1577053319);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1601401386);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1613326455);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1655100321);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1699887816);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1703142815);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1715761682);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1732915491);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1794446851);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1831038998);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1832879575);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1848085754);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1863401472);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1870095059);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1882390770);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1888249062);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1893279761);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1932609869);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1938117379);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1985681678);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1986171713);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1992852954);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(1995008024);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2020799616);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2034901354);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2048321486);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2064699563);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2081791798);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2093413559);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2094481018);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2107179008);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2116175008);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2128448069);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(2139022713);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746798301928488960u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746801286316294144u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746814502664667136u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746817534492147712u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746844386722054144u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746846300507471872u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746857142187720704u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746874418666405888u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4746942805971042304u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747018306381152256u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747042087686373376u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747079995843674112u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747130949064458240u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747148744277884928u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747156902582943744u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747164953708855296u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747169995268554752u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747199274553442304u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747212718751088640u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747259877391335424u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747261728864075776u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747303180184846336u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747338130644795392u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747343571514818560u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747344495400452096u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747388893131702272u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747414501159075840u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747480340166082560u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747514377314238464u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747515127733944320u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747516596092665856u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747517391703900160u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747518574979973120u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747535885040353280u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747553522730401792u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747575291614855168u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747588707947642880u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747601633068711936u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747603286400434176u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747630305486045184u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747659078382125056u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747737010949586944u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747745811297730560u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747762286431567872u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747779060069826560u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747786832528277504u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747816583194214400u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747829608255062016u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747855316146716672u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747904805983223808u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747925397975334912u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747926154470490112u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747969673463595008u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747982558944296960u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747988924591243264u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4747999305038561280u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748025178592641024u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748047730109054976u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748071685362548736u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748101697310556160u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748124224541949952u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748156917140946944u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748184053367177216u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748211809721253888u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748229648375087104u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748257013098610688u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748261365869707264u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748316452447059968u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748329502162026496u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748414494707810304u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748456261264080896u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748457518382972928u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748502672577921024u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748521954951036928u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748534133731360768u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748543798657679360u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748546341301387264u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748622698620387328u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748628567263281152u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748629846966403072u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748639066503774208u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748641602654699520u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748652979911917568u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748670285979320320u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748674733174685696u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748681182120509440u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748704749447020544u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748715773606756352u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748756084198473728u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748821596559376384u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748821798924058624u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748873085642342400u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748915414375858176u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748919473499537408u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748980619237654528u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748991453120692224u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4748992825312411648u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749013044674166784u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749015087944040448u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749171084994019328u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749210566044680192u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749237491672809472u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749291152348282880u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749304463116730368u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749321354195501056u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749323204995055616u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749337373460922368u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749374032179101696u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749602646923411456u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749612894608424960u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749615507875823616u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749628774820085760u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749630931814318080u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749631333062410240u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749632657994809344u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749644404575174656u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749660095682445312u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749661437490626560u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749718450260148224u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749754670149271552u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749770090841374720u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749775793683431424u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749803123262881792u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749811071110348800u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749826265754632192u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749845699544219648u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749879990531653632u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749913916472033280u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749946016927580160u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4749954279565950976u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750014174822662144u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750031019948638208u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750044885629796352u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750065254398951424u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750100901054644224u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750119500150472704u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750162923282759680u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750184950179823616u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750201643545395200u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750223017947168768u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750268634176159744u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750286031478063104u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750309666674704384u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750382426776141824u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750386623567364096u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750508670201102336u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750523406198243328u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750543877669126144u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750549799191707648u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750562953630056448u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750575661456818176u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750601507057958912u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750619382724427776u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750672023506649088u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750692110204665856u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750715742844878848u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750734019470032896u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750754595905470464u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750768756322467840u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750778549827272704u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750788440079990784u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750789538454962176u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750795790165737472u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750797016223711232u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750908712445542400u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750933439625035776u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750939342870937600u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750972812712214528u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750981947587559424u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750991742317101056u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4750995186429984768u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751007127728816128u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751017330266341376u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751072253263740928u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751120021535588352u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751123850010296320u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751141909741699072u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751167894090416128u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751172464061448192u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751178642386583552u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751193289753886720u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751256412728852480u}).f64);
  _sh_fastarray_push(shr, &np1, &locals.t2);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t2, 16);
  np1 = _sh_ljs_double(32);
  _sh_ljs_store_to_env(shr, locals.t0,np1, 17);
  np2 = _sh_ljs_double(8);
  _sh_ljs_store_to_env(shr, locals.t0,np2, 18);
  locals.t3 = _sh_ljs_get_global_object(shr);
  locals.t1 = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[31] /*globalThis*/, get_read_prop_cache(shUnit) + 0);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[32] /*Array*/, get_read_prop_cache(shUnit) + 1);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t4,get_symbols(shUnit)[33] /*isArray*/, get_read_prop_cache(shUnit) + 2);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 19);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[34] /*Object*/, get_read_prop_cache(shUnit) + 3);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t4,get_symbols(shUnit)[35] /*getPrototypeOf*/, get_read_prop_cache(shUnit) + 4);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 20);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[34] /*Object*/, get_read_prop_cache(shUnit) + 5);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t4,get_symbols(shUnit)[30] /*prototype*/, get_read_prop_cache(shUnit) + 6);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 21);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[36] /*Map*/, get_read_prop_cache(shUnit) + 7);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 22);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t4,get_symbols(shUnit)[30] /*prototype*/, get_read_prop_cache(shUnit) + 8);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 23);
  frame[3] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 9);
  frame[1] = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  frame[4] = _sh_ljs_undefined();
  frame[2] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 24);
  frame[3] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 10);
  frame[4] = _sh_ljs_undefined();
  frame[2] = _sh_ljs_undefined();
  frame[1] = _sh_ljs_double(32);
  locals.t3 = _sh_ljs_call(shr, frame, 1);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t3, 25);
  np1 = _sh_ljs_bool(false);
  _sh_ljs_store_to_env(shr, locals.t0,np1, 26);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[38] /*__defoldScriptBridge...*/, get_read_prop_cache(shUnit) + 11);
  _sh_ljs_store_to_env(shr, locals.t0,locals.t4, 29);
  if(_sh_ljs_to_boolean(locals.t4)) goto L1;
  goto L2;

L1:
  ;
  locals.t3 = _sh_ljs_create_closure(shr, &locals.t0, _11___dehermTypedNativeCall, &s_function_info_table[11], shUnit);
  locals.t0 = _sh_ljs_new_object(shr);
  locals.t5 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t4,get_symbols(shUnit)[39] /*target*/, get_read_prop_cache(shUnit) + 12);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t0, get_symbols(shUnit)[39] /*target*/, &locals.t5, get_write_prop_cache(shUnit) + 19);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t4,get_symbols(shUnit)[40] /*get*/, get_read_prop_cache(shUnit) + 13);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t0, get_symbols(shUnit)[40] /*get*/, &locals.t4, get_write_prop_cache(shUnit) + 20);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t0, get_symbols(shUnit)[41] /*call*/, &locals.t3, get_write_prop_cache(shUnit) + 21);
  np1 = _sh_fastarray_length(shr, &locals.t2);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t0, get_symbols(shUnit)[42] /*__dehermTypedNativeR...*/, &np1, get_write_prop_cache(shUnit) + 22);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[38] /*__defoldScriptBridge...*/, &locals.t0, get_write_prop_cache(shUnit) + 23);
  goto L2;
L2:
  ;
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _1_Array(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _2_Array_1_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _3_Array_2_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _4_Array_3_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _5_Array_4_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:58:1
static SHLegacyValue _6___writeUtf8(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 10);
  locals.head.count =3;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();
  SHLegacyValue np9 = _sh_ljs_undefined();
  SHLegacyValue np10 = _sh_ljs_undefined();
  SHLegacyValue np11 = _sh_ljs_undefined();
  SHLegacyValue np12 = _sh_ljs_undefined();
  SHLegacyValue np13 = _sh_ljs_undefined();
  SHLegacyValue np14 = _sh_ljs_undefined();
  SHLegacyValue np15 = _sh_ljs_undefined();
  SHLegacyValue np16 = _sh_ljs_undefined();
  SHLegacyValue np17 = _sh_ljs_undefined();
  SHLegacyValue np18 = _sh_ljs_undefined();
  SHLegacyValue np19 = _sh_ljs_undefined();
  SHLegacyValue np20 = _sh_ljs_undefined();
  SHLegacyValue np21 = _sh_ljs_undefined();
  SHLegacyValue np22 = _sh_ljs_undefined();
  SHLegacyValue np23 = _sh_ljs_undefined();
  SHLegacyValue np24 = _sh_ljs_undefined();
  SHLegacyValue np25 = _sh_ljs_undefined();
  SHLegacyValue np26 = _sh_ljs_undefined();
  SHLegacyValue np27 = _sh_ljs_undefined();
  SHLegacyValue np28 = _sh_ljs_undefined();

L0:
  ;
  locals.t1 = _sh_ljs_param(frame, 2);
  np0 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 14);
  np2 = _sh_ljs_double(0);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np2) < _sh_ljs_get_double(np0));
  np22 = _sh_ljs_double(1);
  np21 = _sh_ljs_double(65536);
  np20 = _sh_ljs_double(2048);
  np19 = _sh_ljs_double(128);
  np18 = _sh_ljs_double(56320);
  np17 = _sh_ljs_double(10);
  np16 = _sh_ljs_double(55296);
  np14 = _sh_ljs_double(57343);
  locals.t0 = _sh_ljs_get_global_object(shr);
  np13 = _sh_ljs_undefined();
  np12 = _sh_ljs_double(56319);
  np4 = _sh_ljs_double(0);
  np3 = _sh_ljs_double(0);
  np0 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np1)) goto L1;
  goto L17;

L1:
  ;
  // PhiInst
  // PhiInst
  locals.t2 = _sh_ljs_try_get_by_id_rjs(shr,&locals.t0, get_symbols(shUnit)[31] /*globalThis*/, get_read_prop_cache(shUnit) + 15);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[44] /*String*/, get_read_prop_cache(shUnit) + 16);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[30] /*prototype*/, get_read_prop_cache(shUnit) + 17);
  frame[3] = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[45] /*charCodeAt*/, get_read_prop_cache(shUnit) + 18);
  frame[4] = _sh_ljs_undefined();
  frame[2] = locals.t1;
  frame[1] = np4;
  locals.t2 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np9 = locals.t2;
  np11 = _sh_ljs_bool(_sh_ljs_get_double(np9) >= _sh_ljs_get_double(np16));
  np24 = np4;
  if(_sh_ljs_get_bool(np11)) goto L2;
  goto L4;

L2:
  ;
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np9) <= _sh_ljs_get_double(np12));
  if(_sh_ljs_get_bool(np1)) goto L3;
  goto L4;

L3:
  ;
  np8 = _sh_ljs_double(_sh_ljs_get_double(np24) + _sh_ljs_get_double(np22));
  np1 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 19);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np8) < _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L7;
  goto L4;

L4:
  ;
  np10 = np9;
  np1 = np24;
  if(_sh_ljs_get_bool(np11)) goto L5;
  goto L10;

L5:
  ;
  np11 = _sh_ljs_bool(_sh_ljs_get_double(np9) <= _sh_ljs_get_double(np14));
  np10 = np9;
  np1 = np24;
  if(_sh_ljs_get_bool(np11)) goto L6;
  goto L10;

L6:
  ;
  np10 = _sh_ljs_double(65533);
  np1 = np24;
  goto L10;
L7:
  ;
  locals.t2 = _sh_ljs_try_get_by_id_rjs(shr,&locals.t0, get_symbols(shUnit)[31] /*globalThis*/, get_read_prop_cache(shUnit) + 20);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[44] /*String*/, get_read_prop_cache(shUnit) + 21);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[30] /*prototype*/, get_read_prop_cache(shUnit) + 22);
  frame[3] = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[45] /*charCodeAt*/, get_read_prop_cache(shUnit) + 23);
  frame[4] = _sh_ljs_undefined();
  frame[2] = locals.t1;
  frame[1] = np8;
  locals.t2 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np11 = locals.t2;
  np23 = _sh_ljs_bool(_sh_ljs_get_double(np11) >= _sh_ljs_get_double(np18));
  np10 = _sh_ljs_double(65533);
  np1 = np24;
  if(_sh_ljs_get_bool(np23)) goto L8;
  goto L10;

L8:
  ;
  np23 = _sh_ljs_bool(_sh_ljs_get_double(np11) <= _sh_ljs_get_double(np14));
  np10 = _sh_ljs_double(65533);
  np1 = np24;
  if(_sh_ljs_get_bool(np23)) goto L9;
  goto L10;

L9:
  ;
  np11 = _sh_ljs_double(_sh_ljs_get_double(np11) - _sh_ljs_get_double(np18));
  np9 = _sh_ljs_double(_sh_ljs_get_double(np9) - _sh_ljs_get_double(np16));
  np9 = _sh_ljs_left_shift_rjs_inline(shr, &np9, &np17);
  np9 = _sh_ljs_double(_sh_ljs_get_double(np21) + _sh_ljs_get_double(np9));
  np10 = _sh_ljs_double(_sh_ljs_get_double(np9) + _sh_ljs_get_double(np11));
  np1 = np8;
  goto L10;
L10:
  ;
  // PhiInst
  // PhiInst
  np9 = _sh_ljs_bool(_sh_ljs_get_double(np10) < _sh_ljs_get_double(np19));
  np8 = _sh_ljs_double(1);
  if(_sh_ljs_get_bool(np9)) goto L16;
  goto L11;

L11:
  ;
  np11 = _sh_ljs_bool(_sh_ljs_get_double(np10) < _sh_ljs_get_double(np20));
  np9 = _sh_ljs_double(2);
  if(_sh_ljs_get_bool(np11)) goto L15;
  goto L12;

L12:
  ;
  np11 = _sh_ljs_bool(_sh_ljs_get_double(np10) < _sh_ljs_get_double(np21));
  np10 = _sh_ljs_double(4);
  if(_sh_ljs_get_bool(np11)) goto L13;
  goto L14;

L13:
  ;
  np10 = _sh_ljs_double(3);
  goto L14;
L14:
  ;
  // PhiInst
  np9 = np10;
  goto L15;
L15:
  ;
  // PhiInst
  np8 = np9;
  goto L16;
L16:
  ;
  // PhiInst
  np3 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np8));
  np4 = _sh_ljs_double(_sh_ljs_get_double(np1) + _sh_ljs_get_double(np22));
  np1 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 24);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np1));
  np0 = np3;
  if(_sh_ljs_get_bool(np1)) goto L1;
  goto L17;

L17:
  ;
  // PhiInst
  np11 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_string(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np0) == _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L37;
  goto L18;

L18:
  ;
  np1 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 25);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np2) < _sh_ljs_get_double(np1));
  np10 = _sh_ljs_double(192);
  np9 = _sh_ljs_double(6);
  np8 = _sh_ljs_double(63);
  np7 = _sh_ljs_double(224);
  np6 = _sh_ljs_double(12);
  np5 = _sh_ljs_double(240);
  np4 = _sh_ljs_double(18);
  np3 = _sh_ljs_double(0);
  np2 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np1)) goto L19;
  goto L36;

L19:
  ;
  // PhiInst
  // PhiInst
  locals.t2 = _sh_ljs_try_get_by_id_rjs(shr,&locals.t0, get_symbols(shUnit)[31] /*globalThis*/, get_read_prop_cache(shUnit) + 26);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[44] /*String*/, get_read_prop_cache(shUnit) + 27);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[30] /*prototype*/, get_read_prop_cache(shUnit) + 28);
  frame[3] = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[45] /*charCodeAt*/, get_read_prop_cache(shUnit) + 29);
  frame[4] = _sh_ljs_undefined();
  frame[2] = locals.t1;
  frame[1] = np3;
  locals.t2 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np24 = locals.t2;
  np26 = _sh_ljs_bool(_sh_ljs_get_double(np24) >= _sh_ljs_get_double(np16));
  np28 = np3;
  if(_sh_ljs_get_bool(np26)) goto L20;
  goto L22;

L20:
  ;
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np24) <= _sh_ljs_get_double(np12));
  if(_sh_ljs_get_bool(np1)) goto L21;
  goto L22;

L21:
  ;
  np23 = _sh_ljs_double(_sh_ljs_get_double(np28) + _sh_ljs_get_double(np22));
  np1 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 30);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np23) < _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L25;
  goto L22;

L22:
  ;
  np25 = np24;
  np1 = np28;
  if(_sh_ljs_get_bool(np26)) goto L23;
  goto L28;

L23:
  ;
  np26 = _sh_ljs_bool(_sh_ljs_get_double(np24) <= _sh_ljs_get_double(np14));
  np25 = np24;
  np1 = np28;
  if(_sh_ljs_get_bool(np26)) goto L24;
  goto L28;

L24:
  ;
  np25 = _sh_ljs_double(65533);
  np1 = np28;
  goto L28;
L25:
  ;
  locals.t2 = _sh_ljs_try_get_by_id_rjs(shr,&locals.t0, get_symbols(shUnit)[31] /*globalThis*/, get_read_prop_cache(shUnit) + 31);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[44] /*String*/, get_read_prop_cache(shUnit) + 32);
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[30] /*prototype*/, get_read_prop_cache(shUnit) + 33);
  frame[3] = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[45] /*charCodeAt*/, get_read_prop_cache(shUnit) + 34);
  frame[4] = _sh_ljs_undefined();
  frame[2] = locals.t1;
  frame[1] = np23;
  locals.t2 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np26 = locals.t2;
  np27 = _sh_ljs_bool(_sh_ljs_get_double(np26) >= _sh_ljs_get_double(np18));
  np25 = _sh_ljs_double(65533);
  np1 = np28;
  if(_sh_ljs_get_bool(np27)) goto L26;
  goto L28;

L26:
  ;
  np27 = _sh_ljs_bool(_sh_ljs_get_double(np26) <= _sh_ljs_get_double(np14));
  np25 = _sh_ljs_double(65533);
  np1 = np28;
  if(_sh_ljs_get_bool(np27)) goto L27;
  goto L28;

L27:
  ;
  np26 = _sh_ljs_double(_sh_ljs_get_double(np26) - _sh_ljs_get_double(np18));
  np24 = _sh_ljs_double(_sh_ljs_get_double(np24) - _sh_ljs_get_double(np16));
  np24 = _sh_ljs_left_shift_rjs_inline(shr, &np24, &np17);
  np24 = _sh_ljs_double(_sh_ljs_get_double(np21) + _sh_ljs_get_double(np24));
  np25 = _sh_ljs_double(_sh_ljs_get_double(np24) + _sh_ljs_get_double(np26));
  np1 = np23;
  goto L28;
L28:
  ;
  // PhiInst
  // PhiInst
  np24 = _sh_ljs_double(_sh_ljs_get_double(np2) + _sh_ljs_get_double(np22));
  np23 = _sh_ljs_bool(_sh_ljs_get_double(np25) < _sh_ljs_get_double(np19));
  if(_sh_ljs_get_bool(np23)) goto L34;
  goto L29;

L29:
  ;
  np23 = _sh_ljs_bool(_sh_ljs_get_double(np25) < _sh_ljs_get_double(np20));
  if(_sh_ljs_get_bool(np23)) goto L33;
  goto L30;

L30:
  ;
  np23 = _sh_ljs_bool(_sh_ljs_get_double(np25) < _sh_ljs_get_double(np21));
  if(_sh_ljs_get_bool(np23)) goto L32;
  goto L31;

L31:
  ;
  np23 = _sh_ljs_right_shift_rjs_inline(shr, &np25, &np4);
  np23 = _sh_ljs_bit_or_rjs_inline(shr, &np5, &np23);
  np23 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np23))));
  np26 = _sh_ljs_double(_sh_ljs_get_double(np24) + _sh_ljs_get_double(np22));
  np23 = _sh_ljs_right_shift_rjs_inline(shr, &np25, &np6);
  np23 = _sh_ljs_bit_and_rjs_inline(shr, &np23, &np8);
  np23 = _sh_ljs_bit_or_rjs_inline(shr, &np19, &np23);
  np23 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np24)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np23))));
  np27 = _sh_ljs_double(_sh_ljs_get_double(np26) + _sh_ljs_get_double(np22));
  np23 = _sh_ljs_right_shift_rjs_inline(shr, &np25, &np9);
  np23 = _sh_ljs_bit_and_rjs_inline(shr, &np23, &np8);
  np23 = _sh_ljs_bit_or_rjs_inline(shr, &np19, &np23);
  np23 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np26)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np23))));
  np23 = _sh_ljs_double(_sh_ljs_get_double(np27) + _sh_ljs_get_double(np22));
  np26 = _sh_ljs_bit_and_rjs_inline(shr, &np25, &np8);
  np26 = _sh_ljs_bit_or_rjs_inline(shr, &np19, &np26);
  np26 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np27)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np26))));
  goto L35;
L32:
  ;
  np26 = _sh_ljs_right_shift_rjs_inline(shr, &np25, &np6);
  np26 = _sh_ljs_bit_or_rjs_inline(shr, &np7, &np26);
  np26 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np26))));
  np28 = _sh_ljs_double(_sh_ljs_get_double(np24) + _sh_ljs_get_double(np22));
  np26 = _sh_ljs_right_shift_rjs_inline(shr, &np25, &np9);
  np26 = _sh_ljs_bit_and_rjs_inline(shr, &np26, &np8);
  np26 = _sh_ljs_bit_or_rjs_inline(shr, &np19, &np26);
  np26 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np24)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np26))));
  np23 = _sh_ljs_double(_sh_ljs_get_double(np28) + _sh_ljs_get_double(np22));
  np27 = _sh_ljs_bit_and_rjs_inline(shr, &np25, &np8);
  np27 = _sh_ljs_bit_or_rjs_inline(shr, &np19, &np27);
  np27 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np28)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np27))));
  goto L35;
L33:
  ;
  np26 = _sh_ljs_right_shift_rjs_inline(shr, &np25, &np9);
  np26 = _sh_ljs_bit_or_rjs_inline(shr, &np10, &np26);
  np26 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np26))));
  np23 = _sh_ljs_double(_sh_ljs_get_double(np24) + _sh_ljs_get_double(np22));
  np27 = _sh_ljs_bit_and_rjs_inline(shr, &np25, &np8);
  np27 = _sh_ljs_bit_or_rjs_inline(shr, &np19, &np27);
  np27 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np24)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np27))));
  goto L35;
L34:
  ;
  np25 = _sh_ljs_double((double)(unsigned char)deherm_script_static_write_string_byte(_sh_ljs_get_native_pointer(np11), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np25))));
  np23 = np24;
  goto L35;
L35:
  ;
  // PhiInst
  np3 = _sh_ljs_double(_sh_ljs_get_double(np1) + _sh_ljs_get_double(np22));
  np1 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 35);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np3) < _sh_ljs_get_double(np1));
  np2 = np23;
  if(_sh_ljs_get_bool(np1)) goto L19;
  goto L36;

L36:
  ;
  _sh_leave(shr, &locals.head, frame);
  return np0;

L37:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[46] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:60:1
static SHLegacyValue _7___decode(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
    SHLegacyValue t4;
    SHLegacyValue t5;
    SHLegacyValue t6;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 12);
  locals.head.count =7;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_undefined();
  locals.t5 = _sh_ljs_undefined();
  locals.t6 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();
  SHLegacyValue np9 = _sh_ljs_undefined();
  SHLegacyValue np10 = _sh_ljs_undefined();
  SHLegacyValue np11 = _sh_ljs_undefined();
  SHLegacyValue np12 = _sh_ljs_undefined();

L0:
  ;
  np8 = _sh_ljs_param(frame, 3);
  np7 = _sh_ljs_double(8);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np8) > _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np0)) goto L46;
  goto L1;

L1:
  ;
  locals.t0 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  np2 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_param(frame, 2);
  np9 = _sh_ljs_double((double)(unsigned char)deherm_script_static_value_tag(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np1 = _sh_ljs_double(0);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np9) == _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np3)) goto L45;
  goto L2;

L2:
  ;
  np5 = _sh_ljs_double(1);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np9) == _sh_ljs_get_double(np5));
  if(_sh_ljs_get_bool(np3)) goto L44;
  goto L3;

L3:
  ;
  np4 = _sh_ljs_double(2);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np9) == _sh_ljs_get_double(np4));
  if(_sh_ljs_get_bool(np3)) goto L43;
  goto L4;

L4:
  ;
  np3 = _sh_ljs_double(3);
  np6 = _sh_ljs_bool(_sh_ljs_get_double(np9) == _sh_ljs_get_double(np3));
  if(_sh_ljs_get_bool(np6)) goto L42;
  goto L5;

L5:
  ;
  np6 = _sh_ljs_double(4);
  np10 = _sh_ljs_bool(_sh_ljs_get_double(np9) == _sh_ljs_get_double(np6));
  if(_sh_ljs_get_bool(np10)) goto L41;
  goto L6;

L6:
  ;
  np10 = _sh_ljs_double(5);
  np10 = _sh_ljs_bool(_sh_ljs_get_double(np9) == _sh_ljs_get_double(np10));
  if(_sh_ljs_get_bool(np10)) goto L38;
  goto L7;

L7:
  ;
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np9) == _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np7)) goto L31;
  goto L8;

L8:
  ;
  np7 = _sh_ljs_double(7);
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np9) != _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np7)) goto L30;
  goto L9;

L9:
  ;
  np7 = _sh_ljs_double((double)(unsigned char)deherm_script_static_value_auxiliary(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np11 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_length(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  locals.t1 = _sh_ljs_get_env(shr, locals.t0, 1);
  np9 = _sh_ljs_bool(_sh_ljs_get_double(np7) == _sh_ljs_get_double(np5));
  if(_sh_ljs_get_bool(np9)) goto L25;
  goto L10;

L10:
  ;
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np7) == _sh_ljs_get_double(np4));
  if(_sh_ljs_get_bool(np7)) goto L18;
  goto L11;

L11:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 2);
  locals.t4 = _sh_new_fastarray_with_proto(shr, &locals.t2, 0);
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 2);
  locals.t3 = _sh_new_fastarray_with_proto(shr, &locals.t2, 0);
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np1) < _sh_ljs_get_double(np11));
  np12 = _sh_ljs_double(_sh_ljs_get_double(np8) + _sh_ljs_get_double(np5));
  np10 = _sh_ljs_undefined();
  np9 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np7)) goto L12;
  goto L13;

L12:
  ;
  // PhiInst
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 14);
  frame[2] = _sh_ljs_double((double)(unsigned int)deherm_script_static_entry_key(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np9))));
  frame[6] = _sh_ljs_undefined();
  frame[5] = locals.t2;
  frame[4] = _sh_ljs_double(0);
  frame[3] = np2;
  frame[1] = np12;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  locals.t5 = _7___decode(shr);
  _sh_fastarray_push(shr, &locals.t5, &locals.t4);
  frame[2] = _sh_ljs_double((double)(unsigned int)deherm_script_static_entry_value(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np9))));
  frame[6] = _sh_ljs_undefined();
  frame[5] = locals.t2;
  frame[4] = _sh_ljs_double(0);
  frame[3] = np2;
  frame[1] = np12;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  locals.t2 = _7___decode(shr);
  _sh_fastarray_push(shr, &locals.t2, &locals.t3);
  np9 = _sh_ljs_double(_sh_ljs_get_double(np9) + _sh_ljs_get_double(np5));
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np9) < _sh_ljs_get_double(np11));
  if(_sh_ljs_get_bool(np7)) goto L12;
  goto L13;

L13:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 12);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 41);
  locals.t5 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t5))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np7 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t5, 128));
  if(_sh_ljs_get_bool(np7)) goto L15;
  goto L14;

L14:
  ;
  locals.t5 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t5);

L15:
  ;
  np9 = _sh_fastarray_length(shr, &locals.t4);
  np7 = _sh_fastarray_length(shr, &locals.t3);
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np9) != _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np7)) goto L17;
  goto L16;

L16:
  ;
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 7, 66);
  _sh_prstore_object(shr, &locals.t2, 0, &locals.t4);
  _sh_prstore_object(shr, &locals.t2, 1, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L17:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[48] /*deherm map key/value...*/);
  _sh_throw(shr, locals.t2);

L18:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 3);
  locals.t4 = _sh_new_fastarray_with_proto(shr, &locals.t2, 0);
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 2);
  locals.t3 = _sh_new_fastarray_with_proto(shr, &locals.t2, 0);
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np1) < _sh_ljs_get_double(np11));
  np12 = _sh_ljs_double(_sh_ljs_get_double(np8) + _sh_ljs_get_double(np5));
  np10 = _sh_ljs_undefined();
  np9 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np7)) goto L19;
  goto L20;

L19:
  ;
  // PhiInst
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 14);
  frame[2] = _sh_ljs_double((double)(unsigned int)deherm_script_static_entry_key(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np9))));
  frame[6] = _sh_ljs_undefined();
  frame[5] = locals.t2;
  frame[4] = _sh_ljs_double(0);
  frame[3] = np2;
  frame[1] = np12;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  locals.t6 = _7___decode(shr);
  locals.t5 = _sh_typed_load_parent(shr, &locals.t6);
  frame[5] = _sh_prload(shr, locals.t5, 1);
  frame[6] = _sh_ljs_undefined();
  frame[4] = locals.t6;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(0);
  locals.t5 = ((SHNativeJSFunction *)_sh_ljs_get_pointer(frame[5]))->functionPtr(shr);
  _sh_fastarray_push(shr, &locals.t5, &locals.t4);
  frame[2] = _sh_ljs_double((double)(unsigned int)deherm_script_static_entry_value(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np9))));
  frame[6] = _sh_ljs_undefined();
  frame[5] = locals.t2;
  frame[4] = _sh_ljs_double(0);
  frame[3] = np2;
  frame[1] = np12;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  locals.t2 = _7___decode(shr);
  _sh_fastarray_push(shr, &locals.t2, &locals.t3);
  np9 = _sh_ljs_double(_sh_ljs_get_double(np9) + _sh_ljs_get_double(np5));
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np9) < _sh_ljs_get_double(np11));
  if(_sh_ljs_get_bool(np7)) goto L19;
  goto L20;

L20:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 11);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 40);
  locals.t5 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t5))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np7 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t5, 128));
  if(_sh_ljs_get_bool(np7)) goto L22;
  goto L21;

L21:
  ;
  locals.t5 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t5);

L22:
  ;
  np9 = _sh_fastarray_length(shr, &locals.t4);
  np7 = _sh_fastarray_length(shr, &locals.t3);
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np9) != _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np7)) goto L24;
  goto L23;

L23:
  ;
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 7, 66);
  _sh_prstore_object(shr, &locals.t2, 0, &locals.t4);
  _sh_prstore_object(shr, &locals.t2, 1, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L24:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[49] /*deherm record key/va...*/);
  _sh_throw(shr, locals.t2);

L25:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t1, 2);
  locals.t2 = _sh_new_fastarray_with_proto(shr, &locals.t1, 0);
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np1) < _sh_ljs_get_double(np11));
  np10 = _sh_ljs_undefined();
  np9 = _sh_ljs_double(_sh_ljs_get_double(np8) + _sh_ljs_get_double(np5));
  np8 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np7)) goto L26;
  goto L27;

L26:
  ;
  // PhiInst
  frame[5] = _sh_ljs_load_from_env(locals.t0, 14);
  frame[2] = _sh_ljs_double((double)(unsigned int)deherm_script_static_entry_value(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np8))));
  frame[6] = _sh_ljs_undefined();
  frame[4] = _sh_ljs_double(0);
  frame[3] = np2;
  frame[1] = np9;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  locals.t1 = _7___decode(shr);
  _sh_fastarray_push(shr, &locals.t1, &locals.t2);
  np8 = _sh_ljs_double(_sh_ljs_get_double(np8) + _sh_ljs_get_double(np5));
  np7 = _sh_ljs_bool(_sh_ljs_get_double(np8) < _sh_ljs_get_double(np11));
  if(_sh_ljs_get_bool(np7)) goto L26;
  goto L27;

L27:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 10);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 39);
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np7 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t3, 128));
  if(_sh_ljs_get_bool(np7)) goto L29;
  goto L28;

L28:
  ;
  locals.t3 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t3);

L29:
  ;
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 8, 67);
  _sh_prstore_object(shr, &locals.t1, 0, &locals.t2);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L30:
  ;
  locals.t1 = _sh_ljs_get_string(shr, get_symbols(shUnit)[50] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t1);

L31:
  ;
  np10 = _sh_ljs_double((double)(unsigned char)deherm_script_static_value_defold_kind(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np6 = _sh_ljs_bool(_sh_ljs_get_double(np10) == _sh_ljs_get_double(np6));
  if(_sh_ljs_get_bool(np6)) goto L33;
  goto L32;

L32:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 6);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 36);
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 6, 3);
  np9 = _sh_ljs_untrusted_double(deherm_script_static_value_lane(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np1))));
  np8 = _sh_ljs_untrusted_double(deherm_script_static_value_lane(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np5))));
  np7 = _sh_ljs_untrusted_double(deherm_script_static_value_lane(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np4))));
  np6 = _sh_ljs_untrusted_double(deherm_script_static_value_lane(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np3))));
  _sh_prstore_number(shr, &locals.t1, 0, &np10);
  _sh_prstore_number(shr, &locals.t1, 1, &np9);
  _sh_prstore_number(shr, &locals.t1, 2, &np8);
  _sh_prstore_number(shr, &locals.t1, 3, &np7);
  _sh_prstore_number(shr, &locals.t1, 4, &np6);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L33:
  ;
  locals.t1 = _sh_ljs_get_env(shr, locals.t0, 1);
  locals.t1 = _sh_ljs_load_from_env(locals.t1, 1);
  locals.t2 = _sh_new_fastarray_with_proto(shr, &locals.t1, 0);
  np7 = _sh_ljs_double(16);
  np8 = _sh_ljs_double(0);
  goto L34;
L34:
  ;
  // PhiInst
  np6 = _sh_ljs_untrusted_double(deherm_script_static_value_element(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np8))));
  _sh_fastarray_push(shr, &np6, &locals.t2);
  np8 = _sh_ljs_double(_sh_ljs_get_double(np8) + _sh_ljs_get_double(np5));
  np6 = _sh_ljs_bool(_sh_ljs_get_double(np8) < _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np6)) goto L34;
  goto L35;

L35:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 7);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 37);
  np6 = _sh_fastarray_length(shr, &locals.t2);
  np6 = _sh_ljs_bool(_sh_ljs_get_double(np6) != _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np6)) goto L37;
  goto L36;

L36:
  ;
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 9, 67);
  _sh_prstore_object(shr, &locals.t1, 0, &locals.t2);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L37:
  ;
  locals.t1 = _sh_ljs_get_string(shr, get_symbols(shUnit)[51] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t1);

L38:
  ;
  np10 = _sh_ljs_double((double)(unsigned char)deherm_script_static_value_handle_kind(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np6 = _sh_ljs_bool(_sh_ljs_get_double(np10) == _sh_ljs_get_double(np4));
  if(_sh_ljs_get_bool(np6)) goto L40;
  goto L39;

L39:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 5);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 35);
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 5, 3);
  np9 = _sh_ljs_double((double)(unsigned char)deherm_script_static_value_auxiliary(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np8 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_runtime(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np7 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_payload_low(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np6 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_payload_high(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  _sh_prstore_number(shr, &locals.t1, 0, &np10);
  _sh_prstore_number(shr, &locals.t1, 1, &np9);
  _sh_prstore_number(shr, &locals.t1, 2, &np8);
  _sh_prstore_number(shr, &locals.t1, 3, &np7);
  _sh_prstore_number(shr, &locals.t1, 4, &np6);
  np6 = _sh_ljs_bool(false);
  _sh_prstore_bool(shr, &locals.t1, 5, &np6);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L40:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 8);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 38);
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 4, 33);
  np10 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_low(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np1))));
  np9 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_high(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np1))));
  np8 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_low(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np5))));
  np7 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_high(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np5))));
  np6 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_low(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np4))));
  np5 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_high(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np4))));
  np4 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_low(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np3))));
  np3 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_url_high(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np3))));
  _sh_prstore_number(shr, &locals.t1, 0, &np10);
  _sh_prstore_number(shr, &locals.t1, 1, &np9);
  _sh_prstore_number(shr, &locals.t1, 2, &np8);
  _sh_prstore_number(shr, &locals.t1, 3, &np7);
  _sh_prstore_number(shr, &locals.t1, 4, &np6);
  _sh_prstore_number(shr, &locals.t1, 5, &np5);
  _sh_prstore_number(shr, &locals.t1, 6, &np4);
  _sh_prstore_number(shr, &locals.t1, 7, &np3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L41:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 4);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 34);
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 3, 30);
  np5 = _sh_ljs_native_pointer_or_throw(shr, deherm_script_static_value_string(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np4 = _sh_ljs_double((double)(unsigned int)deherm_script_static_value_length(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np3 = _sh_ljs_native_pointer(shr);
  locals.t2 = _sh_asciiz_to_string(_sh_ljs_get_native_pointer(np3), _sh_ljs_get_native_pointer(np5), (int)_sh_to_int32_double(_sh_ljs_get_double(np4)));
  _sh_prstore_string(shr, &locals.t1, 0, &locals.t2);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L42:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 3);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 33);
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 3, 25);
  np3 = _sh_ljs_untrusted_double(deherm_script_static_value_number(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  _sh_prstore_number(shr, &locals.t1, 0, &np3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L43:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 2);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 32);
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 3, 24);
  np0 = _sh_ljs_untrusted_double(deherm_script_static_value_number(_sh_ljs_get_native_pointer(np2), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np0) != _sh_ljs_get_double(np1));
  _sh_prstore_bool(shr, &locals.t1, 0, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L44:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 31);
  locals.t1 = _sh_ljs_new_object_with_parent(shr, &locals.t1);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L45:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t0 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t0 = _sh_ljs_new_object_with_parent(shr, &locals.t0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t0;

L46:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[52] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:61:1
static SHLegacyValue _8_dispatchScriptUniversalValue(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
    SHLegacyValue t4;
    SHLegacyValue t5;
    SHLegacyValue t6;
    SHLegacyValue t7;
    SHLegacyValue t8;
    SHLegacyValue t9;
    SHLegacyValue t10;
    SHLegacyValue t11;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 12);
  locals.head.count =12;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_undefined();
  locals.t5 = _sh_ljs_undefined();
  locals.t6 = _sh_ljs_undefined();
  locals.t7 = _sh_ljs_undefined();
  locals.t8 = _sh_ljs_undefined();
  locals.t9 = _sh_ljs_undefined();
  locals.t10 = _sh_ljs_undefined();
  locals.t11 = _sh_ljs_undefined();

  SHJmpBuf jmpBuf;
  volatile uint32_t tryState = 0;
  if (__builtin_expect(_sh_try(shr, &jmpBuf), 0) != 0) goto L_catch;

L0:
  ;
  locals.t2 = _sh_ljs_param(frame, 2);
  locals.t1 = _sh_fastarray_length(shr, &locals.t2);
  locals.t0 = _sh_ljs_double(32);
  locals.t0 = _sh_ljs_bool(_sh_ljs_get_double(locals.t1) > _sh_ljs_get_double(locals.t0));
  if(_sh_ljs_get_bool(locals.t0)) goto L16;
  goto L1;

L1:
  ;
  locals.t1 = _sh_ljs_native_pointer_or_throw(shr, deherm_script_static_frame_acquire());
  if(_sh_ljs_to_boolean(locals.t1)) goto L3;
  goto L2;

L2:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[53] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L3:
  ;
  tryState = 1;
  goto L4;

L4:
  ;
  locals.t8 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  locals.t0 = _sh_fastarray_length(shr, &locals.t2);
  locals.t7 = _sh_ljs_double(0);
  locals.t3 = _sh_ljs_bool(_sh_ljs_get_double(locals.t7) < _sh_ljs_get_double(locals.t0));
  locals.t6 = _sh_ljs_double(1);
  locals.t0 = _sh_ljs_get_env(shr, locals.t8, 1);
  locals.t5 = _sh_ljs_undefined();
  locals.t9 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  locals.t4 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(locals.t3)) goto L5;
  goto L8;

L5:
  ;
  // PhiInst
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 0);
  locals.t11 = _sh_fastarray_load(shr, &locals.t2, _sh_ljs_get_double(locals.t4));
  locals.t10 = _sh_typed_load_parent(shr, &locals.t11);
  frame[5] = _sh_prload(shr, locals.t10, 0);
  frame[2] = _sh_new_fastarray_with_proto(shr, &locals.t3, 0);
  frame[6] = _sh_ljs_undefined();
  frame[4] = locals.t11;
  frame[3] = locals.t1;
  frame[1] = _sh_ljs_double(0);
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  locals.t3 = ((SHNativeJSFunction *)_sh_ljs_get_pointer(frame[5]))->functionPtr(shr);
  locals.t10 = _sh_ljs_bool(_sh_ljs_get_double(locals.t3) == _sh_ljs_get_double(locals.t9));
  if(_sh_ljs_get_bool(locals.t10)) goto L14;
  goto L6;

L6:
  ;
  locals.t3 = _sh_ljs_double((double)(unsigned char)deherm_script_static_set_argument(_sh_ljs_get_native_pointer(locals.t1), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(locals.t4)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(locals.t3))));
  if(_sh_ljs_to_boolean(locals.t3)) goto L7;
  goto L14;

L7:
  ;
  locals.t4 = _sh_ljs_double(_sh_ljs_get_double(locals.t4) + _sh_ljs_get_double(locals.t6));
  locals.t3 = _sh_fastarray_length(shr, &locals.t2);
  locals.t3 = _sh_ljs_bool(_sh_ljs_get_double(locals.t4) < _sh_ljs_get_double(locals.t3));
  if(_sh_ljs_get_bool(locals.t3)) goto L5;
  goto L8;

L8:
  ;
  locals.t3 = _sh_ljs_param(frame, 1);
  locals.t2 = _sh_fastarray_length(shr, &locals.t2);
  locals.t2 = _sh_ljs_double((double)(unsigned int)deherm_script_static_dispatch(_sh_ljs_get_native_pointer(locals.t1), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(locals.t3)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(locals.t2))));
  locals.t2 = _sh_ljs_bool(_sh_ljs_get_double(locals.t2) != _sh_ljs_get_double(locals.t7));
  if(_sh_ljs_get_bool(locals.t2)) goto L13;
  goto L9;

L9:
  ;
  locals.t0 = _sh_ljs_load_from_env(locals.t0, 2);
  locals.t0 = _sh_new_fastarray_with_proto(shr, &locals.t0, 0);
  locals.t4 = _sh_ljs_double((double)(unsigned int)deherm_script_static_result_count(_sh_ljs_get_native_pointer(locals.t1)));
  locals.t2 = _sh_ljs_bool(_sh_ljs_get_double(locals.t7) < _sh_ljs_get_double(locals.t4));
  locals.t3 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(locals.t2)) goto L10;
  goto L11;

L10:
  ;
  // PhiInst
  frame[5] = _sh_ljs_load_from_env(locals.t8, 14);
  frame[2] = _sh_ljs_double((double)(unsigned int)deherm_script_static_result_root(_sh_ljs_get_native_pointer(locals.t1), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(locals.t3))));
  frame[6] = _sh_ljs_undefined();
  frame[4] = _sh_ljs_double(0);
  frame[3] = locals.t1;
  frame[1] = _sh_ljs_double(0);
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  locals.t2 = _7___decode(shr);
  _sh_fastarray_push(shr, &locals.t2, &locals.t0);
  locals.t3 = _sh_ljs_double(_sh_ljs_get_double(locals.t3) + _sh_ljs_get_double(locals.t6));
  locals.t2 = _sh_ljs_bool(_sh_ljs_get_double(locals.t3) < _sh_ljs_get_double(locals.t4));
  if(_sh_ljs_get_bool(locals.t2)) goto L10;
  goto L11;

L11:
  ;
  tryState = 0;
  goto L12;

L12:
  ;
  deherm_script_static_frame_release(_sh_ljs_get_native_pointer(locals.t1));
  locals.t2 = _sh_ljs_undefined();
  _sh_end_try(shr, &jmpBuf);
  _sh_leave(shr, &locals.head, frame);
  return locals.t0;

L13:
  ;
  locals.t3 = _sh_ljs_native_pointer_or_throw(shr, deherm_script_static_error(_sh_ljs_get_native_pointer(locals.t1)));
  locals.t2 = _sh_ljs_double(-1);
  locals.t0 = _sh_ljs_native_pointer(shr);
  locals.t0 = _sh_asciiz_to_string(_sh_ljs_get_native_pointer(locals.t0), _sh_ljs_get_native_pointer(locals.t3), (int)_sh_to_int32_double(_sh_ljs_get_double(locals.t2)));
  _sh_throw(shr, locals.t0);

L14:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[54] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L15:
  ;
  tryState = 0;
  locals.t0 = _sh_get_clear_thrown_value(shr);
  deherm_script_static_frame_release(_sh_ljs_get_native_pointer(locals.t1));
  locals.t1 = _sh_ljs_undefined();
  _sh_throw(shr, locals.t0);

L16:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[55] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L_catch:
  if (tryState == 0) {
    _sh_end_try(shr, &jmpBuf);
    _sh_throw_current(shr);
  }
  _sh_catch_no_pop(shr, (SHLocals*)&locals, frame, 12);

  switch (tryState) {
    default:
      abort();
    case 1:
      goto L15;
  }
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:167:1
static SHLegacyValue _9___dehermToStatic(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
    SHLegacyValue t4;
    SHLegacyValue t5;
    SHLegacyValue t6;
    SHLegacyValue t7;
    SHLegacyValue t8;
    SHLegacyValue t9;
    SHLegacyValue t10;
    SHLegacyValue t11;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 11);
  locals.head.count =12;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_undefined();
  locals.t5 = _sh_ljs_undefined();
  locals.t6 = _sh_ljs_undefined();
  locals.t7 = _sh_ljs_undefined();
  locals.t8 = _sh_ljs_undefined();
  locals.t9 = _sh_ljs_undefined();
  locals.t10 = _sh_ljs_undefined();
  locals.t11 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();
  SHLegacyValue np9 = _sh_ljs_undefined();
  SHLegacyValue np10 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  locals.t1 = _sh_ljs_param(frame, 1);
  np1 = _sh_ljs_null();
  np0 = _sh_ljs_bool(locals.t1.raw == np1.raw);
  if(_sh_ljs_get_bool(np0)) goto L75;
  goto L1;

L1:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t1, 1));
  if(_sh_ljs_get_bool(np0)) goto L74;
  goto L2;

L2:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t1, 32));
  if(_sh_ljs_get_bool(np0)) goto L73;
  goto L3;

L3:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t1, 16));
  if(_sh_ljs_get_bool(np0)) goto L72;
  goto L4;

L4:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t1, 4));
  if(_sh_ljs_get_bool(np0)) goto L71;
  goto L5;

L5:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t1, 64));
  if(_sh_ljs_get_bool(np0)) goto L70;
  goto L6;

L6:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t1, 253));
  if(_sh_ljs_get_bool(np0)) goto L69;
  goto L7;

L7:
  ;
  np5 = _sh_ljs_param(frame, 2);
  np0 = _sh_ljs_load_from_env(locals.t0, 18);
  if (!(_sh_ljs_is_double(np0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np5) > _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L69;
  goto L8;

L8:
  ;
  locals.t2 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[56] /*__dehermValueKind*/, get_read_prop_cache(shUnit) + 36);
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t2, 4));
  if(_sh_ljs_get_bool(np0)) goto L58;
  goto L9;

L9:
  ;
  locals.t3 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[57] /*__dehermUrlV1*/, get_read_prop_cache(shUnit) + 37);
  np0 = _sh_ljs_bool(true);
  np2 = _sh_ljs_bool(locals.t3.raw == np0.raw);
  if(_sh_ljs_get_bool(np2)) goto L52;
  goto L10;

L10:
  ;
  frame[4] = _sh_ljs_load_from_env(locals.t0, 19);
  np8 = _sh_ljs_undefined();
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  frame[2] = locals.t1;
  locals.t3 = _sh_ljs_call(shr, frame, 1);
  if(_sh_ljs_to_boolean(locals.t3)) goto L36;
  goto L11;

L11:
  ;
  frame[4] = _sh_ljs_load_from_env(locals.t0, 20);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  frame[2] = locals.t1;
  locals.t3 = _sh_ljs_call(shr, frame, 1);
  locals.t4 = _sh_ljs_load_from_env(locals.t0, 23);
  np2 = _sh_ljs_bool(_sh_ljs_strict_equal_inline(locals.t3, locals.t4));
  if(_sh_ljs_get_bool(np2)) goto L24;
  goto L12;

L12:
  ;
  locals.t4 = _sh_ljs_load_from_env(locals.t0, 21);
  np2 = _sh_ljs_bool(!_sh_ljs_strict_equal_inline(locals.t3, locals.t4));
  if(_sh_ljs_get_bool(np2)) goto L13;
  goto L14;

L13:
  ;
  np1 = _sh_ljs_bool(locals.t3.raw != np1.raw);
  if(_sh_ljs_get_bool(np1)) goto L23;
  goto L14;

L14:
  ;
  locals.t3 = _sh_ljs_get_env(shr, locals.t0, 1);
  locals.t4 = _sh_ljs_load_from_env(locals.t3, 3);
  locals.t5 = _sh_new_fastarray_with_proto(shr, &locals.t4, 0);
  locals.t3 = _sh_ljs_load_from_env(locals.t3, 2);
  locals.t4 = _sh_new_fastarray_with_proto(shr, &locals.t3, 0);
  // AllocStackInst
  // AllocStackInst
  // AllocStackInst
  // AllocStackInst
  locals.t6 = locals.t1;
  // AllocStackInst
  np1 = _sh_ljs_double(1);
  np2 = _sh_ljs_double(_sh_ljs_get_double(np5) + _sh_ljs_get_double(np1));
  locals.t7 = _sh_ljs_get_pname_list_rjs(shr, &locals.t6, &np6, &np4);
  if (_sh_ljs_is_undefined(locals.t7)) goto L18;
  goto L15;

L15:
  ;
  locals.t3 = _sh_ljs_get_next_pname_rjs(shr, &locals.t7, &locals.t6, &np6, &np4);
  if (_sh_ljs_is_undefined(locals.t3)) goto L18;
  goto L16;

L16:
  ;
  locals.t8 = locals.t3;
  _sh_fastarray_push(shr, &locals.t8, &locals.t5);
  frame[4] = _sh_ljs_load_from_env(locals.t0, 27);
  frame[2] = _sh_ljs_get_by_val_rjs(shr,&locals.t1, &locals.t8);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[1] = np2;
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(2);
  locals.t8 = _9___dehermToStatic(shr);
  _sh_fastarray_push(shr, &locals.t8, &locals.t4);
  np1 = _sh_ljs_load_from_env(locals.t0, 26);
  if (!(_sh_ljs_is_bool(np1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  if(_sh_ljs_get_bool(np1)) goto L17;
  goto L15;

L17:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L18:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 11);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 40);
  locals.t6 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t6))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np1 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t6, 128));
  if(_sh_ljs_get_bool(np1)) goto L20;
  goto L19;

L19:
  ;
  locals.t6 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t6);

L20:
  ;
  np2 = _sh_fastarray_length(shr, &locals.t5);
  np1 = _sh_fastarray_length(shr, &locals.t4);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np2) != _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L22;
  goto L21;

L21:
  ;
  locals.t3 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t3, 7, 66);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t5);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t4);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L22:
  ;
  locals.t3 = _sh_ljs_get_string(shr, get_symbols(shUnit)[49] /*deherm record key/va...*/);
  _sh_throw(shr, locals.t3);

L23:
  ;
  _sh_ljs_store_to_env(shr, locals.t0,np0, 26);
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L24:
  ;
  locals.t3 = _sh_ljs_get_env(shr, locals.t0, 1);
  locals.t4 = _sh_ljs_load_from_env(locals.t3, 2);
  locals.t5 = _sh_new_fastarray_with_proto(shr, &locals.t4, 0);
  locals.t3 = _sh_ljs_load_from_env(locals.t3, 2);
  locals.t4 = _sh_new_fastarray_with_proto(shr, &locals.t3, 0);
  frame[4] = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[58] /*entries*/, get_read_prop_cache(shUnit) + 38);
  frame[5] = _sh_ljs_undefined();
  frame[3] = locals.t1;
  locals.t3 = _sh_ljs_call(shr, frame, 0);
  np1 = _sh_ljs_double(1);
  np1 = _sh_ljs_double(_sh_ljs_get_double(np5) + _sh_ljs_get_double(np1));
  goto L25;
L25:
  ;
  frame[4] = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t3,get_symbols(shUnit)[59] /*next*/, get_read_prop_cache(shUnit) + 39);
  frame[5] = _sh_ljs_undefined();
  frame[3] = locals.t3;
  locals.t6 = _sh_ljs_call(shr, frame, 0);
  locals.t7 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t6,get_symbols(shUnit)[60] /*done*/, get_read_prop_cache(shUnit) + 40);
  np3 = _sh_ljs_bool(locals.t7.raw == np0.raw);
  if(_sh_ljs_get_bool(np3)) goto L31;
  goto L26;

L26:
  ;
  locals.t7 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t6,get_symbols(shUnit)[7] /*value*/, get_read_prop_cache(shUnit) + 41);
  locals.t8 = _sh_ljs_load_from_env(locals.t0, 27);
  frame[2] = _sh_ljs_get_by_index_rjs(shr,&locals.t7, 0);
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t8;
  frame[3] = _sh_ljs_double(0);
  frame[1] = np1;
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(2);
  locals.t6 = _9___dehermToStatic(shr);
  np3 = _sh_ljs_load_from_env(locals.t0, 26);
  if (!(_sh_ljs_is_bool(np3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  if(_sh_ljs_get_bool(np3)) goto L30;
  goto L27;

L27:
  ;
  frame[2] = _sh_ljs_get_by_index_rjs(shr,&locals.t7, 1);
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t8;
  frame[3] = _sh_ljs_double(0);
  frame[1] = np1;
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(2);
  locals.t7 = _9___dehermToStatic(shr);
  _sh_fastarray_push(shr, &locals.t7, &locals.t4);
  np3 = _sh_ljs_load_from_env(locals.t0, 26);
  if (!(_sh_ljs_is_bool(np3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  if(_sh_ljs_get_bool(np3)) goto L29;
  goto L28;

L28:
  ;
  _sh_fastarray_push(shr, &locals.t6, &locals.t5);
  goto L25;
L29:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L30:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L31:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 12);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 41);
  locals.t6 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t6))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np1 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t6, 128));
  if(_sh_ljs_get_bool(np1)) goto L33;
  goto L32;

L32:
  ;
  locals.t6 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t6);

L33:
  ;
  np2 = _sh_fastarray_length(shr, &locals.t5);
  np1 = _sh_fastarray_length(shr, &locals.t4);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np2) != _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L35;
  goto L34;

L34:
  ;
  locals.t3 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t3, 7, 66);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t5);
  _sh_prstore_object(shr, &locals.t3, 1, &locals.t4);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L35:
  ;
  locals.t3 = _sh_ljs_get_string(shr, get_symbols(shUnit)[48] /*deherm map key/value...*/);
  _sh_throw(shr, locals.t3);

L36:
  ;
  locals.t3 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 42);
  if (!(_sh_ljs_is_double(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np7 = locals.t3;
  np1 = _sh_ljs_double(0);
  np2 = _sh_ljs_double(16);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np7) == _sh_ljs_get_double(np2));
  np4 = _sh_ljs_double(1);
  np9 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np3)) goto L37;
  goto L40;

L37:
  ;
  // PhiInst
  locals.t3 = _sh_ljs_get_by_val_rjs(shr,&locals.t1, &np9);
  np6 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t3, 479));
  np3 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np6)) goto L39;
  goto L38;

L38:
  ;
  np9 = _sh_ljs_double(_sh_ljs_get_double(np9) + _sh_ljs_get_double(np4));
  np6 = _sh_ljs_bool(_sh_ljs_get_double(np9) < _sh_ljs_get_double(np2));
  np3 = _sh_ljs_bool(true);
  if(_sh_ljs_get_bool(np6)) goto L37;
  goto L39;

L39:
  ;
  // PhiInst
  if(_sh_ljs_get_bool(np3)) goto L47;
  goto L40;

L40:
  ;
  locals.t3 = _sh_ljs_get_env(shr, locals.t0, 1);
  locals.t3 = _sh_ljs_load_from_env(locals.t3, 2);
  locals.t4 = _sh_new_fastarray_with_proto(shr, &locals.t3, 0);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np1) < _sh_ljs_get_double(np7));
  np6 = _sh_ljs_double(_sh_ljs_get_double(np5) + _sh_ljs_get_double(np4));
  np5 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np3)) goto L41;
  goto L43;

L41:
  ;
  // PhiInst
  frame[4] = _sh_ljs_load_from_env(locals.t0, 27);
  frame[2] = _sh_ljs_get_by_val_rjs(shr,&locals.t1, &np5);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[1] = np6;
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(2);
  locals.t3 = _9___dehermToStatic(shr);
  _sh_fastarray_push(shr, &locals.t3, &locals.t4);
  np3 = _sh_ljs_load_from_env(locals.t0, 26);
  if (!(_sh_ljs_is_bool(np3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  if(_sh_ljs_get_bool(np3)) goto L46;
  goto L42;

L42:
  ;
  np5 = _sh_ljs_double(_sh_ljs_get_double(np5) + _sh_ljs_get_double(np4));
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np5) < _sh_ljs_get_double(np7));
  if(_sh_ljs_get_bool(np3)) goto L41;
  goto L43;

L43:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 10);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 39);
  locals.t5 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t5))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np3 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t5, 128));
  if(_sh_ljs_get_bool(np3)) goto L45;
  goto L44;

L44:
  ;
  locals.t5 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t5);

L45:
  ;
  locals.t3 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t3, 8, 67);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t4);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L46:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L47:
  ;
  locals.t3 = _sh_ljs_get_env(shr, locals.t0, 1);
  locals.t3 = _sh_ljs_load_from_env(locals.t3, 1);
  locals.t4 = _sh_new_fastarray_with_proto(shr, &locals.t3, 0);
  np3 = _sh_ljs_double(0);
  goto L48;
L48:
  ;
  // PhiInst
  locals.t3 = _sh_ljs_get_by_val_rjs(shr,&locals.t1, &np3);
  _sh_fastarray_push(shr, &locals.t3, &locals.t4);
  np3 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np4));
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np3) < _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np1)) goto L48;
  goto L49;

L49:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 7);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 37);
  np1 = _sh_fastarray_length(shr, &locals.t4);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np1) != _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np1)) goto L51;
  goto L50;

L50:
  ;
  locals.t3 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t3, 9, 67);
  _sh_prstore_object(shr, &locals.t3, 0, &locals.t4);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L51:
  ;
  locals.t3 = _sh_ljs_get_string(shr, get_symbols(shUnit)[51] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t3);

L52:
  ;
  locals.t10 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[61] /*socket*/, get_read_prop_cache(shUnit) + 43);
  locals.t9 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[62] /*reserved*/, get_read_prop_cache(shUnit) + 44);
  locals.t8 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[63] /*path*/, get_read_prop_cache(shUnit) + 45);
  locals.t7 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[64] /*fragment*/, get_read_prop_cache(shUnit) + 46);
  np1 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t10, 64));
  if(_sh_ljs_get_bool(np1)) goto L53;
  goto L56;

L53:
  ;
  np1 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t9, 64));
  if(_sh_ljs_get_bool(np1)) goto L54;
  goto L56;

L54:
  ;
  np1 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t8, 64));
  if(_sh_ljs_get_bool(np1)) goto L55;
  goto L56;

L55:
  ;
  np1 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t7, 64));
  if(_sh_ljs_get_bool(np1)) goto L57;
  goto L56;

L56:
  ;
  _sh_ljs_store_to_env(shr, locals.t0,np0, 26);
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t3 = _sh_ljs_new_object_with_parent(shr, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L57:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 8);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 38);
  locals.t3 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t3, 4, 33);
  locals.t5 = _sh_ljs_get_global_object(shr);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 47);
  locals.t6 = _sh_ljs_load_from_env(locals.t0, 24);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t10, &locals.t6);
  np0 = _sh_ljs_undefined();
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t4))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np7 = locals.t4;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 48);
  locals.t4 = _sh_ljs_load_from_env(locals.t0, 25);
  locals.t10 = _sh_ljs_right_shift_rjs_inline(shr, &locals.t10, &locals.t4);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t10, &locals.t6);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t10 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t10))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np6 = locals.t10;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 49);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t9, &locals.t6);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t10 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t10))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np5 = locals.t10;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 50);
  locals.t9 = _sh_ljs_right_shift_rjs_inline(shr, &locals.t9, &locals.t4);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t9, &locals.t6);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t9 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t9))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np4 = locals.t9;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 51);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t8, &locals.t6);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t9 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t9))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np3 = locals.t9;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 52);
  locals.t8 = _sh_ljs_right_shift_rjs_inline(shr, &locals.t8, &locals.t4);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t8, &locals.t6);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t8 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t8))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np2 = locals.t8;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 53);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t7, &locals.t6);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t8 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t8))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np1 = locals.t8;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t5, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 54);
  locals.t4 = _sh_ljs_right_shift_rjs_inline(shr, &locals.t7, &locals.t4);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t4, &locals.t6);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t4))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = locals.t4;
  _sh_prstore_number(shr, &locals.t3, 0, &np7);
  _sh_prstore_number(shr, &locals.t3, 1, &np6);
  _sh_prstore_number(shr, &locals.t3, 2, &np5);
  _sh_prstore_number(shr, &locals.t3, 3, &np4);
  _sh_prstore_number(shr, &locals.t3, 4, &np3);
  _sh_prstore_number(shr, &locals.t3, 5, &np2);
  _sh_prstore_number(shr, &locals.t3, 6, &np1);
  _sh_prstore_number(shr, &locals.t3, 7, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L58:
  ;
  if (!(_sh_ljs_is_string(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t7 = locals.t2;
  locals.t5 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[23] /*x*/, get_read_prop_cache(shUnit) + 55);
  locals.t4 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[24] /*y*/, get_read_prop_cache(shUnit) + 56);
  locals.t3 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[25] /*z*/, get_read_prop_cache(shUnit) + 57);
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t5, 32));
  if(_sh_ljs_get_bool(np0)) goto L59;
  goto L65;

L59:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t4, 32));
  if(_sh_ljs_get_bool(np0)) goto L60;
  goto L65;

L60:
  ;
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t3, 32));
  if(_sh_ljs_get_bool(np0)) goto L61;
  goto L65;

L61:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[66] /*vector3*/);
  np0 = _sh_ljs_bool(_sh_ljs_strict_equal_inline(locals.t7, locals.t2));
  if(_sh_ljs_get_bool(np0)) goto L68;
  goto L62;

L62:
  ;
  locals.t6 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[26] /*w*/, get_read_prop_cache(shUnit) + 58);
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t6, 32));
  if(_sh_ljs_get_bool(np0)) goto L63;
  goto L65;

L63:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[67] /*vector4*/);
  np0 = _sh_ljs_bool(_sh_ljs_strict_equal_inline(locals.t7, locals.t2));
  if(_sh_ljs_get_bool(np0)) goto L67;
  goto L64;

L64:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[68] /*quaternion*/);
  np0 = _sh_ljs_bool(_sh_ljs_strict_equal_inline(locals.t7, locals.t2));
  if(_sh_ljs_get_bool(np0)) goto L66;
  goto L65;

L65:
  ;
  np0 = _sh_ljs_bool(true);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 26);
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t2 = _sh_ljs_new_object_with_parent(shr, &locals.t2);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L66:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 6);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 36);
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 6, 3);
  if (!(_sh_ljs_is_double(locals.t5))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np3 = locals.t5;
  if (!(_sh_ljs_is_double(locals.t4))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np2 = locals.t4;
  if (!(_sh_ljs_is_double(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np1 = locals.t3;
  if (!(_sh_ljs_is_double(locals.t6))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = locals.t6;
  np4 = _sh_ljs_double(3);
  _sh_prstore_number(shr, &locals.t2, 0, &np4);
  _sh_prstore_number(shr, &locals.t2, 1, &np3);
  _sh_prstore_number(shr, &locals.t2, 2, &np2);
  _sh_prstore_number(shr, &locals.t2, 3, &np1);
  _sh_prstore_number(shr, &locals.t2, 4, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L67:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 6);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 36);
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 6, 3);
  if (!(_sh_ljs_is_double(locals.t5))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np3 = locals.t5;
  if (!(_sh_ljs_is_double(locals.t4))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np2 = locals.t4;
  if (!(_sh_ljs_is_double(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np1 = locals.t3;
  if (!(_sh_ljs_is_double(locals.t6))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = locals.t6;
  np4 = _sh_ljs_double(2);
  _sh_prstore_number(shr, &locals.t2, 0, &np4);
  _sh_prstore_number(shr, &locals.t2, 1, &np3);
  _sh_prstore_number(shr, &locals.t2, 2, &np2);
  _sh_prstore_number(shr, &locals.t2, 3, &np1);
  _sh_prstore_number(shr, &locals.t2, 4, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L68:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 6);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 36);
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 6, 3);
  if (!(_sh_ljs_is_double(locals.t5))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np2 = locals.t5;
  if (!(_sh_ljs_is_double(locals.t4))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np1 = locals.t4;
  if (!(_sh_ljs_is_double(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = locals.t3;
  np3 = _sh_ljs_double(1);
  _sh_prstore_number(shr, &locals.t2, 0, &np3);
  _sh_prstore_number(shr, &locals.t2, 1, &np2);
  _sh_prstore_number(shr, &locals.t2, 2, &np1);
  _sh_prstore_number(shr, &locals.t2, 3, &np0);
  np0 = _sh_ljs_double(0);
  _sh_prstore_number(shr, &locals.t2, 4, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L69:
  ;
  np0 = _sh_ljs_bool(true);
  _sh_ljs_store_to_env(shr, locals.t0,np0, 26);
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t2 = _sh_ljs_new_object_with_parent(shr, &locals.t2);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L70:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 5);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 35);
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 5, 3);
  locals.t3 = _sh_ljs_get_global_object(shr);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 59);
  locals.t5 = _sh_ljs_load_from_env(locals.t0, 24);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t1, &locals.t5);
  np0 = _sh_ljs_undefined();
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t4))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np1 = locals.t4;
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[65] /*Number*/, get_read_prop_cache(shUnit) + 60);
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 25);
  locals.t3 = _sh_ljs_right_shift_rjs_inline(shr, &locals.t1, &locals.t3);
  frame[2] = _sh_ljs_bit_and_rjs_inline(shr, &locals.t3, &locals.t5);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_call(shr, frame, 1);
  if (!(_sh_ljs_is_double(locals.t3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = locals.t3;
  np2 = _sh_ljs_double(1);
  _sh_prstore_number(shr, &locals.t2, 0, &np2);
  np2 = _sh_ljs_double(0);
  _sh_prstore_number(shr, &locals.t2, 1, &np2);
  _sh_prstore_number(shr, &locals.t2, 2, &np2);
  _sh_prstore_number(shr, &locals.t2, 3, &np1);
  _sh_prstore_number(shr, &locals.t2, 4, &np0);
  np0 = _sh_ljs_bool(false);
  _sh_prstore_bool(shr, &locals.t2, 5, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L71:
  ;
  if (!(_sh_ljs_is_string(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t3 = locals.t1;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 4);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 34);
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 3, 30);
  _sh_prstore_string(shr, &locals.t2, 0, &locals.t3);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L72:
  ;
  if (!(_sh_ljs_is_bool(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = locals.t1;
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 2);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t2 = _sh_ljs_load_from_env(locals.t0, 32);
  locals.t2 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t2, 3, 24);
  _sh_prstore_bool(shr, &locals.t2, 0, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L73:
  ;
  if (!(_sh_ljs_is_double(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = locals.t1;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 3);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 33);
  locals.t1 = _sh_new_typed_object_with_buffer(shr, shUnit, &locals.t1, 3, 25);
  _sh_prstore_number(shr, &locals.t1, 0, &np0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L74:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 30);
  locals.t1 = _sh_ljs_new_object_with_parent(shr, &locals.t1);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L75:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  locals.t0 = _sh_ljs_load_from_env(locals.t0, 31);
  locals.t0 = _sh_ljs_new_object_with_parent(shr, &locals.t0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:281:1
static SHLegacyValue _10___dehermFromStatic(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
    SHLegacyValue t4;
    SHLegacyValue t5;
    SHLegacyValue t6;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 11);
  locals.head.count =7;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_undefined();
  locals.t5 = _sh_ljs_undefined();
  locals.t6 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();

L0:
  ;
  locals.t1 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  locals.t0 = _sh_ljs_param(frame, 1);
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 3);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L38;
  goto L1;

L1:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 4);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L37;
  goto L2;

L2:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 2);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L36;
  goto L3;

L3:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 1);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L35;
  goto L4;

L4:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L34;
  goto L5;

L5:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 6);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L29;
  goto L6;

L6:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 7);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L26;
  goto L7;

L7:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 5);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L23;
  goto L8;

L8:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 8);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L22;
  goto L9;

L9:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 10);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L19;
  goto L10;

L10:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 11);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L16;
  goto L11;

L11:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 12);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_instance_of_rjs(shr, &locals.t0, &locals.t2);
  if(_sh_ljs_get_bool(np0)) goto L13;
  goto L12;

L12:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[69] /*deherm typed-native ...*/);
  _sh_throw(shr, locals.t2);

L13:
  ;
  locals.t2 = _sh_ljs_load_from_env(locals.t1, 22);
  locals.t3 = _sh_ljs_create_this(shr, &locals.t2, &locals.t2, get_read_prop_cache(shUnit) + 61);
  frame[5] = locals.t2;
  frame[4] = locals.t2;
  frame[3] = locals.t3;
  locals.t2 = _sh_ljs_call(shr, frame, 0);
  locals.t2 = _sh_ljs_is_object(locals.t2) ? locals.t2 : locals.t3;
  locals.t3 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t3);
  np4 = _sh_ljs_double(0);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np0));
  np3 = _sh_ljs_undefined();
  np2 = _sh_ljs_double(1);
  np1 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np0)) goto L14;
  goto L15;

L14:
  ;
  // PhiInst
  locals.t5 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[70] /*set*/, get_read_prop_cache(shUnit) + 62);
  locals.t6 = _sh_ljs_load_from_env(locals.t1, 28);
  locals.t3 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  frame[2] = _sh_fastarray_load(shr, &locals.t3, _sh_ljs_get_double(np1));
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t6;
  frame[3] = _sh_ljs_double(0);
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(1);
  locals.t4 = _10___dehermFromStatic(shr);
  locals.t3 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  frame[2] = _sh_fastarray_load(shr, &locals.t3, _sh_ljs_get_double(np1));
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t6;
  frame[3] = _sh_ljs_double(0);
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(1);
  frame[1] = _10___dehermFromStatic(shr);
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t5;
  frame[3] = locals.t2;
  frame[2] = locals.t4;
  locals.t3 = _sh_ljs_call(shr, frame, 2);
  np1 = _sh_ljs_double(_sh_ljs_get_double(np1) + _sh_ljs_get_double(np2));
  locals.t3 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t3);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) < _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L14;
  goto L15;

L15:
  ;
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L16:
  ;
  locals.t2 = _sh_ljs_new_object(shr);
  locals.t3 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t3);
  np4 = _sh_ljs_double(0);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np0));
  np3 = _sh_ljs_undefined();
  np2 = _sh_ljs_double(1);
  np1 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np0)) goto L17;
  goto L18;

L17:
  ;
  // PhiInst
  locals.t3 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  locals.t4 = _sh_fastarray_load(shr, &locals.t3, _sh_ljs_get_double(np1));
  frame[4] = _sh_ljs_load_from_env(locals.t1, 28);
  locals.t3 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  frame[2] = _sh_fastarray_load(shr, &locals.t3, _sh_ljs_get_double(np1));
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(1);
  locals.t3 = _10___dehermFromStatic(shr);
  _sh_ljs_put_by_val_strict_rjs(shr,&locals.t2, &locals.t4, &locals.t3);
  np1 = _sh_ljs_double(_sh_ljs_get_double(np1) + _sh_ljs_get_double(np2));
  locals.t3 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t3);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) < _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L17;
  goto L18;

L18:
  ;
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L19:
  ;
  locals.t2 = _sh_ljs_get_env(shr, locals.t1, 1);
  locals.t2 = _sh_ljs_load_from_env(locals.t2, 4);
  locals.t2 = _sh_new_fastarray_with_proto(shr, &locals.t2, 0);
  locals.t3 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t3);
  np4 = _sh_ljs_double(0);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np0));
  np3 = _sh_ljs_undefined();
  np2 = _sh_ljs_double(1);
  np1 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np0)) goto L20;
  goto L21;

L20:
  ;
  // PhiInst
  frame[4] = _sh_ljs_load_from_env(locals.t1, 28);
  locals.t3 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  frame[2] = _sh_fastarray_load(shr, &locals.t3, _sh_ljs_get_double(np1));
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(1);
  locals.t3 = _10___dehermFromStatic(shr);
  _sh_fastarray_push(shr, &locals.t3, &locals.t2);
  np1 = _sh_ljs_double(_sh_ljs_get_double(np1) + _sh_ljs_get_double(np2));
  locals.t3 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t3);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) < _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L20;
  goto L21;

L21:
  ;
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L22:
  ;
  locals.t2 = _sh_ljs_new_object(shr);
  np0 = _sh_prload(shr, locals.t0, 0);
  frame[2] = _sh_prload(shr, locals.t0, 1);
  locals.t3 = _sh_ljs_get_global_object(shr);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 63);
  np1 = _sh_ljs_undefined();
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t5 = _sh_ljs_load_from_env(locals.t1, 25);
  locals.t6 = _sh_ljs_left_shift_rjs_inline(shr, &locals.t4, &locals.t5);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 64);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  frame[2] = np0;
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t4 = _sh_ljs_bit_or_rjs_inline(shr, &locals.t6, &locals.t4);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[61] /*socket*/, &locals.t4, get_write_prop_cache(shUnit) + 24);
  np0 = _sh_prload(shr, locals.t0, 2);
  frame[2] = _sh_prload(shr, locals.t0, 3);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 65);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t6 = _sh_ljs_left_shift_rjs_inline(shr, &locals.t4, &locals.t5);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 66);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  frame[2] = np0;
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t4 = _sh_ljs_bit_or_rjs_inline(shr, &locals.t6, &locals.t4);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[62] /*reserved*/, &locals.t4, get_write_prop_cache(shUnit) + 25);
  np0 = _sh_prload(shr, locals.t0, 4);
  frame[2] = _sh_prload(shr, locals.t0, 5);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 67);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t6 = _sh_ljs_left_shift_rjs_inline(shr, &locals.t4, &locals.t5);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 68);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  frame[2] = np0;
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t4 = _sh_ljs_bit_or_rjs_inline(shr, &locals.t6, &locals.t4);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[63] /*path*/, &locals.t4, get_write_prop_cache(shUnit) + 26);
  np0 = _sh_prload(shr, locals.t0, 6);
  frame[2] = _sh_prload(shr, locals.t0, 7);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 69);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t4 = _sh_ljs_left_shift_rjs_inline(shr, &locals.t4, &locals.t5);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t3, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 70);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  frame[2] = np0;
  locals.t3 = _sh_ljs_call(shr, frame, 1);
  locals.t3 = _sh_ljs_bit_or_rjs_inline(shr, &locals.t4, &locals.t3);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[64] /*fragment*/, &locals.t3, get_write_prop_cache(shUnit) + 27);
  np0 = _sh_ljs_bool(true);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t2, get_symbols(shUnit)[57] /*__dehermUrlV1*/, &np0, get_write_prop_cache(shUnit) + 28);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L23:
  ;
  np1 = _sh_prload(shr, locals.t0, 0);
  np0 = _sh_ljs_double(1);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) != _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L25;
  goto L24;

L24:
  ;
  np1 = _sh_prload(shr, locals.t0, 3);
  frame[2] = _sh_prload(shr, locals.t0, 4);
  locals.t2 = _sh_ljs_get_global_object(shr);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t2, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 71);
  np0 = _sh_ljs_undefined();
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_call(shr, frame, 1);
  locals.t3 = _sh_ljs_load_from_env(locals.t1, 25);
  locals.t3 = _sh_ljs_left_shift_rjs_inline(shr, &locals.t4, &locals.t3);
  frame[4] = _sh_ljs_try_get_by_id_rjs(shr,&locals.t2, get_symbols(shUnit)[37] /*BigInt*/, get_read_prop_cache(shUnit) + 72);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_undefined();
  frame[2] = np1;
  locals.t2 = _sh_ljs_call(shr, frame, 1);
  locals.t2 = _sh_ljs_bit_or_rjs_inline(shr, &locals.t3, &locals.t2);
  _sh_leave(shr, &locals.head, frame);
  return locals.t2;

L25:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[71] /*deherm typed-native ...*/);
  _sh_throw(shr, locals.t2);

L26:
  ;
  locals.t1 = _sh_ljs_get_env(shr, locals.t1, 1);
  locals.t1 = _sh_ljs_load_from_env(locals.t1, 1);
  locals.t1 = _sh_new_fastarray_with_proto(shr, &locals.t1, 0);
  np2 = _sh_ljs_double(1);
  np1 = _sh_ljs_double(16);
  np3 = _sh_ljs_double(0);
  goto L27;
L27:
  ;
  // PhiInst
  locals.t2 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_load(shr, &locals.t2, _sh_ljs_get_double(np3));
  _sh_fastarray_push(shr, &np0, &locals.t1);
  np3 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np2));
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np3) < _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np0)) goto L27;
  goto L28;

L28:
  ;
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L29:
  ;
  locals.t1 = _sh_ljs_new_object(shr);
  np0 = _sh_prload(shr, locals.t0, 1);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[23] /*x*/, &np0, get_write_prop_cache(shUnit) + 29);
  np0 = _sh_prload(shr, locals.t0, 2);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[24] /*y*/, &np0, get_write_prop_cache(shUnit) + 30);
  np0 = _sh_prload(shr, locals.t0, 3);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[25] /*z*/, &np0, get_write_prop_cache(shUnit) + 31);
  np1 = _sh_prload(shr, locals.t0, 0);
  np0 = _sh_ljs_double(1);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) == _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L33;
  goto L30;

L30:
  ;
  np0 = _sh_prload(shr, locals.t0, 4);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[26] /*w*/, &np0, get_write_prop_cache(shUnit) + 32);
  np1 = _sh_prload(shr, locals.t0, 0);
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[68] /*quaternion*/);
  np0 = _sh_ljs_double(2);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) == _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L31;
  goto L32;

L31:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[67] /*vector4*/);
  goto L32;
L32:
  ;
  // PhiInst
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[56] /*__dehermValueKind*/, &locals.t2, get_write_prop_cache(shUnit) + 33);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L33:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[66] /*vector3*/);
  _sh_ljs_put_by_id_strict_rjs(shr, shUnit, &locals.t1, get_symbols(shUnit)[56] /*__dehermValueKind*/, &locals.t2, get_write_prop_cache(shUnit) + 34);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L34:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;

L35:
  ;
  np0 = _sh_ljs_null();
  _sh_leave(shr, &locals.head, frame);
  return np0;

L36:
  ;
  np0 = _sh_prload(shr, locals.t0, 0);
  _sh_leave(shr, &locals.head, frame);
  return np0;

L37:
  ;
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L38:
  ;
  np0 = _sh_prload(shr, locals.t0, 0);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:363:1
static SHLegacyValue _11___dehermTypedNativeCall(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
    SHLegacyValue t4;
    SHLegacyValue t5;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 11);
  locals.head.count =6;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_undefined();
  locals.t5 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();
  SHLegacyValue np9 = _sh_ljs_undefined();
  SHLegacyValue np10 = _sh_ljs_undefined();
  SHLegacyValue np11 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  np1 = _sh_ljs_param(frame, 1);
  locals.t2 = _sh_ljs_param(frame, 2);
  locals.t1 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t2,get_symbols(shUnit)[43] /*length*/, get_read_prop_cache(shUnit) + 73);
  if (!(_sh_ljs_is_double(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np5 = locals.t1;
  np0 = _sh_ljs_load_from_env(locals.t0, 17);
  if (!(_sh_ljs_is_double(np0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np5) > _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L22;
  goto L1;

L1:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 16);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_fastarray_length(shr, &locals.t1);
  np6 = _sh_ljs_double(1);
  np9 = _sh_ljs_double(_sh_ljs_get_double(np0) - _sh_ljs_get_double(np6));
  np0 = _sh_ljs_bool(false);
  np2 = _sh_ljs_double(0);
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np2) <= _sh_ljs_get_double(np9));
  np7 = _sh_ljs_double(0);
  np3 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L7;

L2:
  ;
  // PhiInst
  // PhiInst
  np4 = _sh_ljs_double(_sh_ljs_get_double(np7) + _sh_ljs_get_double(np9));
  np4 = _sh_ljs_right_shift_rjs_inline(shr, &np4, &np6);
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 16);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np10 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np4));
  np11 = _sh_ljs_bool(_sh_ljs_get_double(np10) == _sh_ljs_get_double(np1));
  np3 = _sh_ljs_bool(true);
  if(_sh_ljs_get_bool(np11)) goto L7;
  goto L3;

L3:
  ;
  np10 = _sh_ljs_bool(_sh_ljs_get_double(np10) < _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np10)) goto L5;
  goto L4;

L4:
  ;
  np10 = _sh_ljs_double(_sh_ljs_get_double(np4) - _sh_ljs_get_double(np6));
  goto L6;
L5:
  ;
  np7 = _sh_ljs_double(_sh_ljs_get_double(np4) + _sh_ljs_get_double(np6));
  np10 = np9;
  goto L6;
L6:
  ;
  // PhiInst
  // PhiInst
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np7) <= _sh_ljs_get_double(np10));
  np9 = np10;
  np3 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L7;

L7:
  ;
  // PhiInst
  if(_sh_ljs_get_bool(np3)) goto L8;
  goto L22;

L8:
  ;
  _sh_ljs_store_to_env(shr, locals.t0,np0, 26);
  locals.t3 = _sh_ljs_get_env(shr, locals.t0, 1);
  locals.t1 = _sh_ljs_load_from_env(locals.t3, 2);
  locals.t4 = _sh_new_fastarray_with_proto(shr, &locals.t1, 0);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np2) < _sh_ljs_get_double(np5));
  np0 = _sh_ljs_undefined();
  np4 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np3)) goto L9;
  goto L11;

L9:
  ;
  // PhiInst
  frame[4] = _sh_ljs_load_from_env(locals.t0, 27);
  frame[2] = _sh_ljs_get_by_val_rjs(shr,&locals.t2, &np4);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[1] = _sh_ljs_double(0);
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(2);
  locals.t1 = _9___dehermToStatic(shr);
  _sh_fastarray_push(shr, &locals.t1, &locals.t4);
  np3 = _sh_ljs_load_from_env(locals.t0, 26);
  if (!(_sh_ljs_is_bool(np3))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  if(_sh_ljs_get_bool(np3)) goto L18;
  goto L10;

L10:
  ;
  np4 = _sh_ljs_double(_sh_ljs_get_double(np4) + _sh_ljs_get_double(np6));
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np5));
  if(_sh_ljs_get_bool(np3)) goto L9;
  goto L11;

L11:
  ;
  frame[4] = _sh_ljs_load_from_env(locals.t0, 15);
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[2] = np1;
  frame[1] = locals.t4;
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(2);
  locals.t1 = _8_dispatchScriptUniversalValue(shr);
  np5 = _sh_fastarray_length(shr, &locals.t1);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np5) == _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np3)) goto L17;
  goto L12;

L12:
  ;
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np5) == _sh_ljs_get_double(np6));
  if(_sh_ljs_get_bool(np3)) goto L16;
  goto L13;

L13:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t3, 4);
  locals.t3 = _sh_new_fastarray_with_proto(shr, &locals.t3, 0);
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np2) < _sh_ljs_get_double(np5));
  np4 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np3)) goto L14;
  goto L15;

L14:
  ;
  // PhiInst
  frame[4] = _sh_ljs_load_from_env(locals.t0, 28);
  frame[2] = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np4));
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(1);
  locals.t4 = _10___dehermFromStatic(shr);
  _sh_fastarray_push(shr, &locals.t4, &locals.t3);
  np4 = _sh_ljs_double(_sh_ljs_get_double(np4) + _sh_ljs_get_double(np6));
  np3 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np5));
  if(_sh_ljs_get_bool(np3)) goto L14;
  goto L15;

L15:
  ;
  _sh_leave(shr, &locals.head, frame);
  return locals.t3;

L16:
  ;
  frame[4] = _sh_ljs_load_from_env(locals.t0, 28);
  frame[2] = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np2));
  frame[5] = _sh_ljs_undefined();
  frame[3] = _sh_ljs_double(0);
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(1);
  locals.t1 = _10___dehermFromStatic(shr);
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L17:
  ;
  _sh_leave(shr, &locals.head, frame);
  return np0;

L18:
  ;
  locals.t3 = _sh_ljs_load_from_env(locals.t0, 29);
  locals.t1 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t3,get_symbols(shUnit)[41] /*call*/, get_read_prop_cache(shUnit) + 74);
  if (_sh_ljs_get_builtin_closure(shr, 76).raw == locals.t1.raw) goto L20;
else goto L19;

L19:
  ;
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t1;
  frame[3] = locals.t3;
  frame[2] = np1;
  frame[1] = locals.t2;
  locals.t1 = _sh_ljs_call(shr, frame, 2);
  goto L21;
L20:
  ;
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t3;
  frame[3] = np1;
  frame[2] = locals.t2;
  locals.t1 = _sh_ljs_call(shr, frame, 1);
  goto L21;
L21:
  ;
  // PhiInst
  _sh_leave(shr, &locals.head, frame);
  return locals.t1;

L22:
  ;
  locals.t1 = _sh_ljs_load_from_env(locals.t0, 29);
  locals.t0 = _sh_ljs_get_by_id_rjs_inline(shr,&locals.t1,get_symbols(shUnit)[41] /*call*/, get_read_prop_cache(shUnit) + 75);
  if (_sh_ljs_get_builtin_closure(shr, 76).raw == locals.t0.raw) goto L24;
else goto L23;

L23:
  ;
  np0 = _sh_ljs_undefined();
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t0;
  frame[3] = locals.t1;
  frame[2] = np1;
  frame[1] = locals.t2;
  locals.t0 = _sh_ljs_call(shr, frame, 2);
  goto L25;
L24:
  ;
  np0 = _sh_ljs_undefined();
  frame[5] = _sh_ljs_undefined();
  frame[4] = locals.t1;
  frame[3] = np1;
  frame[2] = locals.t2;
  locals.t0 = _sh_ljs_call(shr, frame, 1);
  goto L25;
L25:
  ;
  // PhiInst
  _sh_leave(shr, &locals.head, frame);
  return locals.t0;
}
// none:0,0
static SHLegacyValue _12_DehermStaticValue(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:43:33
static SHLegacyValue _13_encode(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[72] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:43:160
static SHLegacyValue _14_asString(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[73] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:43:232
static SHLegacyValue _15_probeSize(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_double(0);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:43:266
static SHLegacyValue _16_probeChecksum(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_double(0);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _17_DehermStaticUndefined(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:44:63
static SHLegacyValue _18_encode_1_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_undefined(_sh_ljs_get_native_pointer(np0)));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _19_DehermStaticNull(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:45:58
static SHLegacyValue _20_encode_2_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_null(_sh_ljs_get_native_pointer(np0)));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:46:81
static SHLegacyValue _21_DehermStaticBoolean(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  np0 = _sh_ljs_param(frame, 1);
  locals.t0 = frame[-8];
  _sh_prstore_bool(shr, &locals.t0, 0, &np0);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:46:130
static SHLegacyValue _22_encode_3_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np0 = _sh_prload(shr, locals.t0, 0);
  np1 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np0)) goto L1;
  goto L2;

L1:
  ;
  np1 = _sh_ljs_double(1);
  goto L2;
L2:
  ;
  // PhiInst
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_boolean(_sh_ljs_get_native_pointer(np0), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np1))));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:47:79
static SHLegacyValue _23_DehermStaticNumber(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  np0 = _sh_ljs_param(frame, 1);
  locals.t0 = frame[-8];
  _sh_prstore_number(shr, &locals.t0, 0, &np0);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:47:127
static SHLegacyValue _24_encode_4_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np1 = _sh_prload(shr, locals.t0, 0);
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_number(_sh_ljs_get_native_pointer(np0), _sh_ljs_get_double(np1)));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:48:79
static SHLegacyValue _25_DehermStaticString(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =2;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t1 = _sh_ljs_param(frame, 1);
  locals.t0 = frame[-8];
  _sh_prstore_string(shr, &locals.t0, 0, &locals.t1);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:48:127
static SHLegacyValue _26_encode_5_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 11);
  locals.head.count =2;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  frame[4] = _sh_ljs_load_from_env(locals.t0, 13);
  locals.t0 = frame[-8];
  frame[1] = _sh_prload(shr, locals.t0, 0);
  frame[3] = _sh_ljs_double(0);
  np1 = _sh_ljs_undefined();
  frame[2] = _sh_ljs_param(frame, 1);
  frame[5] = _sh_ljs_undefined();
  frame[10] = _sh_ljs_native_pointer(frame);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_pointer((void*)0);
  frame[6] = _sh_ljs_native_uint32(2);
  np0 = _6___writeUtf8(shr);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:48:247
static SHLegacyValue _27_asString_1_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  locals.t0 = _sh_prload(shr, locals.t0, 0);
  _sh_leave(shr, &locals.head, frame);
  return locals.t0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:49:172
static SHLegacyValue _28_DehermStaticHandle(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t0 = frame[-8];
  np0 = _sh_ljs_param(frame, 1);
  _sh_prstore_number(shr, &locals.t0, 0, &np0);
  np0 = _sh_ljs_param(frame, 2);
  _sh_prstore_number(shr, &locals.t0, 1, &np0);
  np0 = _sh_ljs_param(frame, 3);
  _sh_prstore_number(shr, &locals.t0, 2, &np0);
  np0 = _sh_ljs_param(frame, 4);
  _sh_prstore_number(shr, &locals.t0, 3, &np0);
  np0 = _sh_ljs_param(frame, 5);
  _sh_prstore_number(shr, &locals.t0, 4, &np0);
  np0 = _sh_ljs_bool(false);
  _sh_prstore_bool(shr, &locals.t0, 5, &np0);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:49:417
static SHLegacyValue _29_encode_6_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np5 = _sh_prload(shr, locals.t0, 0);
  np4 = _sh_prload(shr, locals.t0, 1);
  np3 = _sh_prload(shr, locals.t0, 2);
  np2 = _sh_prload(shr, locals.t0, 3);
  np1 = _sh_prload(shr, locals.t0, 4);
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_handle(_sh_ljs_get_native_pointer(np0), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np5)), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np4)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np3)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np1))));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:49:606
static SHLegacyValue _30_probeChecksum_1_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np1 = _sh_prload(shr, locals.t0, 3);
  np0 = _sh_prload(shr, locals.t0, 4);
  np0 = _sh_ljs_double(_sh_ljs_get_double(np1) + _sh_ljs_get_double(np0));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:49:665
static SHLegacyValue _31_dispose(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np0 = _sh_prload(shr, locals.t0, 5);
  if(_sh_ljs_get_bool(np0)) goto L2;
  goto L1;

L1:
  ;
  np0 = _sh_ljs_bool(true);
  _sh_prstore_bool(shr, &locals.t0, 5, &np0);
  np3 = _sh_prload(shr, locals.t0, 0);
  np2 = _sh_prload(shr, locals.t0, 2);
  np1 = _sh_prload(shr, locals.t0, 3);
  np0 = _sh_prload(shr, locals.t0, 4);
  deherm_script_static_release_handle((unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np3)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np1)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)));
  np0 = _sh_ljs_undefined();
  goto L2;
L2:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:50:120
static SHLegacyValue _32_DehermStaticDefoldValue(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t0 = frame[-8];
  np0 = _sh_ljs_param(frame, 1);
  _sh_prstore_number(shr, &locals.t0, 0, &np0);
  np0 = _sh_ljs_param(frame, 2);
  _sh_prstore_number(shr, &locals.t0, 1, &np0);
  np0 = _sh_ljs_param(frame, 3);
  _sh_prstore_number(shr, &locals.t0, 2, &np0);
  np0 = _sh_ljs_param(frame, 4);
  _sh_prstore_number(shr, &locals.t0, 3, &np0);
  np0 = _sh_ljs_param(frame, 5);
  _sh_prstore_number(shr, &locals.t0, 4, &np0);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:50:237
static SHLegacyValue _33_encode_7_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np5 = _sh_prload(shr, locals.t0, 0);
  np4 = _sh_prload(shr, locals.t0, 1);
  np3 = _sh_prload(shr, locals.t0, 2);
  np2 = _sh_prload(shr, locals.t0, 3);
  np1 = _sh_prload(shr, locals.t0, 4);
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_defold_value(_sh_ljs_get_native_pointer(np0), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np5)), (float)_sh_ljs_get_double(np4), (float)_sh_ljs_get_double(np3), (float)_sh_ljs_get_double(np2), (float)_sh_ljs_get_double(np1)));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:50:390
static SHLegacyValue _34_probeChecksum_2_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np3 = _sh_prload(shr, locals.t0, 1);
  np0 = _sh_prload(shr, locals.t0, 2);
  np2 = _sh_prload(shr, locals.t0, 3);
  np1 = _sh_prload(shr, locals.t0, 4);
  np0 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np0));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np2));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np1));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:51:90
static SHLegacyValue _35_DehermStaticMatrix4(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =2;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t1 = _sh_ljs_param(frame, 1);
  np1 = _sh_fastarray_length(shr, &locals.t1);
  np0 = _sh_ljs_double(16);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) != _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L2;
  goto L1;

L1:
  ;
  locals.t0 = frame[-8];
  _sh_prstore_object(shr, &locals.t0, 0, &locals.t1);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;

L2:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[51] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:51:254
static SHLegacyValue _36_encode_8_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =2;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();
  SHLegacyValue np9 = _sh_ljs_undefined();
  SHLegacyValue np10 = _sh_ljs_undefined();
  SHLegacyValue np11 = _sh_ljs_undefined();
  SHLegacyValue np12 = _sh_ljs_undefined();
  SHLegacyValue np13 = _sh_ljs_undefined();
  SHLegacyValue np14 = _sh_ljs_undefined();
  SHLegacyValue np15 = _sh_ljs_undefined();
  SHLegacyValue np16 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(0);
  np16 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(1);
  np15 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(2);
  np14 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(3);
  np13 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(4);
  np12 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(5);
  np11 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(6);
  np10 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(7);
  np9 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(8);
  np8 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(9);
  np7 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(10);
  np6 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(11);
  np5 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(12);
  np4 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(13);
  np3 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(14);
  np2 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np0));
  locals.t0 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_empty(shr);
  np0 = _sh_ljs_double(15);
  np1 = _sh_fastarray_load(shr, &locals.t0, _sh_ljs_get_double(np0));
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_matrix4(_sh_ljs_get_native_pointer(np0), (float)_sh_ljs_get_double(np16), (float)_sh_ljs_get_double(np15), (float)_sh_ljs_get_double(np14), (float)_sh_ljs_get_double(np13), (float)_sh_ljs_get_double(np12), (float)_sh_ljs_get_double(np11), (float)_sh_ljs_get_double(np10), (float)_sh_ljs_get_double(np9), (float)_sh_ljs_get_double(np8), (float)_sh_ljs_get_double(np7), (float)_sh_ljs_get_double(np6), (float)_sh_ljs_get_double(np5), (float)_sh_ljs_get_double(np4), (float)_sh_ljs_get_double(np3), (float)_sh_ljs_get_double(np2), (float)_sh_ljs_get_double(np1)));
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np0) == _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L2;
  goto L1;

L1:
  ;
  _sh_leave(shr, &locals.head, frame);
  return np0;

L2:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[74] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:51:735
static SHLegacyValue _37_probeSize_1_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_double(16);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:51:770
static SHLegacyValue _38_probeChecksum_3_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =2;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np3 = _sh_ljs_double(0);
  np5 = _sh_ljs_double(1);
  np4 = _sh_ljs_double(16);
  np2 = _sh_ljs_double(0);
  goto L1;
L1:
  ;
  // PhiInst
  // PhiInst
  locals.t1 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t1))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_load(shr, &locals.t1, _sh_ljs_get_double(np3));
  np3 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np5));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) * _sh_ljs_get_double(np3));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np2) + _sh_ljs_get_double(np0));
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np3) < _sh_ljs_get_double(np4));
  np2 = np0;
  if(_sh_ljs_get_bool(np1)) goto L1;
  goto L2;

L2:
  ;
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:52:214
static SHLegacyValue _39_DehermStaticUrl(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t0 = frame[-8];
  np0 = _sh_ljs_param(frame, 1);
  _sh_prstore_number(shr, &locals.t0, 0, &np0);
  np0 = _sh_ljs_param(frame, 2);
  _sh_prstore_number(shr, &locals.t0, 1, &np0);
  np0 = _sh_ljs_param(frame, 3);
  _sh_prstore_number(shr, &locals.t0, 2, &np0);
  np0 = _sh_ljs_param(frame, 4);
  _sh_prstore_number(shr, &locals.t0, 3, &np0);
  np0 = _sh_ljs_param(frame, 5);
  _sh_prstore_number(shr, &locals.t0, 4, &np0);
  np0 = _sh_ljs_param(frame, 6);
  _sh_prstore_number(shr, &locals.t0, 5, &np0);
  np0 = _sh_ljs_param(frame, 7);
  _sh_prstore_number(shr, &locals.t0, 6, &np0);
  np0 = _sh_ljs_param(frame, 8);
  _sh_prstore_number(shr, &locals.t0, 7, &np0);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:52:592
static SHLegacyValue _40_encode_9_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np8 = _sh_prload(shr, locals.t0, 0);
  np7 = _sh_prload(shr, locals.t0, 1);
  np6 = _sh_prload(shr, locals.t0, 2);
  np5 = _sh_prload(shr, locals.t0, 3);
  np4 = _sh_prload(shr, locals.t0, 4);
  np3 = _sh_prload(shr, locals.t0, 5);
  np2 = _sh_prload(shr, locals.t0, 6);
  np1 = _sh_prload(shr, locals.t0, 7);
  np0 = _sh_ljs_param(frame, 1);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_url(_sh_ljs_get_native_pointer(np0), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np8)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np7)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np6)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np5)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np4)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np3)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np1))));
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np0) == _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L2;
  goto L1;

L1:
  ;
  _sh_leave(shr, &locals.head, frame);
  return np0;

L2:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[75] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:52:915
static SHLegacyValue _41_probeSize_2_(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_double(4);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:52:949
static SHLegacyValue _42_probeChecksum_4_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  np7 = _sh_prload(shr, locals.t0, 0);
  np0 = _sh_prload(shr, locals.t0, 1);
  np6 = _sh_prload(shr, locals.t0, 2);
  np5 = _sh_prload(shr, locals.t0, 3);
  np4 = _sh_prload(shr, locals.t0, 4);
  np3 = _sh_prload(shr, locals.t0, 5);
  np2 = _sh_prload(shr, locals.t0, 6);
  np1 = _sh_prload(shr, locals.t0, 7);
  np0 = _sh_ljs_double(_sh_ljs_get_double(np7) + _sh_ljs_get_double(np0));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np6));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np5));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np4));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np3));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np2));
  np0 = _sh_ljs_double(_sh_ljs_get_double(np0) + _sh_ljs_get_double(np1));
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// none:0,0
static SHLegacyValue _43_DehermStaticContainer(SHRuntime *shr) {
  struct {
    SHLocals head;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =0;
  SHUnit *shUnit = shr->units[unit_index];
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:53:62
static SHLegacyValue _44_begin(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =3;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();

L0:
  ;
  np1 = _sh_ljs_double(8);
  np0 = _sh_ljs_param(frame, 3);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np0) > _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np0)) goto L9;
  goto L1;

L1:
  ;
  locals.t1 = frame[-8];
  locals.t0 = _sh_ljs_param(frame, 2);
  np0 = _sh_fastarray_length(shr, &locals.t0);
  np4 = _sh_ljs_double(0);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np0));
  np3 = _sh_ljs_double(1);
  np4 = _sh_ljs_double(0);
  np0 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np1)) goto L2;
  goto L4;

L2:
  ;
  // PhiInst
  locals.t2 = _sh_fastarray_load(shr, &locals.t0, _sh_ljs_get_double(np4));
  np1 = _sh_ljs_bool(locals.t2.raw == locals.t1.raw);
  np0 = _sh_ljs_bool(true);
  if(_sh_ljs_get_bool(np1)) goto L4;
  goto L3;

L3:
  ;
  np4 = _sh_ljs_double(_sh_ljs_get_double(np4) + _sh_ljs_get_double(np3));
  np1 = _sh_fastarray_length(shr, &locals.t0);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np4) < _sh_ljs_get_double(np1));
  np0 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np1)) goto L2;
  goto L4;

L4:
  ;
  // PhiInst
  if(_sh_ljs_get_bool(np0)) goto L8;
  goto L5;

L5:
  ;
  np2 = _sh_ljs_param(frame, 1);
  np1 = _sh_ljs_param(frame, 4);
  np0 = _sh_ljs_param(frame, 5);
  _sh_fastarray_push(shr, &locals.t1, &locals.t0);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_table(_sh_ljs_get_native_pointer(np2), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np1)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np1 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np0) == _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L7;
  goto L6;

L6:
  ;
  _sh_leave(shr, &locals.head, frame);
  return np0;

L7:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[76] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L8:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[77] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L9:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[78] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:53:460
static SHLegacyValue _45_end(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 11);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  frame[1] = _sh_ljs_double(1);
  frame[2] = _sh_ljs_param(frame, 1);
  // ImplicitMovInst
  // ImplicitMovInst
  // ImplicitMovInst
  locals.t0 = _sh_ljs_call_builtin(shr, frame, 2, 77);
  if (!(_sh_ljs_is_undefined(locals.t0) || _sh_ljs_is_object(locals.t0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:54:101
static SHLegacyValue _46_DehermStaticArray(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =2;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t0 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  locals.t0 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t0, 128));
  if(_sh_ljs_get_bool(np0)) goto L2;
  goto L1;

L1:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t0);

L2:
  ;
  locals.t1 = frame[-8];
  locals.t0 = _sh_ljs_param(frame, 1);
  _sh_prstore_object(shr, &locals.t1, 0, &locals.t0);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:54:170
static SHLegacyValue _47_encode_10_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 12);
  locals.head.count =4;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();

L0:
  ;
  locals.t1 = frame[-8];
  np3 = _sh_ljs_param(frame, 3);
  locals.t0 = _sh_prload(shr, locals.t1, 0);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t0);
  np1 = _sh_ljs_double(8);
  np1 = _sh_ljs_bool(_sh_ljs_get_double(np3) > _sh_ljs_get_double(np1));
  if(_sh_ljs_get_bool(np1)) goto L13;
  goto L1;

L1:
  ;
  locals.t0 = _sh_ljs_param(frame, 2);
  np1 = _sh_fastarray_length(shr, &locals.t0);
  np6 = _sh_ljs_double(0);
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np6) < _sh_ljs_get_double(np1));
  np1 = _sh_ljs_double(1);
  np5 = _sh_ljs_double(0);
  np2 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L4;

L2:
  ;
  // PhiInst
  locals.t2 = _sh_fastarray_load(shr, &locals.t0, _sh_ljs_get_double(np5));
  np4 = _sh_ljs_bool(locals.t2.raw == locals.t1.raw);
  np2 = _sh_ljs_bool(true);
  if(_sh_ljs_get_bool(np4)) goto L4;
  goto L3;

L3:
  ;
  np5 = _sh_ljs_double(_sh_ljs_get_double(np5) + _sh_ljs_get_double(np1));
  np4 = _sh_fastarray_length(shr, &locals.t0);
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np5) < _sh_ljs_get_double(np4));
  np2 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L4;

L4:
  ;
  // PhiInst
  if(_sh_ljs_get_bool(np2)) goto L12;
  goto L5;

L5:
  ;
  np5 = _sh_ljs_param(frame, 1);
  _sh_fastarray_push(shr, &locals.t1, &locals.t0);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_table(_sh_ljs_get_native_pointer(np5), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np1)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0))));
  np2 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np0) == _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np2)) goto L11;
  goto L6;

L6:
  ;
  locals.t2 = _sh_prload(shr, locals.t1, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t2);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np6) < _sh_ljs_get_double(np2));
  np4 = _sh_ljs_undefined();
  np3 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np1));
  np6 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np2)) goto L7;
  goto L10;

L7:
  ;
  // PhiInst
  np7 = _sh_ljs_double(_sh_ljs_get_double(np6) + _sh_ljs_get_double(np1));
  np8 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_number(_sh_ljs_get_native_pointer(np5), _sh_ljs_get_double(np7)));
  locals.t2 = _sh_prload(shr, locals.t1, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  locals.t3 = _sh_fastarray_load(shr, &locals.t2, _sh_ljs_get_double(np6));
  locals.t2 = _sh_typed_load_parent(shr, &locals.t3);
  frame[5] = _sh_prload(shr, locals.t2, 0);
  frame[6] = _sh_ljs_undefined();
  frame[4] = locals.t3;
  frame[3] = np5;
  frame[2] = locals.t0;
  frame[1] = np3;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  np2 = ((SHNativeJSFunction *)_sh_ljs_get_pointer(frame[5]))->functionPtr(shr);
  np2 = _sh_ljs_double((double)(unsigned char)deherm_script_static_set_entry(_sh_ljs_get_native_pointer(np5), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np6)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np8)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2))));
  if(_sh_ljs_to_boolean(np2)) goto L9;
  goto L8;

L8:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[79] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t2);

L9:
  ;
  locals.t2 = _sh_prload(shr, locals.t1, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t2);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np7) < _sh_ljs_get_double(np2));
  np6 = np7;
  if(_sh_ljs_get_bool(np2)) goto L7;
  goto L10;

L10:
  ;
  // ImplicitMovInst
  // ImplicitMovInst
  // ImplicitMovInst
  frame[3] = locals.t0;
  frame[2] = _sh_ljs_double(1);
  locals.t0 = _sh_ljs_call_builtin(shr, frame, 2, 77);
  if (!(_sh_ljs_is_undefined(locals.t0) || _sh_ljs_is_object(locals.t0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  _sh_leave(shr, &locals.head, frame);
  return np0;

L11:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[76] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L12:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[77] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L13:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[78] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:54:541
static SHLegacyValue _48_probeSize_3_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  locals.t0 = _sh_prload(shr, locals.t0, 0);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t0);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:55:122
static SHLegacyValue _49_DehermStaticRecord(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =3;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t0 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  locals.t0 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t0, 128));
  if(_sh_ljs_get_bool(np0)) goto L2;
  goto L1;

L1:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t0);

L2:
  ;
  locals.t2 = _sh_ljs_param(frame, 1);
  locals.t1 = _sh_ljs_param(frame, 2);
  np1 = _sh_fastarray_length(shr, &locals.t2);
  np0 = _sh_fastarray_length(shr, &locals.t1);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) != _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L4;
  goto L3;

L3:
  ;
  locals.t0 = frame[-8];
  _sh_prstore_object(shr, &locals.t0, 0, &locals.t2);
  _sh_prstore_object(shr, &locals.t0, 1, &locals.t1);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;

L4:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[49] /*deherm record key/va...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:55:304
static SHLegacyValue _50_encode_11_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
    SHLegacyValue t4;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 12);
  locals.head.count =5;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  locals.t4 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();

L0:
  ;
  locals.t2 = frame[-8];
  locals.t1 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  np3 = _sh_ljs_param(frame, 3);
  locals.t0 = _sh_prload(shr, locals.t2, 1);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t0);
  np0 = _sh_ljs_double(8);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np3) > _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L13;
  goto L1;

L1:
  ;
  locals.t0 = _sh_ljs_param(frame, 2);
  np0 = _sh_fastarray_length(shr, &locals.t0);
  np7 = _sh_ljs_double(0);
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np7) < _sh_ljs_get_double(np0));
  np1 = _sh_ljs_double(1);
  np5 = _sh_ljs_double(0);
  np0 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L4;

L2:
  ;
  // PhiInst
  locals.t3 = _sh_fastarray_load(shr, &locals.t0, _sh_ljs_get_double(np5));
  np4 = _sh_ljs_bool(locals.t3.raw == locals.t2.raw);
  np0 = _sh_ljs_bool(true);
  if(_sh_ljs_get_bool(np4)) goto L4;
  goto L3;

L3:
  ;
  np5 = _sh_ljs_double(_sh_ljs_get_double(np5) + _sh_ljs_get_double(np1));
  np4 = _sh_fastarray_length(shr, &locals.t0);
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np5) < _sh_ljs_get_double(np4));
  np0 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L4;

L4:
  ;
  // PhiInst
  if(_sh_ljs_get_bool(np0)) goto L12;
  goto L5;

L5:
  ;
  np6 = _sh_ljs_param(frame, 1);
  _sh_fastarray_push(shr, &locals.t2, &locals.t0);
  np0 = _sh_ljs_double(2);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_table(_sh_ljs_get_native_pointer(np6), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2))));
  np2 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np0) == _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np2)) goto L11;
  goto L6;

L6:
  ;
  locals.t3 = _sh_prload(shr, locals.t2, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t3);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np7) < _sh_ljs_get_double(np2));
  np5 = _sh_ljs_undefined();
  np4 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np1));
  np3 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np2)) goto L7;
  goto L10;

L7:
  ;
  // PhiInst
  frame[5] = _sh_ljs_load_from_env(locals.t1, 13);
  locals.t3 = _sh_prload(shr, locals.t2, 0);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  frame[2] = _sh_fastarray_load(shr, &locals.t3, _sh_ljs_get_double(np3));
  frame[6] = _sh_ljs_undefined();
  frame[4] = _sh_ljs_double(0);
  frame[3] = np6;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(2);
  np8 = _6___writeUtf8(shr);
  locals.t3 = _sh_prload(shr, locals.t2, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  locals.t4 = _sh_fastarray_load(shr, &locals.t3, _sh_ljs_get_double(np3));
  locals.t3 = _sh_typed_load_parent(shr, &locals.t4);
  frame[5] = _sh_prload(shr, locals.t3, 0);
  frame[6] = _sh_ljs_undefined();
  frame[4] = locals.t4;
  frame[3] = np6;
  frame[2] = locals.t0;
  frame[1] = np4;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  np2 = ((SHNativeJSFunction *)_sh_ljs_get_pointer(frame[5]))->functionPtr(shr);
  np2 = _sh_ljs_double((double)(unsigned char)deherm_script_static_set_entry(_sh_ljs_get_native_pointer(np6), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np3)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np8)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2))));
  if(_sh_ljs_to_boolean(np2)) goto L9;
  goto L8;

L8:
  ;
  locals.t3 = _sh_ljs_get_string(shr, get_symbols(shUnit)[79] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t3);

L9:
  ;
  np3 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np1));
  locals.t3 = _sh_prload(shr, locals.t2, 1);
  if (!(_sh_ljs_is_object(locals.t3))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t3);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np3) < _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np2)) goto L7;
  goto L10;

L10:
  ;
  // ImplicitMovInst
  // ImplicitMovInst
  // ImplicitMovInst
  frame[3] = locals.t0;
  frame[2] = _sh_ljs_double(1);
  locals.t0 = _sh_ljs_call_builtin(shr, frame, 2, 77);
  if (!(_sh_ljs_is_undefined(locals.t0) || _sh_ljs_is_object(locals.t0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  _sh_leave(shr, &locals.head, frame);
  return np0;

L11:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[76] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L12:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[77] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L13:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[78] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:55:683
static SHLegacyValue _51_probeSize_4_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  locals.t0 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t0);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:56:130
static SHLegacyValue _52_DehermStaticMap(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =3;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  if (_sh_ljs_is_undefined(frame[-6]))
    _sh_throw_type_error_ascii(shr, "Class constructor invoked without new");

L0:
  ;
  locals.t0 = _sh_ljs_get_env_from_closure(shr, frame[-7]);  locals.t0 = _sh_ljs_load_from_env(locals.t0, 9);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  np0 = _sh_ljs_bool(_sh_ljs_typeof_is(locals.t0, 128));
  if(_sh_ljs_get_bool(np0)) goto L2;
  goto L1;

L1:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[47] /*Trying to call a non...*/);
  _sh_throw_type_error(shr, &locals.t0);

L2:
  ;
  locals.t2 = _sh_ljs_param(frame, 1);
  locals.t1 = _sh_ljs_param(frame, 2);
  np1 = _sh_fastarray_length(shr, &locals.t2);
  np0 = _sh_fastarray_length(shr, &locals.t1);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np1) != _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L4;
  goto L3;

L3:
  ;
  locals.t0 = frame[-8];
  _sh_prstore_object(shr, &locals.t0, 0, &locals.t2);
  _sh_prstore_object(shr, &locals.t0, 1, &locals.t1);
  np0 = _sh_ljs_undefined();
  _sh_leave(shr, &locals.head, frame);
  return np0;

L4:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[48] /*deherm map key/value...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:56:320
static SHLegacyValue _53_encode_12_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
    SHLegacyValue t1;
    SHLegacyValue t2;
    SHLegacyValue t3;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 12);
  locals.head.count =4;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  locals.t1 = _sh_ljs_undefined();
  locals.t2 = _sh_ljs_undefined();
  locals.t3 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();
  SHLegacyValue np1 = _sh_ljs_undefined();
  SHLegacyValue np2 = _sh_ljs_undefined();
  SHLegacyValue np3 = _sh_ljs_undefined();
  SHLegacyValue np4 = _sh_ljs_undefined();
  SHLegacyValue np5 = _sh_ljs_undefined();
  SHLegacyValue np6 = _sh_ljs_undefined();
  SHLegacyValue np7 = _sh_ljs_undefined();
  SHLegacyValue np8 = _sh_ljs_undefined();

L0:
  ;
  locals.t1 = frame[-8];
  np3 = _sh_ljs_param(frame, 3);
  locals.t0 = _sh_prload(shr, locals.t1, 1);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t0);
  np0 = _sh_ljs_double(8);
  np0 = _sh_ljs_bool(_sh_ljs_get_double(np3) > _sh_ljs_get_double(np0));
  if(_sh_ljs_get_bool(np0)) goto L13;
  goto L1;

L1:
  ;
  locals.t0 = _sh_ljs_param(frame, 2);
  np0 = _sh_fastarray_length(shr, &locals.t0);
  np6 = _sh_ljs_double(0);
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np6) < _sh_ljs_get_double(np0));
  np1 = _sh_ljs_double(1);
  np5 = _sh_ljs_double(0);
  np0 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L4;

L2:
  ;
  // PhiInst
  locals.t2 = _sh_fastarray_load(shr, &locals.t0, _sh_ljs_get_double(np5));
  np4 = _sh_ljs_bool(locals.t2.raw == locals.t1.raw);
  np0 = _sh_ljs_bool(true);
  if(_sh_ljs_get_bool(np4)) goto L4;
  goto L3;

L3:
  ;
  np5 = _sh_ljs_double(_sh_ljs_get_double(np5) + _sh_ljs_get_double(np1));
  np4 = _sh_fastarray_length(shr, &locals.t0);
  np4 = _sh_ljs_bool(_sh_ljs_get_double(np5) < _sh_ljs_get_double(np4));
  np0 = _sh_ljs_bool(false);
  if(_sh_ljs_get_bool(np4)) goto L2;
  goto L4;

L4:
  ;
  // PhiInst
  if(_sh_ljs_get_bool(np0)) goto L12;
  goto L5;

L5:
  ;
  np5 = _sh_ljs_param(frame, 1);
  _sh_fastarray_push(shr, &locals.t1, &locals.t0);
  np0 = _sh_ljs_double(3);
  np0 = _sh_ljs_double((double)(unsigned int)deherm_script_static_push_table(_sh_ljs_get_native_pointer(np5), (unsigned char)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2))));
  np2 = _sh_ljs_double(((struct HermesValueBase){.raw = 4751297606873776128u}).f64);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np0) == _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np2)) goto L11;
  goto L6;

L6:
  ;
  locals.t2 = _sh_prload(shr, locals.t1, 1);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t2);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np6) < _sh_ljs_get_double(np2));
  np4 = _sh_ljs_double(_sh_ljs_get_double(np3) + _sh_ljs_get_double(np1));
  np3 = _sh_ljs_undefined();
  np6 = _sh_ljs_double(0);
  if(_sh_ljs_get_bool(np2)) goto L7;
  goto L10;

L7:
  ;
  // PhiInst
  locals.t2 = _sh_prload(shr, locals.t1, 0);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  locals.t3 = _sh_fastarray_load(shr, &locals.t2, _sh_ljs_get_double(np6));
  locals.t2 = _sh_typed_load_parent(shr, &locals.t3);
  frame[5] = _sh_prload(shr, locals.t2, 0);
  frame[6] = _sh_ljs_undefined();
  frame[4] = locals.t3;
  frame[3] = np5;
  frame[2] = locals.t0;
  frame[1] = np4;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  np7 = ((SHNativeJSFunction *)_sh_ljs_get_pointer(frame[5]))->functionPtr(shr);
  locals.t2 = _sh_prload(shr, locals.t1, 1);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  locals.t3 = _sh_fastarray_load(shr, &locals.t2, _sh_ljs_get_double(np6));
  locals.t2 = _sh_typed_load_parent(shr, &locals.t3);
  frame[5] = _sh_prload(shr, locals.t2, 0);
  frame[6] = _sh_ljs_undefined();
  frame[4] = locals.t3;
  frame[3] = np5;
  frame[2] = locals.t0;
  frame[1] = np4;
  frame[11] = _sh_ljs_native_pointer(frame);
  frame[10] = _sh_ljs_native_pointer((void*)0);
  frame[9] = _sh_ljs_native_pointer((void*)0);
  frame[8] = _sh_ljs_native_pointer((void*)0);
  frame[7] = _sh_ljs_native_uint32(3);
  np2 = ((SHNativeJSFunction *)_sh_ljs_get_pointer(frame[5]))->functionPtr(shr);
  np2 = _sh_ljs_double((double)(unsigned char)deherm_script_static_set_entry(_sh_ljs_get_native_pointer(np5), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np0)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np6)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np7)), (unsigned int)_sh_to_int32_double(_sh_ljs_get_double(np2))));
  if(_sh_ljs_to_boolean(np2)) goto L9;
  goto L8;

L8:
  ;
  locals.t2 = _sh_ljs_get_string(shr, get_symbols(shUnit)[79] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t2);

L9:
  ;
  np6 = _sh_ljs_double(_sh_ljs_get_double(np6) + _sh_ljs_get_double(np1));
  locals.t2 = _sh_prload(shr, locals.t1, 1);
  if (!(_sh_ljs_is_object(locals.t2))) _sh_throw_empty(shr);
  np2 = _sh_fastarray_length(shr, &locals.t2);
  np2 = _sh_ljs_bool(_sh_ljs_get_double(np6) < _sh_ljs_get_double(np2));
  if(_sh_ljs_get_bool(np2)) goto L7;
  goto L10;

L10:
  ;
  // ImplicitMovInst
  // ImplicitMovInst
  // ImplicitMovInst
  frame[3] = locals.t0;
  frame[2] = _sh_ljs_double(1);
  locals.t0 = _sh_ljs_call_builtin(shr, frame, 2, 77);
  if (!(_sh_ljs_is_undefined(locals.t0) || _sh_ljs_is_object(locals.t0))) _sh_throw_type_error_ascii(shr, "Checked cast failed");
  _sh_leave(shr, &locals.head, frame);
  return np0;

L11:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[76] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L12:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[77] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);

L13:
  ;
  locals.t0 = _sh_ljs_get_string(shr, get_symbols(shUnit)[78] /*deherm Static Hermes...*/);
  _sh_throw(shr, locals.t0);
}
// .deherm/build/generated/typed-native/deherm_typed_native.ts:56:712
static SHLegacyValue _54_probeSize_5_(SHRuntime *shr) {
  struct {
    SHLocals head;
    SHLegacyValue t0;
  } locals;
  _sh_check_native_stack_overflow(shr);
  SHLegacyValue *frame = _sh_enter(shr, &locals.head, 1);
  locals.head.count =1;
  SHUnit *shUnit = shr->units[unit_index];
  locals.t0 = _sh_ljs_undefined();
  SHLegacyValue np0 = _sh_ljs_undefined();

L0:
  ;
  locals.t0 = frame[-8];
  locals.t0 = _sh_prload(shr, locals.t0, 1);
  if (!(_sh_ljs_is_object(locals.t0))) _sh_throw_empty(shr);
  np0 = _sh_fastarray_length(shr, &locals.t0);
  _sh_leave(shr, &locals.head, frame);
  return np0;
}
static unsigned char s_literal_val_buffer[68] = {4,5,6,117,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,33,113,0,0,0,0,81,8,0,120,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,98,97,};
static unsigned char s_obj_key_buffer[88] = {84,0,0,1,0,2,0,3,0,85,0,0,1,0,2,0,3,0,4,0,86,0,0,1,0,2,0,3,0,5,0,6,0,81,7,0,88,9,0,10,0,11,0,12,0,13,0,14,0,15,0,16,0,86,17,0,18,0,19,0,20,0,21,0,22,0,85,17,0,23,0,24,0,25,0,26,0,82,27,0,28,0,81,28,0,81,29,0,};
static const SHShapeTableEntry s_obj_shape_table[] = {
  { .key_buffer_offset = 0, .num_props = 4 },
  { .key_buffer_offset = 9, .num_props = 5 },
  { .key_buffer_offset = 20, .num_props = 6 },
  { .key_buffer_offset = 33, .num_props = 1 },
  { .key_buffer_offset = 36, .num_props = 8 },
  { .key_buffer_offset = 53, .num_props = 6 },
  { .key_buffer_offset = 66, .num_props = 5 },
  { .key_buffer_offset = 77, .num_props = 2 },
  { .key_buffer_offset = 82, .num_props = 1 },
  { .key_buffer_offset = 85, .num_props = 1 },
};


static const char s_ascii_pool[] = {
  'e', 'n', 'c', 'o', 'd', 'e', '\0',
  'a', 's', 'S', 't', 'r', 'i', 'n', 'g', '\0',
  'p', 'r', 'o', 'b', 'e', 'S', 'i', 'z', 'e', '\0',
  'p', 'r', 'o', 'b', 'e', 'C', 'h', 'e', 'c', 'k', 's', 'u', 'm', '\0',
  'd', 'i', 's', 'p', 'o', 's', 'e', '\0',
  'b', 'e', 'g', 'i', 'n', '\0',
  'e', 'n', 'd', '\0',
  'v', 'a', 'l', 'u', 'e', '\0',
  '\0',
  's', 'o', 'c', 'k', 'e', 't', 'L', 'o', 'w', '\0',
  's', 'o', 'c', 'k', 'e', 't', 'H', 'i', 'g', 'h', '\0',
  'r', 'e', 's', 'e', 'r', 'v', 'e', 'd', 'L', 'o', 'w', '\0',
  'r', 'e', 's', 'e', 'r', 'v', 'e', 'd', 'H', 'i', 'g', 'h', '\0',
  'p', 'a', 't', 'h', 'L', 'o', 'w', '\0',
  'p', 'a', 't', 'h', 'H', 'i', 'g', 'h', '\0',
  'f', 'r', 'a', 'g', 'm', 'e', 'n', 't', 'L', 'o', 'w', '\0',
  'f', 'r', 'a', 'g', 'm', 'e', 'n', 't', 'H', 'i', 'g', 'h', '\0',
  'k', 'i', 'n', 'd', '\0',
  's', 'e', 'm', 'a', 'n', 't', 'i', 'c', 'K', 'i', 'n', 'd', '\0',
  'r', 'u', 'n', 't', 'i', 'm', 'e', '\0',
  'p', 'a', 'y', 'l', 'o', 'a', 'd', 'L', 'o', 'w', '\0',
  'p', 'a', 'y', 'l', 'o', 'a', 'd', 'H', 'i', 'g', 'h', '\0',
  'r', 'e', 'l', 'e', 'a', 's', 'e', 'd', '\0',
  'x', '\0',
  'y', '\0',
  'z', '\0',
  'w', '\0',
  'k', 'e', 'y', 's', '\0',
  'v', 'a', 'l', 'u', 'e', 's', '\0',
  'e', 'l', 'e', 'm', 'e', 'n', 't', 's', '\0',
  'p', 'r', 'o', 't', 'o', 't', 'y', 'p', 'e', '\0',
  'g', 'l', 'o', 'b', 'a', 'l', 'T', 'h', 'i', 's', '\0',
  'A', 'r', 'r', 'a', 'y', '\0',
  'i', 's', 'A', 'r', 'r', 'a', 'y', '\0',
  'O', 'b', 'j', 'e', 'c', 't', '\0',
  'g', 'e', 't', 'P', 'r', 'o', 't', 'o', 't', 'y', 'p', 'e', 'O', 'f', '\0',
  'M', 'a', 'p', '\0',
  'B', 'i', 'g', 'I', 'n', 't', '\0',
  '_', '_', 'd', 'e', 'f', 'o', 'l', 'd', 'S', 'c', 'r', 'i', 'p', 't', 'B', 'r', 'i', 'd', 'g', 'e', 'V', '1', '\0',
  't', 'a', 'r', 'g', 'e', 't', '\0',
  'g', 'e', 't', '\0',
  'c', 'a', 'l', 'l', '\0',
  '_', '_', 'd', 'e', 'h', 'e', 'r', 'm', 'T', 'y', 'p', 'e', 'd', 'N', 'a', 't', 'i', 'v', 'e', 'R', 'o', 'u', 't', 'e', 'C', 'o', 'u', 'n', 't', '\0',
  'l', 'e', 'n', 'g', 't', 'h', '\0',
  'S', 't', 'r', 'i', 'n', 'g', '\0',
  'c', 'h', 'a', 'r', 'C', 'o', 'd', 'e', 'A', 't', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 's', 't', 'r', 'i', 'n', 'g', ' ', 'a', 'r', 'e', 'n', 'a', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'T', 'r', 'y', 'i', 'n', 'g', ' ', 't', 'o', ' ', 'c', 'a', 'l', 'l', ' ', 'a', ' ', 'n', 'o', 'n', '-', 'f', 'u', 'n', 'c', 't', 'i', 'o', 'n', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'm', 'a', 'p', ' ', 'k', 'e', 'y', '/', 'v', 'a', 'l', 'u', 'e', ' ', 'l', 'e', 'n', 'g', 't', 'h', ' ', 'm', 'i', 's', 'm', 'a', 't', 'c', 'h', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'r', 'e', 'c', 'o', 'r', 'd', ' ', 'k', 'e', 'y', '/', 'v', 'a', 'l', 'u', 'e', ' ', 'l', 'e', 'n', 'g', 't', 'h', ' ', 'm', 'i', 's', 'm', 'a', 't', 'c', 'h', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'r', 'e', 's', 'u', 'l', 't', ' ', 't', 'a', 'g', ' ', 'u', 'n', 's', 'u', 'p', 'p', 'o', 'r', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'M', 'a', 't', 'r', 'i', 'x', '4', ' ', 'n', 'e', 'e', 'd', 's', ' ', '1', '6', ' ', 'c', 'o', 'l', 'u', 'm', 'n', '-', 'm', 'a', 'j', 'o', 'r', ' ', 'f', 'l', 'o', 'a', 't', '3', '2', ' ', 'e', 'l', 'e', 'm', 'e', 'n', 't', 's', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'r', 'e', 's', 'u', 'l', 't', ' ', 'd', 'e', 'p', 't', 'h', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'r', 'e', 'e', 'n', 't', 'r', 'a', 'n', 'c', 'y', ' ', 'd', 'e', 'p', 't', 'h', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'i', 'n', 'p', 'u', 't', ' ', 'a', 'r', 'e', 'n', 'a', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'a', 'r', 'g', 'u', 'm', 'e', 'n', 't', ' ', 'b', 'o', 'u', 'n', 'd', ' ', 'e', 'x', 'c', 'e', 'e', 'd', 'e', 'd', '\0',
  '_', '_', 'd', 'e', 'h', 'e', 'r', 'm', 'V', 'a', 'l', 'u', 'e', 'K', 'i', 'n', 'd', '\0',
  '_', '_', 'd', 'e', 'h', 'e', 'r', 'm', 'U', 'r', 'l', 'V', '1', '\0',
  'e', 'n', 't', 'r', 'i', 'e', 's', '\0',
  'n', 'e', 'x', 't', '\0',
  'd', 'o', 'n', 'e', '\0',
  's', 'o', 'c', 'k', 'e', 't', '\0',
  'r', 'e', 's', 'e', 'r', 'v', 'e', 'd', '\0',
  'p', 'a', 't', 'h', '\0',
  'f', 'r', 'a', 'g', 'm', 'e', 'n', 't', '\0',
  'N', 'u', 'm', 'b', 'e', 'r', '\0',
  'v', 'e', 'c', 't', 'o', 'r', '3', '\0',
  'v', 'e', 'c', 't', 'o', 'r', '4', '\0',
  'q', 'u', 'a', 't', 'e', 'r', 'n', 'i', 'o', 'n', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 't', 'y', 'p', 'e', 'd', '-', 'n', 'a', 't', 'i', 'v', 'e', ' ', 'r', 'o', 'u', 't', 'e', ' ', 'r', 'e', 't', 'u', 'r', 'n', 'e', 'd', ' ', 'a', ' ', 'v', 'a', 'l', 'u', 'e', ' ', 's', 'h', 'a', 'p', 'e', ' ', 't', 'h', 'i', 's', ' ', 't', 'r', 'a', 'n', 's', 'p', 'o', 'r', 't', ' ', 'c', 'a', 'n', 'n', 'o', 't', ' ', 'd', 'e', 'c', 'o', 'd', 'e', '\0',
  's', 'e', 't', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 't', 'y', 'p', 'e', 'd', '-', 'n', 'a', 't', 'i', 'v', 'e', ' ', 'r', 'o', 'u', 't', 'e', ' ', 'r', 'e', 't', 'u', 'r', 'n', 'e', 'd', ' ', 'a', ' ', 'r', 'e', 't', 'a', 'i', 'n', 'e', 'd', ' ', 'e', 'n', 'g', 'i', 'n', 'e', ' ', 'h', 'a', 'n', 'd', 'l', 'e', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'a', 'b', 's', 't', 'r', 'a', 'c', 't', ' ', 'v', 'a', 'l', 'u', 'e', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'v', 'a', 'l', 'u', 'e', ' ', 'i', 's', ' ', 'n', 'o', 't', ' ', 'a', ' ', 's', 't', 'r', 'i', 'n', 'g', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'M', 'a', 't', 'r', 'i', 'x', '4', ' ', 'a', 'r', 'e', 'n', 'a', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'U', 'R', 'L', ' ', 'a', 'r', 'e', 'n', 'a', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'v', 'a', 'l', 'u', 'e', ' ', 'a', 'r', 'e', 'n', 'a', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'v', 'a', 'l', 'u', 'e', ' ', 'g', 'r', 'a', 'p', 'h', ' ', 'c', 'o', 'n', 't', 'a', 'i', 'n', 's', ' ', 'a', ' ', 'c', 'y', 'c', 'l', 'e', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'v', 'a', 'l', 'u', 'e', ' ', 'd', 'e', 'p', 't', 'h', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'd', 'e', 'h', 'e', 'r', 'm', ' ', 'S', 't', 'a', 't', 'i', 'c', ' ', 'H', 'e', 'r', 'm', 'e', 's', ' ', 'e', 'n', 't', 'r', 'y', ' ', 'a', 'r', 'e', 'n', 'a', ' ', 'e', 'x', 'h', 'a', 'u', 's', 't', 'e', 'd', '\0',
  'g', 'l', 'o', 'b', 'a', 'l', '\0',
  '_', '_', 'w', 'r', 'i', 't', 'e', 'U', 't', 'f', '8', '\0',
  '_', '_', 'd', 'e', 'c', 'o', 'd', 'e', '\0',
  'd', 'i', 's', 'p', 'a', 't', 'c', 'h', 'S', 'c', 'r', 'i', 'p', 't', 'U', 'n', 'i', 'v', 'e', 'r', 's', 'a', 'l', 'V', 'a', 'l', 'u', 'e', '\0',
  '_', '_', 'd', 'e', 'h', 'e', 'r', 'm', 'T', 'o', 'S', 't', 'a', 't', 'i', 'c', '\0',
  '_', '_', 'd', 'e', 'h', 'e', 'r', 'm', 'F', 'r', 'o', 'm', 'S', 't', 'a', 't', 'i', 'c', '\0',
  '_', '_', 'd', 'e', 'h', 'e', 'r', 'm', 'T', 'y', 'p', 'e', 'd', 'N', 'a', 't', 'i', 'v', 'e', 'C', 'a', 'l', 'l', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'V', 'a', 'l', 'u', 'e', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'U', 'n', 'd', 'e', 'f', 'i', 'n', 'e', 'd', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'N', 'u', 'l', 'l', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'B', 'o', 'o', 'l', 'e', 'a', 'n', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'N', 'u', 'm', 'b', 'e', 'r', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'S', 't', 'r', 'i', 'n', 'g', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'H', 'a', 'n', 'd', 'l', 'e', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'D', 'e', 'f', 'o', 'l', 'd', 'V', 'a', 'l', 'u', 'e', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'M', 'a', 't', 'r', 'i', 'x', '4', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'U', 'r', 'l', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'C', 'o', 'n', 't', 'a', 'i', 'n', 'e', 'r', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'A', 'r', 'r', 'a', 'y', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'R', 'e', 'c', 'o', 'r', 'd', '\0',
  'D', 'e', 'h', 'e', 'r', 'm', 'S', 't', 'a', 't', 'i', 'c', 'M', 'a', 'p', '\0',
};
static const char16_t s_u16_pool[] = {
};
static const uint32_t s_strings[] = {0,6,2777575857,7,8,74774626,16,9,1668253718,26,13,1090592680,40,7,2852975540,48,5,3995229732,54,3,1517149248,58,5,3746588989,64,0,0,65,9,418606366,75,10,2598558186,86,11,542270241,98,12,14918013,111,7,2039772073,119,8,3143415144,128,11,875260141,140,12,3848628808,153,4,2973449445,158,12,1950834621,171,7,1591285202,179,10,3986293789,190,11,1198583161,202,8,3332154807,211,1,124921,213,1,123880,215,1,126939,217,1,121606,219,4,2536968949,224,6,544535830,231,8,1646690229,240,9,2155634493,250,10,4077459857,261,5,3111565995,267,7,1398931944,275,6,2518018554,282,14,403688404,297,3,1559219837,301,6,1873126728,308,22,1217569823,331,6,1365523450,338,3,3425294037,342,4,2730800004,347,29,4080836436,377,6,363462486,384,6,3375710952,391,10,360288817,402,43,2541086296,446,29,2185678664,476,36,3514056041,513,39,153006240,553,43,933612666,597,67,2526016847,665,43,383840441,709,47,1600383064,757,42,1189713117,800,44,792807176,845,17,1537290460,863,13,2554547181,877,7,1696643977,885,4,3324119240,890,4,3042174909,895,6,335247337,902,8,1896627004,911,4,1760165818,916,8,900227884,925,6,2833134064,932,7,883344422,940,7,883343417,948,10,1610699248,959,77,2313360437,1037,3,3139454919,1041,59,1069277335,1101,35,3492894506,1137,42,1584342099,1180,44,4113562045,1225,40,2995372205,1266,42,2985577240,1309,49,2701002818,1359,42,759142144,1402,42,57225547,1445,6,615793799,1452,11,1816296010,1464,8,4192897444,1473,28,82423744,1502,16,234932750,1519,18,2027256500,1538,23,2764438776,1562,17,162958042,1580,21,3570374322,1602,16,2505366881,1619,19,1667964955,1639,18,4134083789,1658,18,1445416137,1677,18,3737055413,1696,23,4226065310,1720,19,3162855699,1740,15,1811035537,1756,21,2929101741,1778,17,2884663950,1796,18,1971033735,1815,15,1554126140,};
#define CREATE_THIS_UNIT sh_export_deherm_typed_native
struct UnitData {
  SHUnit unit;
  SHSymbolID symbol_data[101];
  SHWritePropertyCacheEntry write_prop_cache_data[35];
  SHReadPropertyCacheEntry read_prop_cache_data[76];
  SHPrivateNameCacheEntry private_name_cache_data[0];
  SHCompressedPointer object_literal_class_cache[10];
};
SHUnit *CREATE_THIS_UNIT(void) {
  struct UnitData *unit_data = (struct UnitData *)calloc(sizeof(struct UnitData), 1);
  *unit_data = (struct UnitData){.unit = {.index = &unit_index,.num_symbols =101, .num_write_prop_cache_entries = 35, .num_read_prop_cache_entries = 76, .ascii_pool = s_ascii_pool, .u16_pool = s_u16_pool,.strings = s_strings, .symbols = unit_data->symbol_data,.write_prop_cache = unit_data->write_prop_cache_data,.read_prop_cache = unit_data->read_prop_cache_data, .private_name_cache = unit_data->private_name_cache_data, .obj_key_buffer = s_obj_key_buffer, .obj_key_buffer_size = 88, .literal_val_buffer = s_literal_val_buffer, .literal_val_buffer_size = 68, .obj_shape_table = s_obj_shape_table, .obj_shape_table_count = 10, .object_literal_class_cache = unit_data->object_literal_class_cache, .source_locations = s_source_locations, .source_locations_size = 1, .unit_main = _0_global, .unit_main_info = &s_function_info_table[0], .unit_name = "sh_compiled" }};
  return (SHUnit *)unit_data;
}

SHSymbolID *get_symbols(SHUnit *unit) {
  return ((struct UnitData *)unit)->symbol_data;
}

SHWritePropertyCacheEntry *get_write_prop_cache(SHUnit *unit) {
  return ((struct UnitData *)unit)->write_prop_cache_data;
}
SHReadPropertyCacheEntry *get_read_prop_cache(SHUnit *unit) {
  return ((struct UnitData *)unit)->read_prop_cache_data;
}
SHPrivateNameCacheEntry *get_private_name_cache(SHUnit *unit) {
  return ((struct UnitData *)unit)->private_name_cache_data;
}
