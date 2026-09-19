#define LIB_NAME "defold_netcode"
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN LIB_NAME
#endif

// The Lua API, and the extension lifecycle that registers it.
//
// This is a SIBLING of the C API in defold_netcode.h, not a layer above it and
// not a layer below it. Both call the same `deherm_netcode_*` functions. A
// TypeScript game going through the Static Hermes adapter never enters this
// file, which is the whole reason the C API exists; a Lua game never leaves it,
// which is what makes this a normal, publishable Defold extension.
//
// Keeping them siblings has a cost - two argument-checking layers rather than
// one - and it buys the thing that matters: neither API can acquire a
// dependency on the other's conventions. If the Lua surface grows a table
// shape, the C ABI does not; if the C ABI grows a handle kind, Lua does not
// have to represent it.

#include <dmsdk/dlib/log.h>
#include <dmsdk/extension/extension.hpp>
#include <dmsdk/script/script.h>

#include <string.h>

#include "defold_netcode/defold_netcode.h"

namespace {

// Defold gives every Lua module a single table. `netcode.*` is the name a
// Defold user would expect for this protocol, and it does not collide with
// anything in the engine's own script surface.
const char* kModuleName = "netcode";

// Reading a fixed-width byte string out of Lua. Every byte-blob argument here
// is a Lua string rather than a table of numbers: a string is one allocation
// and one memcpy, where a 2048-element table would be 2048 Lua-stack round
// trips for a connect token that is already opaque bytes to the game.
const uint8_t* CheckBytes(lua_State* L, int index, size_t expected, const char* what) {
  size_t length = 0;
  const char* data = luaL_checklstring(L, index, &length);
  if (expected != 0 && length != expected) {
    luaL_error(L, "%s must be exactly %d bytes, got %d", what, (int)expected, (int)length);
    return 0;
  }
  return (const uint8_t*)data;
}

int CheckHandle(lua_State* L, int index) {
  return (int)luaL_checkinteger(L, index);
}

// Turning a negative C result into a Lua error, and anything else into a
// return. Silently returning an error code as a number would make
// `netcode.client_send(...)` look like it worked; a Defold user expects a
// failed call to raise.
int PushResult(lua_State* L, int32_t result, const char* what) {
  if (result < 0) {
    return luaL_error(L, "%s failed (%d)", what, (int)result);
  }
  lua_pushinteger(L, (lua_Integer)result);
  return 1;
}

int Client_create(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  const char* address = luaL_checkstring(L, 1);
  // Defaults to UDP: a Lua game on a native target is the common case, and a
  // caller who wants the host channel has to say so.
  int32_t transport = (int32_t)luaL_optinteger(L, 2, DEHERM_NETCODE_TRANSPORT_UDP);
  uint32_t handle = deherm_netcode_client_create(address, transport);
  if (handle == DEHERM_NETCODE_INVALID_HANDLE) {
    return luaL_error(L, "netcode.client_create failed (%d)", (int)deherm_netcode_client_create_error());
  }
  lua_pushinteger(L, (lua_Integer)handle);
  return 1;
}

int Client_destroy(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 0);
  deherm_netcode_client_destroy((uint32_t)CheckHandle(L, 1));
  return 0;
}

int Client_connect(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t client = (uint32_t)CheckHandle(L, 1);
  const uint8_t* token = CheckBytes(L, 2, DEHERM_NETCODE_CONNECT_TOKEN_BYTES, "connect token");
  return PushResult(L, deherm_netcode_client_connect(client, token, DEHERM_NETCODE_CONNECT_TOKEN_BYTES),
                    "netcode.client_connect");
}

int Client_update(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t client = (uint32_t)CheckHandle(L, 1);
  // The time argument is optional because a Defold game usually has no reason
  // to hold its own clock, but it stays available because a deterministic test
  // must be able to advance time by hand.
  double time = (double)luaL_optnumber(L, 2, (lua_Number)deherm_netcode_time());
  return PushResult(L, deherm_netcode_client_update(client, time), "netcode.client_update");
}

