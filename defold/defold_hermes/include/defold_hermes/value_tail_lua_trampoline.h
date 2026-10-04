#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#include <dmsdk/lua/lua.h>

#include <stddef.h>
#include <stdint.h>

typedef enum DehermValueTailLuaKind {
  DEHERM_VALUE_TAIL_LUA_NIL,
  DEHERM_VALUE_TAIL_LUA_BOOLEAN,
  DEHERM_VALUE_TAIL_LUA_NUMBER,
  DEHERM_VALUE_TAIL_LUA_STRING,
  DEHERM_VALUE_TAIL_LUA_BYTES,
  DEHERM_VALUE_TAIL_LUA_HASH,
  DEHERM_VALUE_TAIL_LUA_USERDATA,
  DEHERM_VALUE_TAIL_LUA_VECTOR3,
  DEHERM_VALUE_TAIL_LUA_MATRIX4,
  DEHERM_VALUE_TAIL_LUA_NONE,
} DehermValueTailLuaKind;

typedef struct DehermValueTailLuaArgument {
  DehermValueTailLuaKind kind;
  double number;
  uint64_t payload;
  const void* data;
  size_t size;
  const char* metatable;
} DehermValueTailLuaArgument;

typedef struct DehermValueTailLuaResult {
  DehermValueTailLuaKind kind;
  double number;
  uint64_t payload;
  float lanes[16];
  uint32_t stringLength;
} DehermValueTailLuaResult;

typedef struct DehermValueTailLuaCall {
  const char* module;
  const char* member;
  int* functionReference;
  int instanceReference;
  int stackReserve;
  const DehermValueTailLuaArgument* arguments;
  uint32_t argumentCount;
  DehermValueTailLuaKind resultKind;
  char* stringScratch;
  size_t stringScratchCapacity;
  DehermValueTailLuaResult* result;
  void (*getInstance)(lua_State*);
  void (*setInstance)(lua_State*);
  void (*pushHash)(lua_State*, uint64_t);
  int (*pushDefoldUserdata)(lua_State*, const DehermValueTailLuaArgument*);
  int (*readHash)(lua_State*, uint64_t*);
  int (*readVector3)(lua_State*, float*);
  int (*readMatrix4)(lua_State*, float*);
  char* error;
  size_t errorCapacity;
  int status;
} DehermValueTailLuaCall;

/* All Lua stack preparation and the exact protected call run from C frames. */
int deherm_value_tail_lua_dispatch(lua_State* state, DehermValueTailLuaCall* call);

#ifdef __cplusplus
}
#endif
