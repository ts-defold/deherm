#include <defold_hermes/value_tail_lua_trampoline.h>

#ifdef __cplusplus
extern "C" {
#endif
#include <dmsdk/lua/lauxlib.h>
#ifdef __cplusplus
}
#endif

#include <stdio.h>
#include <string.h>

enum { DEHERM_VALUE_TAIL_LUA_SUCCESS = 0, DEHERM_VALUE_TAIL_LUA_ERROR = 1 };

static void fail(DehermValueTailLuaCall* call, const char* message) {
  call->status = DEHERM_VALUE_TAIL_LUA_ERROR;
  if (call->error && call->errorCapacity) {
    snprintf(call->error, call->errorCapacity, "%s", message);
  }
}

static int bindFunction(lua_State* state, DehermValueTailLuaCall* call) {
  int base = lua_gettop(state);
  if (*call->functionReference == LUA_NOREF || *call->functionReference == LUA_REFNIL) {
    if (strcmp(call->module, "builtins") == 0) {
      lua_getglobal(state, call->member);
    } else {
      lua_getglobal(state, call->module);
      if (lua_istable(state, -1)) {
        lua_getfield(state, -1, call->member);
        lua_remove(state, -2);
      }
    }
    if (!lua_isfunction(state, -1)) {
      lua_settop(state, base);
      fail(call, "Defold value-tail Lua function is unavailable");
      return 0;
    }
    *call->functionReference = luaL_ref(state, LUA_REGISTRYINDEX);
    if (*call->functionReference == LUA_NOREF || *call->functionReference == LUA_REFNIL) {
      fail(call, "Defold value-tail Lua function could not be retained");
      return 0;
    }
  }
  lua_rawgeti(state, LUA_REGISTRYINDEX, *call->functionReference);
  return 1;
}

static int pushArgument(lua_State* state, const DehermValueTailLuaArgument* argument,
    DehermValueTailLuaCall* call) {
  switch (argument->kind) {
    case DEHERM_VALUE_TAIL_LUA_NIL:
      lua_pushnil(state);
      return 1;
    case DEHERM_VALUE_TAIL_LUA_BOOLEAN:
      lua_pushboolean(state, argument->number != 0.0);
      return 1;
    case DEHERM_VALUE_TAIL_LUA_NUMBER:
      lua_pushnumber(state, argument->number);
      return 1;
    case DEHERM_VALUE_TAIL_LUA_STRING:
    case DEHERM_VALUE_TAIL_LUA_BYTES:
      if (argument->size && !argument->data) {
        fail(call, "Defold value-tail string data is null for a non-empty value");
        return 0;
      }
      lua_pushlstring(state, argument->data ? (const char*)argument->data : "", argument->size);
      return 1;
    case DEHERM_VALUE_TAIL_LUA_HASH:
      if (!call->pushHash) {
        fail(call, "Defold value-tail hash pusher is unavailable");
        return 0;
      }
      call->pushHash(state, argument->payload);
      return 1;
    case DEHERM_VALUE_TAIL_LUA_USERDATA:
    case DEHERM_VALUE_TAIL_LUA_VECTOR3:
    case DEHERM_VALUE_TAIL_LUA_MATRIX4: {
      void* destination;
      if (!argument->data || !argument->size || !argument->metatable) {
        fail(call, "Defold value-tail userdata staging is invalid");
        return 0;
      }
      if (call->pushDefoldUserdata) {
        if (call->pushDefoldUserdata(state, argument)) return 1;
        fail(call, "Defold value-tail public userdata pusher is unavailable");
        return 0;
      }
      destination = lua_newuserdata(state, argument->size);
      memcpy(destination, argument->data, argument->size);
      luaL_getmetatable(state, argument->metatable);
      if (!lua_istable(state, -1)) {
        lua_pop(state, 2);
        fail(call, "Defold value-tail userdata metatable is unavailable");
        return 0;
      }
      lua_setmetatable(state, -2);
      return 1;
    }
    case DEHERM_VALUE_TAIL_LUA_NONE:
      break;
  }
  fail(call, "Defold value-tail argument codec is unsupported");
  return 0;
}