int Client_state(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  lua_pushinteger(L, (lua_Integer)deherm_netcode_client_state((uint32_t)CheckHandle(L, 1)));
  return 1;
}

int Client_index(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  lua_pushinteger(L, (lua_Integer)deherm_netcode_client_index((uint32_t)CheckHandle(L, 1)));
  return 1;
}

int Client_disconnect(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  return PushResult(L, deherm_netcode_client_disconnect((uint32_t)CheckHandle(L, 1)), "netcode.client_disconnect");
}

int Client_send(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t client = (uint32_t)CheckHandle(L, 1);
  size_t length = 0;
  const char* data = luaL_checklstring(L, 2, &length);
  if (length == 0 || length > DEHERM_NETCODE_MAX_PACKET_BYTES) {
    return luaL_error(L, "netcode.client_send payload must be 1..%d bytes, got %d",
                      DEHERM_NETCODE_MAX_PACKET_BYTES, (int)length);
  }
  return PushResult(L, deherm_netcode_client_send(client, (const uint8_t*)data, (int32_t)length),
                    "netcode.client_send");
}

// Returns payload, sequence - or nil when nothing is queued. Returning nil
// rather than an empty string means `while true do local p = ... if not p then
// break end end` is the obvious drain loop, and an empty payload (which netcode
// never produces) could never be confused with "no packet".
int Client_receive(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 2);
  uint32_t client = (uint32_t)CheckHandle(L, 1);
  uint8_t buffer[DEHERM_NETCODE_MAX_PACKET_BYTES];
  uint64_t sequence = 0;
  int32_t bytes = deherm_netcode_client_receive(client, buffer, (int32_t)sizeof(buffer), &sequence);
  if (bytes < 0) return luaL_error(L, "netcode.client_receive failed (%d)", (int)bytes);
  if (bytes == 0) {
    lua_pushnil(L);
    lua_pushnil(L);
    return 2;
  }
  lua_pushlstring(L, (const char*)buffer, (size_t)bytes);
  // Lua numbers are doubles. A netcode sequence is a uint64 and will exceed
  // 2^53 only after ~9e15 packets, which at 60Hz is longer than the universe
  // has been around, so a double is an honest representation here rather than a
  // silent truncation waiting to happen.
  lua_pushnumber(L, (lua_Number)sequence);
  return 2;
}

int Client_push_datagram(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t client = (uint32_t)CheckHandle(L, 1);
  size_t length = 0;
  const char* data = luaL_checklstring(L, 2, &length);
  return PushResult(L, deherm_netcode_client_push_datagram(client, (const uint8_t*)data, (int32_t)length),
                    "netcode.client_push_datagram");
}

int Client_pop_datagram(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t client = (uint32_t)CheckHandle(L, 1);
  uint8_t buffer[2560];
  int32_t bytes = deherm_netcode_client_pop_datagram(client, buffer, (int32_t)sizeof(buffer));
  if (bytes < 0) return luaL_error(L, "netcode.client_pop_datagram failed (%d)", (int)bytes);
  if (bytes == 0) {
    lua_pushnil(L);
    return 1;
  }
  lua_pushlstring(L, (const char*)buffer, (size_t)bytes);
  return 1;
}

int Server_create(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  const char* address = luaL_checkstring(L, 1);
  // Lua has no uint64. A protocol id is an opaque tag both ends must agree on,
  // so taking it as a number and rounding through a double is fine up to 2^53;
  // beyond that the two ends would silently disagree, so it is rejected.
  lua_Number protocol = luaL_checknumber(L, 2);
  if (protocol < 0 || protocol > 9007199254740992.0) {
    return luaL_error(L, "netcode.server_create protocol_id must fit in 2^53");
  }
  const uint8_t* key = CheckBytes(L, 3, DEHERM_NETCODE_KEY_BYTES, "private key");
  int32_t transport = (int32_t)luaL_optinteger(L, 4, DEHERM_NETCODE_TRANSPORT_UDP);

  uint32_t handle = deherm_netcode_server_create(address, (uint64_t)protocol, key, DEHERM_NETCODE_KEY_BYTES,
                                                 transport);
  if (handle == DEHERM_NETCODE_INVALID_HANDLE) {
    return luaL_error(L, "netcode.server_create failed (%d)", (int)deherm_netcode_server_create_error());
  }
  lua_pushinteger(L, (lua_Integer)handle);
  return 1;
}

