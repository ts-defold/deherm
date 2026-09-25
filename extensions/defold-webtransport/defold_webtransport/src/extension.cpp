#define LIB_NAME "defold_webtransport"
#ifndef DLIB_LOG_DOMAIN
#define DLIB_LOG_DOMAIN LIB_NAME
#endif

#include <dmsdk/dlib/log.h>
#include <dmsdk/extension/extension.hpp>
#include <dmsdk/script/script.h>

#include <defold_webtransport/client.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>

extern "C" size_t defold_webtransport_pump_callbacks(void);

namespace {

constexpr const char* kSessionType = "defold_webtransport.session";
constexpr const char* kStreamType = "defold_webtransport.stream";
constexpr std::size_t kMaximumCertificateHashes = 8;

struct LuaCallbackContext {
  dmScript::LuaCallbackInfo* callback = nullptr;
  int stream_table_ref = LUA_NOREF;
  std::uint32_t references = 1;
  std::uint32_t callback_depth = 0;
  bool alive = true;
  bool destroy_callback_pending = false;
};

struct LuaSession {
  DefoldWebTransportSession* session = nullptr;
  LuaCallbackContext* context = nullptr;
  bool owner = false;
};

struct LuaStream {
  DefoldWebTransportStream* stream = nullptr;
  LuaCallbackContext* context = nullptr;
  bool read_open = false;
  bool write_open = false;
};

void Retain(LuaCallbackContext* context) {
  if (context != nullptr) ++context->references;
}

void Release(LuaCallbackContext* context) {
  if (context != nullptr && --context->references == 0) delete context;
}

LuaSession* CheckSession(lua_State* state, const int index) {
  auto* value = static_cast<LuaSession*>(luaL_checkudata(state, index, kSessionType));
  if (value == nullptr || value->context == nullptr || !value->context->alive || value->session == nullptr) {
    luaL_error(state, "defold_webtransport session is closed");
  }
  return value;
}

LuaStream* CheckStream(lua_State* state, const int index) {
  auto* value = static_cast<LuaStream*>(luaL_checkudata(state, index, kStreamType));
  if (value == nullptr || value->context == nullptr || !value->context->alive || value->stream == nullptr) {
    luaL_error(state, "defold_webtransport stream is closed");
  }
  return value;
}

std::uint32_t OptionalCode(lua_State* state, const int index) {
  if (lua_isnoneornil(state, index)) return 0;
  const lua_Number value = luaL_checknumber(state, index);
  if (!std::isfinite(static_cast<double>(value)) || value < 0 ||
      value > std::numeric_limits<std::uint32_t>::max() ||
      value != static_cast<std::uint32_t>(value)) {
    luaL_error(state, "WebTransport code must be an unsigned 32-bit integer");
  }
  return static_cast<std::uint32_t>(value);
}

void PushSession(lua_State* state, DefoldWebTransportSession* session, LuaCallbackContext* context,
                 const bool owner) {
  auto* value = static_cast<LuaSession*>(lua_newuserdata(state, sizeof(LuaSession)));
  *value = {session, context, owner};
  Retain(context);
  luaL_getmetatable(state, kSessionType);
  lua_setmetatable(state, -2);
}

void InvalidateStream(lua_State* state, LuaCallbackContext* context,
                      DefoldWebTransportStream* stream);

void PushStream(lua_State* state, DefoldWebTransportStream* stream, LuaCallbackContext* context,
                const bool bidirectional, const bool incoming) {
  lua_rawgeti(state, LUA_REGISTRYINDEX, context->stream_table_ref);
  lua_pushlightuserdata(state, stream);
  lua_rawget(state, -2);
  if (!lua_isnil(state, -1)) {
    lua_remove(state, -2);
    return;
  }
  lua_pop(state, 1);
  auto* value = static_cast<LuaStream*>(lua_newuserdata(state, sizeof(LuaStream)));
  *value = {stream, context, bidirectional || incoming, bidirectional || !incoming};
  Retain(context);
  luaL_getmetatable(state, kStreamType);
  lua_setmetatable(state, -2);
  lua_pushlightuserdata(state, stream);
  lua_pushvalue(state, -2);
  lua_rawset(state, -4);
  lua_remove(state, -2);
}

void MarkStreamTerminal(lua_State* state, LuaCallbackContext* context,
                        DefoldWebTransportStream* stream, const bool read_terminal,
                        const bool write_terminal) {
  if (context == nullptr || context->stream_table_ref == LUA_NOREF || stream == nullptr) return;
  lua_rawgeti(state, LUA_REGISTRYINDEX, context->stream_table_ref);
  lua_pushlightuserdata(state, stream);
  lua_rawget(state, -2);
  bool release = false;
  if (lua_isuserdata(state, -1)) {
    auto* value = static_cast<LuaStream*>(lua_touserdata(state, -1));
    if (read_terminal) value->read_open = false;
    if (write_terminal) value->write_open = false;
    release = !value->read_open && !value->write_open;
  }
  lua_pop(state, 2);
  if (release) InvalidateStream(state, context, stream);
}

void InvalidateStream(lua_State* state, LuaCallbackContext* context, DefoldWebTransportStream* stream) {
  if (context == nullptr || context->stream_table_ref == LUA_NOREF || stream == nullptr) return;
  lua_rawgeti(state, LUA_REGISTRYINDEX, context->stream_table_ref);
  lua_pushlightuserdata(state, stream);
  lua_rawget(state, -2);
  if (lua_isuserdata(state, -1)) {
    auto* value = static_cast<LuaStream*>(lua_touserdata(state, -1));
    value->stream = nullptr;
    defold_webtransport_stream_release(stream);
  }
  lua_pop(state, 1);
  lua_pushlightuserdata(state, stream);
  lua_pushnil(state);
  lua_rawset(state, -3);
  lua_pop(state, 1);
}

const char* EventName(const DefoldWebTransportEventType type) {
  switch (type) {
    case DEFOLD_WEBTRANSPORT_EVENT_READY: return "ready";
    case DEFOLD_WEBTRANSPORT_EVENT_STREAM: return "stream";
    case DEFOLD_WEBTRANSPORT_EVENT_DATA: return "data";
    case DEFOLD_WEBTRANSPORT_EVENT_DATAGRAM: return "datagram";
    case DEFOLD_WEBTRANSPORT_EVENT_STREAM_RESET: return "reset";
    case DEFOLD_WEBTRANSPORT_EVENT_STOP_SENDING: return "stop_sending";
    case DEFOLD_WEBTRANSPORT_EVENT_CLOSE: return "close";
  }
  return "close";
}

void SetBoolean(lua_State* state, const char* name, const bool value) {
  lua_pushboolean(state, value ? 1 : 0);
  lua_setfield(state, -2, name);
}

void LuaEventCallback(void* user_data, const DefoldWebTransportEvent* event) {
  auto* context = static_cast<LuaCallbackContext*>(user_data);
  if (context == nullptr || !context->alive || event == nullptr || context->callback == nullptr ||
      !dmScript::IsCallbackValid(context->callback)) return;
  lua_State* state = dmScript::GetCallbackLuaContext(context->callback);
  if (state == nullptr || !dmScript::SetupCallback(context->callback)) return;
  ++context->callback_depth;
  lua_newtable(state);
  lua_pushstring(state, EventName(event->type));
  lua_setfield(state, -2, "type");
  PushSession(state, event->session, context, false);
  lua_setfield(state, -2, "session");
  if (event->stream != nullptr) {
    PushStream(state, event->stream, context, event->bidirectional, event->incoming);
    lua_setfield(state, -2, "stream");
  }
  if (event->bytes.data != nullptr || event->bytes.size != 0) {
    lua_pushlstring(state, reinterpret_cast<const char*>(event->bytes.data), event->bytes.size);
    lua_setfield(state, -2, "data");
  }
  lua_pushnumber(state, event->code);
  lua_setfield(state, -2, "code");
  if (event->reason != nullptr) {
    lua_pushstring(state, event->reason);
    lua_setfield(state, -2, "reason");
  }
  SetBoolean(state, "fin", event->fin);
  SetBoolean(state, "bidirectional", event->bidirectional);
  SetBoolean(state, "incoming", event->incoming);
  (void)dmScript::PCall(state, 2, 0);  // self + event
  dmScript::TeardownCallback(context->callback);
  --context->callback_depth;
  if (context->callback_depth == 0 && context->destroy_callback_pending) {
    dmScript::DestroyCallback(context->callback);
    context->callback = nullptr;
    context->destroy_callback_pending = false;
  }
  if (context->alive && event->stream != nullptr) {
    MarkStreamTerminal(state, context, event->stream,
                       (event->type == DEFOLD_WEBTRANSPORT_EVENT_DATA && event->fin) ||
                           event->type == DEFOLD_WEBTRANSPORT_EVENT_STREAM_RESET,
                       event->type == DEFOLD_WEBTRANSPORT_EVENT_STOP_SENDING);
  }
}

int SessionGc(lua_State* state) {
  auto* value = static_cast<LuaSession*>(luaL_checkudata(state, 1, kSessionType));
  if (value->owner && value->context != nullptr && value->context->alive) {
    value->context->alive = false;
    if (value->context->stream_table_ref != LUA_NOREF) {
      luaL_unref(state, LUA_REGISTRYINDEX, value->context->stream_table_ref);
      value->context->stream_table_ref = LUA_NOREF;
    }
    if (value->context->callback != nullptr) {
      if (value->context->callback_depth == 0) {
        dmScript::DestroyCallback(value->context->callback);
        value->context->callback = nullptr;
      } else {
        value->context->destroy_callback_pending = true;
      }
    }
    defold_webtransport_destroy(value->session);
  }
  Release(value->context);
  *value = {};
  return 0;
}

int StreamGc(lua_State* state) {
  auto* value = static_cast<LuaStream*>(luaL_checkudata(state, 1, kStreamType));
  if (value->stream != nullptr) {
    defold_webtransport_stream_release(value->stream);
  }
  Release(value->context);
  *value = {};
  return 0;
}

int LuaConnect(lua_State* state) {
  const bool has_options = lua_istable(state, 2);
  const int callback_index = has_options || lua_isnoneornil(state, 2) ? 3 : 2;
  const char* url = luaL_checkstring(state, 1);
  luaL_checktype(state, callback_index, LUA_TFUNCTION);

  std::array<DefoldWebTransportCertificateHash, kMaximumCertificateHashes> hashes{};
  std::size_t hash_count = 0;
  std::uint16_t anticipated_uni = 0;
  std::uint16_t anticipated_bidi = 0;
  if (has_options) {
    lua_getfield(state, 2, "server_certificate_hashes");
    if (lua_istable(state, -1)) {
      const std::size_t count = lua_objlen(state, -1);
      if (count > hashes.size()) {
        return luaL_error(state, "server_certificate_hashes exceeds the bounded limit of %u",
                          static_cast<unsigned>(hashes.size()));
      }
      for (std::size_t index = 0; index < count; ++index) {
        lua_rawgeti(state, -1, static_cast<int>(index + 1));
        luaL_checktype(state, -1, LUA_TTABLE);
        lua_getfield(state, -1, "algorithm");
        hashes[hash_count].algorithm = luaL_checkstring(state, -1);
        lua_pop(state, 1);
        lua_getfield(state, -1, "value");
        hashes[hash_count].value.data = reinterpret_cast<const std::uint8_t*>(
            luaL_checklstring(state, -1, &hashes[hash_count].value.size));
        lua_pop(state, 2);
        ++hash_count;
      }
    } else if (!lua_isnil(state, -1)) {
      return luaL_error(state, "server_certificate_hashes must be a table");
    }
    lua_pop(state, 1);
    lua_getfield(state, 2, "anticipated_incoming_unidirectional_streams");
    if (lua_isnumber(state, -1)) {
      const lua_Number value = lua_tonumber(state, -1);
      if (!std::isfinite(static_cast<double>(value)) || value < 0 || value > UINT16_MAX ||
          value != static_cast<std::uint16_t>(value)) {
        return luaL_error(state, "anticipated incoming unidirectional streams must be an unsigned 16-bit integer");
      }
      anticipated_uni = static_cast<std::uint16_t>(value);
    } else if (!lua_isnil(state, -1)) {
      return luaL_error(state, "anticipated incoming unidirectional streams must be a number");
    }
    lua_pop(state, 1);
    lua_getfield(state, 2, "anticipated_incoming_bidirectional_streams");
    if (lua_isnumber(state, -1)) {
      const lua_Number value = lua_tonumber(state, -1);
      if (!std::isfinite(static_cast<double>(value)) || value < 0 || value > UINT16_MAX ||
          value != static_cast<std::uint16_t>(value)) {
        return luaL_error(state, "anticipated incoming bidirectional streams must be an unsigned 16-bit integer");
      }
      anticipated_bidi = static_cast<std::uint16_t>(value);
    } else if (!lua_isnil(state, -1)) {
      return luaL_error(state, "anticipated incoming bidirectional streams must be a number");
    }
    lua_pop(state, 1);
  }

  auto* context = new (std::nothrow) LuaCallbackContext;
  if (context == nullptr) return luaL_error(state, "unable to allocate WebTransport callback context");
  context->callback = dmScript::CreateCallback(state, callback_index);
  if (context->callback == nullptr) {
    delete context;
    return luaL_error(state, "unable to retain WebTransport callback for this script instance");
  }
  lua_newtable(state);
  context->stream_table_ref = luaL_ref(state, LUA_REGISTRYINDEX);
  DefoldWebTransportOptions options{};
  options.abi_version = DEFOLD_WEBTRANSPORT_CLIENT_ABI_VERSION;
  options.struct_size = sizeof(options);
  options.url = url;
  options.certificate_hashes = hashes.data();
  options.certificate_hash_count = hash_count;
  options.anticipated_incoming_unidirectional_streams = anticipated_uni;
  options.anticipated_incoming_bidirectional_streams = anticipated_bidi;
  options.callback = LuaEventCallback;
  options.user_data = context;
  auto* session = defold_webtransport_connect(&options);
  if (session == nullptr) {
    luaL_unref(state, LUA_REGISTRYINDEX, context->stream_table_ref);
    dmScript::DestroyCallback(context->callback);
    delete context;
    return luaL_error(state, "unable to create WebTransport session; native targets require a SHA-256 certificate hash");
  }
  PushSession(state, session, context, true);
  Release(context);
  return 1;
}

int LuaClose(lua_State* state) {
  auto* value = CheckSession(state, 1);
  const std::uint32_t code = OptionalCode(state, 2);
  const char* reason = lua_isnoneornil(state, 3) ? "" : luaL_checkstring(state, 3);
  defold_webtransport_close(value->session, code, reason);
  return 0;
}

int LuaCreateBidirectionalStream(lua_State* state) {
  lua_pushboolean(state, defold_webtransport_create_bidirectional_stream(CheckSession(state, 1)->session));
  return 1;
}

int LuaCreateUnidirectionalStream(lua_State* state) {
  lua_pushboolean(state, defold_webtransport_create_unidirectional_stream(CheckSession(state, 1)->session));
  return 1;
}

int LuaWrite(lua_State* state) {
  auto* value = CheckStream(state, 1);
  if (!value->write_open) return luaL_error(state, "defold_webtransport stream is not writable");
  DefoldWebTransportBytes bytes{};
  bytes.data = reinterpret_cast<const std::uint8_t*>(luaL_checklstring(state, 2, &bytes.size));
  const bool fin = lua_toboolean(state, 3) != 0;
  const bool accepted = defold_webtransport_stream_write(value->stream, bytes, fin);
  if (accepted && fin) MarkStreamTerminal(state, value->context, value->stream, false, true);
  lua_pushboolean(state, accepted);
  return 1;
}

int LuaResetStream(lua_State* state) {
  auto* value = CheckStream(state, 1);
  if (!value->write_open) return luaL_error(state, "defold_webtransport stream is not writable");
  const bool accepted = defold_webtransport_stream_reset(value->stream, OptionalCode(state, 2));
  if (accepted) MarkStreamTerminal(state, value->context, value->stream, false, true);
  lua_pushboolean(state, accepted);
  return 1;
}

int LuaStopSending(lua_State* state) {
  auto* value = CheckStream(state, 1);
  if (!value->read_open) return luaL_error(state, "defold_webtransport stream is not readable");
  const bool accepted = defold_webtransport_stream_stop_sending(value->stream, OptionalCode(state, 2));
  if (accepted) MarkStreamTerminal(state, value->context, value->stream, true, false);
  lua_pushboolean(state, accepted);
  return 1;
}

int LuaSendDatagram(lua_State* state) {
  auto* session = CheckSession(state, 1);
  DefoldWebTransportBytes bytes{};
  bytes.data = reinterpret_cast<const std::uint8_t*>(luaL_checklstring(state, 2, &bytes.size));
  lua_pushboolean(state, defold_webtransport_send_datagram(session->session, bytes));
  return 1;
}

int LuaMaxDatagramSize(lua_State* state) {
  lua_pushnumber(state, static_cast<lua_Number>(
      defold_webtransport_max_datagram_size(CheckSession(state, 1)->session)));
  return 1;
}

void RegisterUserTypes(lua_State* state) {
  const luaL_Reg session_meta[] = {{"__gc", SessionGc}, {nullptr, nullptr}};
  const luaL_Reg stream_meta[] = {{"__gc", StreamGc}, {nullptr, nullptr}};
  luaL_newmetatable(state, kSessionType);
  luaL_register(state, nullptr, session_meta);
  lua_pushvalue(state, -1);
  lua_setfield(state, -2, "__index");
  lua_pop(state, 1);
  luaL_newmetatable(state, kStreamType);
  luaL_register(state, nullptr, stream_meta);
  lua_pushvalue(state, -1);
  lua_setfield(state, -2, "__index");
  lua_pop(state, 1);
}

dmExtension::Result Initialize(dmExtension::Params* params) {
  RegisterUserTypes(params->m_L);
  const luaL_Reg methods[] = {
#include <defold_webtransport/generated_lua_methods.inc>
  };
  luaL_register(params->m_L, LIB_NAME, methods);
  lua_pop(params->m_L, 1);
  return dmExtension::RESULT_OK;
}

dmExtension::Result Update(dmExtension::Params*) {
  (void)defold_webtransport_pump_callbacks();
  return dmExtension::RESULT_OK;
}

dmExtension::Result Finalize(dmExtension::Params*) { return dmExtension::RESULT_OK; }

}  // namespace

DM_DECLARE_EXTENSION(defold_webtransport, LIB_NAME, 0, 0, Initialize, Update, 0, Finalize)