static int readResult(lua_State* state, DehermValueTailLuaCall* call) {
  const char* data;
  size_t length;
  if (call->resultKind == DEHERM_VALUE_TAIL_LUA_NONE) return 1;
  if (!call->result) {
    fail(call, "Defold value-tail result storage is unavailable");
    return 0;
  }
  memset(call->result, 0, sizeof(*call->result));
  call->result->kind = call->resultKind;
  switch (call->resultKind) {
    case DEHERM_VALUE_TAIL_LUA_BOOLEAN:
      if (lua_type(state, -1) != LUA_TBOOLEAN) {
        fail(call, "Defold value-tail result is not boolean");
        return 0;
      }
      call->result->number = lua_toboolean(state, -1) ? 1.0 : 0.0;
      return 1;
    case DEHERM_VALUE_TAIL_LUA_NUMBER:
      if (lua_type(state, -1) != LUA_TNUMBER) {
        fail(call, "Defold value-tail result is not numeric");
        return 0;
      }
      call->result->number = lua_tonumber(state, -1);
      return 1;
    case DEHERM_VALUE_TAIL_LUA_STRING:
      if (lua_type(state, -1) != LUA_TSTRING) {
        fail(call, "Defold value-tail result is not a string");
        return 0;
      }
      data = lua_tolstring(state, -1, &length);
      if (!call->stringScratch || length > call->stringScratchCapacity) {
        fail(call, "Defold value-tail string scratch is exhausted");
        return 0;
      }
      if (length) memcpy(call->stringScratch, data, length);
      call->result->stringLength = (uint32_t)length;
      return 1;
    case DEHERM_VALUE_TAIL_LUA_HASH:
      if (!call->readHash || !call->readHash(state, &call->result->payload)) {
        fail(call, "Defold value-tail result is not a hash");
        return 0;
      }
      return 1;
    case DEHERM_VALUE_TAIL_LUA_VECTOR3:
    case DEHERM_VALUE_TAIL_LUA_MATRIX4: {
      const int ok = call->resultKind == DEHERM_VALUE_TAIL_LUA_VECTOR3
          ? call->readVector3 && call->readVector3(state, call->result->lanes)
          : call->readMatrix4 && call->readMatrix4(state, call->result->lanes);
      if (!ok) {
        fail(call, call->resultKind == DEHERM_VALUE_TAIL_LUA_VECTOR3
            ? "Defold value-tail result is not vector3"
            : "Defold value-tail result is not matrix4");
        return 0;
      }
      return 1;
    }
    case DEHERM_VALUE_TAIL_LUA_USERDATA:
      break;
    case DEHERM_VALUE_TAIL_LUA_NIL:
    case DEHERM_VALUE_TAIL_LUA_BYTES:
    case DEHERM_VALUE_TAIL_LUA_NONE:
      break;
  }
  fail(call, "Defold value-tail result codec is unsupported");
  return 0;
}

static int invokeValueTail(lua_State* state) {
  DehermValueTailLuaCall* call = (DehermValueTailLuaCall*)lua_touserdata(state, 1);
  int base = lua_gettop(state);
  int status;
  uint32_t index;
  call->status = DEHERM_VALUE_TAIL_LUA_ERROR;
  if (!call->getInstance || !call->setInstance || !call->functionReference) {
    fail(call, "Defold value-tail Lua trampoline is incomplete");
    return 0;
  }
  if (!lua_checkstack(state, call->stackReserve)) {
    fail(call, "Defold value-tail Lua backend cannot reserve its bounded stack frame");
    return 0;
  }
  if (!bindFunction(state, call)) goto restore_instance;
  for (index = 0; index < call->argumentCount; ++index) {
    if (!pushArgument(state, &call->arguments[index], call)) goto restore_instance;
  }
  status = lua_pcall(state, (int)call->argumentCount,
      call->resultKind == DEHERM_VALUE_TAIL_LUA_NONE ? 0 : 1, 0);
  if (status != 0) {
    const char* message = lua_type(state, -1) == LUA_TSTRING ? lua_tostring(state, -1) : NULL;
    fail(call, message ? message : "Defold value-tail Lua call failed without an error string");
    goto restore_instance;
  }
  if (!readResult(state, call)) goto restore_instance;
  call->status = DEHERM_VALUE_TAIL_LUA_SUCCESS;

restore_instance:
  lua_settop(state, base - 1);
  return 0;
}

/*
 * This is the outer C-only protected frame. Keep the captured instance's
 * previous value on its stack while an inner lua_pcall builds arguments and
 * invokes the target. An allocator longjmp is caught by that pcall, after
 * which this frame restores the prior instance before returning to C++.
 */
static int protectedValueTail(lua_State* state) {
  DehermValueTailLuaCall* call = (DehermValueTailLuaCall*)lua_touserdata(state, 1);
  int base = lua_gettop(state);
  int previousInstance;
  int status;
  const char* message;
  if (!call->getInstance || !call->setInstance || !call->functionReference) {
    fail(call, "Defold value-tail Lua trampoline is incomplete");
    return 0;
  }
  call->getInstance(state);
  previousInstance = lua_gettop(state);
  lua_rawgeti(state, LUA_REGISTRYINDEX, call->instanceReference);
  call->setInstance(state);

  lua_pushcfunction(state, invokeValueTail);
  lua_pushlightuserdata(state, call);
  status = lua_pcall(state, 1, 0, 0);
  if (status != 0) {
    message = lua_type(state, -1) == LUA_TSTRING ? lua_tostring(state, -1) : NULL;
    fail(call, message ? message : "protected Defold value-tail Lua call failed");
  }

  lua_pushvalue(state, previousInstance);
  call->setInstance(state);
  lua_settop(state, base - 1);
  return 0;
}

int deherm_value_tail_lua_dispatch(lua_State* state, DehermValueTailLuaCall* call) {
  int top = lua_gettop(state);
  int status = lua_cpcall(state, protectedValueTail, call);
  if (status != 0) {
    const char* message = lua_type(state, -1) == LUA_TSTRING ? lua_tostring(state, -1) : NULL;
    fail(call, message ? message : "protected Defold value-tail Lua dispatch failed");
  }
  lua_settop(state, top);
  return call->status;
}