int Server_destroy(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 0);
  deherm_netcode_server_destroy((uint32_t)CheckHandle(L, 1));
  return 0;
}

int Server_start(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  return PushResult(L, deherm_netcode_server_start((uint32_t)CheckHandle(L, 1), (int32_t)luaL_checkinteger(L, 2)),
                    "netcode.server_start");
}

int Server_stop(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  return PushResult(L, deherm_netcode_server_stop((uint32_t)CheckHandle(L, 1)), "netcode.server_stop");
}

int Server_update(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t server = (uint32_t)CheckHandle(L, 1);
  double time = (double)luaL_optnumber(L, 2, (lua_Number)deherm_netcode_time());
  return PushResult(L, deherm_netcode_server_update(server, time), "netcode.server_update");
}

int Server_num_connected_clients(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  lua_pushinteger(L, (lua_Integer)deherm_netcode_server_num_connected_clients((uint32_t)CheckHandle(L, 1)));
  return 1;
}

int Server_client_connected(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  int32_t connected =
      deherm_netcode_server_client_connected((uint32_t)CheckHandle(L, 1), (int32_t)luaL_checkinteger(L, 2));
  lua_pushboolean(L, connected == 1);
  return 1;
}

int Server_send(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t server = (uint32_t)CheckHandle(L, 1);
  int32_t client_index = (int32_t)luaL_checkinteger(L, 2);
  size_t length = 0;
  const char* data = luaL_checklstring(L, 3, &length);
  if (length == 0 || length > DEHERM_NETCODE_MAX_PACKET_BYTES) {
    return luaL_error(L, "netcode.server_send payload must be 1..%d bytes, got %d",
                      DEHERM_NETCODE_MAX_PACKET_BYTES, (int)length);
  }
  return PushResult(L, deherm_netcode_server_send(server, client_index, (const uint8_t*)data, (int32_t)length),
                    "netcode.server_send");
}

int Server_receive(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 2);
  uint32_t server = (uint32_t)CheckHandle(L, 1);
  int32_t client_index = (int32_t)luaL_checkinteger(L, 2);
  uint8_t buffer[DEHERM_NETCODE_MAX_PACKET_BYTES];
  uint64_t sequence = 0;
  int32_t bytes = deherm_netcode_server_receive(server, client_index, buffer, (int32_t)sizeof(buffer), &sequence);
  if (bytes < 0) return luaL_error(L, "netcode.server_receive failed (%d)", (int)bytes);
  if (bytes == 0) {
    lua_pushnil(L);
    lua_pushnil(L);
    return 2;
  }
  lua_pushlstring(L, (const char*)buffer, (size_t)bytes);
  lua_pushnumber(L, (lua_Number)sequence);
  return 2;
}

int Server_set_peer_address(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  return PushResult(L, deherm_netcode_server_set_peer_address((uint32_t)CheckHandle(L, 1), luaL_checkstring(L, 2)),
                    "netcode.server_set_peer_address");
}

int Server_push_datagram(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t server = (uint32_t)CheckHandle(L, 1);
  size_t length = 0;
  const char* data = luaL_checklstring(L, 2, &length);
  return PushResult(L, deherm_netcode_server_push_datagram(server, (const uint8_t*)data, (int32_t)length),
                    "netcode.server_push_datagram");
}

int Server_pop_datagram(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  uint32_t server = (uint32_t)CheckHandle(L, 1);
  uint8_t buffer[2560];
  int32_t bytes = deherm_netcode_server_pop_datagram(server, buffer, (int32_t)sizeof(buffer));
  if (bytes < 0) return luaL_error(L, "netcode.server_pop_datagram failed (%d)", (int)bytes);
  if (bytes == 0) {
    lua_pushnil(L);
    return 1;
  }
  lua_pushlstring(L, (const char*)buffer, (size_t)bytes);
  return 1;
}

// Present so a listen-server or a local test can mint its own tokens. A shipped
// client must NOT hold the private key, and no amount of API design can enforce
// that - so it is said here, and in the header, and in the README.
int Generate_connect_token(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  const char* address = luaL_checkstring(L, 1);
  lua_Number client_id = luaL_checknumber(L, 2);
  lua_Number protocol = luaL_checknumber(L, 3);
  const uint8_t* key = CheckBytes(L, 4, DEHERM_NETCODE_KEY_BYTES, "private key");
  int32_t expire_seconds = (int32_t)luaL_optinteger(L, 5, 30);
  int32_t timeout_seconds = (int32_t)luaL_optinteger(L, 6, 5);

  size_t user_data_length = 0;
  const char* user_data = lua_isnoneornil(L, 7) ? 0 : luaL_checklstring(L, 7, &user_data_length);
  if (user_data_length > DEHERM_NETCODE_USER_DATA_BYTES) {
    return luaL_error(L, "netcode.generate_connect_token user data must be at most %d bytes",
                      DEHERM_NETCODE_USER_DATA_BYTES);
  }

  uint8_t token[DEHERM_NETCODE_CONNECT_TOKEN_BYTES];
  int32_t result = deherm_netcode_generate_connect_token(
      address, (uint64_t)client_id, (uint64_t)protocol, key, DEHERM_NETCODE_KEY_BYTES, expire_seconds,
      timeout_seconds, (const uint8_t*)user_data, (int32_t)user_data_length, token, (int32_t)sizeof(token));
  if (result < 0) return luaL_error(L, "netcode.generate_connect_token failed (%d)", (int)result);
  lua_pushlstring(L, (const char*)token, sizeof(token));
  return 1;
}

int Set_log_level(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 0);
  deherm_netcode_set_log_level((int32_t)luaL_checkinteger(L, 1));
  return 0;
}

int Time(lua_State* L) {
  DM_LUA_STACK_CHECK(L, 1);
  lua_pushnumber(L, (lua_Number)deherm_netcode_time());
  return 1;
}

const luaL_reg kModule[] = {
    {"client_create", Client_create},
    {"client_destroy", Client_destroy},
    {"client_connect", Client_connect},
    {"client_update", Client_update},
    {"client_state", Client_state},
    {"client_index", Client_index},
    {"client_disconnect", Client_disconnect},
    {"client_send", Client_send},
    {"client_receive", Client_receive},
    {"client_push_datagram", Client_push_datagram},
    {"client_pop_datagram", Client_pop_datagram},

    {"server_create", Server_create},
    {"server_destroy", Server_destroy},
    {"server_start", Server_start},
    {"server_stop", Server_stop},
    {"server_update", Server_update},
    {"server_num_connected_clients", Server_num_connected_clients},
    {"server_client_connected", Server_client_connected},
    {"server_send", Server_send},
    {"server_receive", Server_receive},
    {"server_set_peer_address", Server_set_peer_address},
    {"server_push_datagram", Server_push_datagram},
    {"server_pop_datagram", Server_pop_datagram},

    {"generate_connect_token", Generate_connect_token},
    {"set_log_level", Set_log_level},
    {"time", Time},
    {0, 0},
};

struct Constant {
  const char* name;
  int value;
};

const Constant kConstants[] = {
    {"TRANSPORT_UDP", DEHERM_NETCODE_TRANSPORT_UDP},
    {"TRANSPORT_HOST_DATAGRAM", DEHERM_NETCODE_TRANSPORT_HOST_DATAGRAM},

    {"STATE_CONNECT_TOKEN_EXPIRED", DEHERM_NETCODE_STATE_CONNECT_TOKEN_EXPIRED},
    {"STATE_INVALID_CONNECT_TOKEN", DEHERM_NETCODE_STATE_INVALID_CONNECT_TOKEN},
    {"STATE_CONNECTION_TIMED_OUT", DEHERM_NETCODE_STATE_CONNECTION_TIMED_OUT},
    {"STATE_CONNECTION_RESPONSE_TIMED_OUT", DEHERM_NETCODE_STATE_CONNECTION_RESPONSE_TIMED_OUT},
    {"STATE_CONNECTION_REQUEST_TIMED_OUT", DEHERM_NETCODE_STATE_CONNECTION_REQUEST_TIMED_OUT},
    {"STATE_CONNECTION_DENIED", DEHERM_NETCODE_STATE_CONNECTION_DENIED},
    {"STATE_DISCONNECTED", DEHERM_NETCODE_STATE_DISCONNECTED},
    {"STATE_SENDING_CONNECTION_REQUEST", DEHERM_NETCODE_STATE_SENDING_CONNECTION_REQUEST},
    {"STATE_SENDING_CONNECTION_RESPONSE", DEHERM_NETCODE_STATE_SENDING_CONNECTION_RESPONSE},
    {"STATE_CONNECTED", DEHERM_NETCODE_STATE_CONNECTED},

    {"MAX_PACKET_BYTES", DEHERM_NETCODE_MAX_PACKET_BYTES},
    {"CONNECT_TOKEN_BYTES", DEHERM_NETCODE_CONNECT_TOKEN_BYTES},
    {"KEY_BYTES", DEHERM_NETCODE_KEY_BYTES},
    {"USER_DATA_BYTES", DEHERM_NETCODE_USER_DATA_BYTES},
    {0, 0},
};

void RegisterModule(lua_State* L) {
  int top = lua_gettop(L);
  luaL_register(L, kModuleName, kModule);
  for (const Constant* constant = kConstants; constant->name; constant++) {
    lua_pushnumber(L, (lua_Number)constant->value);
    lua_setfield(L, -2, constant->name);
  }
  lua_pop(L, 1);
  assert(top == lua_gettop(L));
  (void)top;
}

dmExtension::Result AppInitializeNetcode(dmExtension::AppParams*) {
  // netcode_init seeds libsodium's RNG. On HTML5 that is the call that installs
  // crypto.getRandomValues as the entropy source, and without it every key
  // netcode generates would be whatever was on the stack. It is done once, at
  // app init, so no call path can reach a client or a token without it.
  if (deherm_netcode_init() != DEHERM_NETCODE_OK) {
    dmLogError("netcode failed to initialise; the extension will not function");
    return dmExtension::RESULT_INIT_ERROR;
  }
  return dmExtension::RESULT_OK;
}

dmExtension::Result AppFinalizeNetcode(dmExtension::AppParams*) {
  deherm_netcode_term();
  return dmExtension::RESULT_OK;
}

dmExtension::Result InitializeNetcode(dmExtension::Params* params) {
  RegisterModule(params->m_L);
  return dmExtension::RESULT_OK;
}

dmExtension::Result FinalizeNetcode(dmExtension::Params*) {
  return dmExtension::RESULT_OK;
}

}  // namespace

// Defold derives the registration symbol from the extension folder name, so
// this must be `defold_netcode`. The enclosing namespace keeps the C++
// identifier out of the way while the exported C symbol stays global - the same
// arrangement defold_hermes/src/extension.cpp uses and for the same reason.
namespace deherm_netcode_registration {
DM_DECLARE_EXTENSION(defold_netcode, LIB_NAME, AppInitializeNetcode, AppFinalizeNetcode, InitializeNetcode, 0, 0,
                     FinalizeNetcode)
}  // namespace deherm_netcode_registration
