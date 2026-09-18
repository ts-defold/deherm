#include <defold_hermes/component_hermes_backend.hpp>
#include <defold_hermes/script_scalar_lua_adapter.hpp>

#if !defined(DM_PLATFORM_HTML5)

#include <dmsdk/dlib/hash.h>
#include <dmsdk/dlib/message.h>
#include <dmsdk/dlib/vmath.h>

#include <array>
#include <cstdio>
#include <cstring>
#include <exception>
#include <stdexcept>

namespace dmScript {
bool IsHash(lua_State*, int);
bool IsURL(lua_State*, int);
bool IsVector3(lua_State*, int);
bool IsVector4(lua_State*, int);
bool IsQuat(lua_State*, int);
dmhash_t* ToHash(lua_State*, int);
dmMessage::URL* ToURL(lua_State*, int);
dmVMath::Vector3* ToVector3(lua_State*, int);
dmVMath::Vector4* ToVector4(lua_State*, int);
dmVMath::Quat* ToQuat(lua_State*, int);
}

namespace defold_hermes::component_proxy {
namespace {
using Value = Runtime::ComponentValue;
using Kind = Runtime::ComponentValueKind;

void fail(char* error, size_t capacity, const char* message) noexcept {
  if (error && capacity) std::snprintf(error, capacity, "%s", message ? message : "component backend failed");
}

bool encodeLeaf(lua_State* state, int index, uint8_t codec, Value* output) noexcept {
  *output = {};
  if (lua_isnil(state, index)) { output->kind = Kind::kNil; return true; }
  if (codec == 1 || (codec == 0 && lua_isnumber(state, index))) {
    if (!lua_isnumber(state, index)) return false; output->kind = Kind::kNumber; output->number = lua_tonumber(state, index); return true;
  }
  if (codec == 2 || (codec == 0 && lua_isboolean(state, index))) {
    if (!lua_isboolean(state, index)) return false; output->kind = Kind::kBoolean; output->boolean = lua_toboolean(state, index) != 0; return true;
  }
  if (codec == 3 || (codec == 0 && lua_isstring(state, index))) {
    if (!lua_isstring(state, index)) return false; size_t length = 0; output->string = lua_tolstring(state, index, &length);
    if (length > UINT32_MAX) return false; output->kind = Kind::kString; output->stringLength = static_cast<uint32_t>(length); return true;
  }
  if (codec == 0 && dmScript::IsHash(state, index)) {
    auto* hash = dmScript::ToHash(state, index);
    if (!hash) return false;
    output->kind = Kind::kHash;
    output->lanes64[0] = *hash;
    return true;
  }
  if (codec == 0 && dmScript::IsURL(state, index)) {
    auto* url = dmScript::ToURL(state, index);
    if (!url) return false;
    output->kind = Kind::kUrl;
    output->lanes64[0] = url->m_Socket;
    output->lanes64[1] = url->_reserved;
    output->lanes64[2] = url->m_Path;
    output->lanes64[3] = url->m_Fragment;
    return true;
  }
  if (codec == 0 && dmScript::IsVector3(state, index)) {
    auto* value = dmScript::ToVector3(state, index);
    if (!value) return false;
    output->kind = Kind::kVector3;
    output->lanes32[0] = value->getX();
    output->lanes32[1] = value->getY();
    output->lanes32[2] = value->getZ();
    return true;
  }
  if (codec == 0 && dmScript::IsVector4(state, index)) {
    auto* value = dmScript::ToVector4(state, index);
    if (!value) return false;
    output->kind = Kind::kVector4;
    output->lanes32[0] = value->getX();
    output->lanes32[1] = value->getY();
    output->lanes32[2] = value->getZ();
    output->lanes32[3] = value->getW();
    return true;
  }
  if (codec == 0 && dmScript::IsQuat(state, index)) {
    auto* value = dmScript::ToQuat(state, index);
    if (!value) return false;
    output->kind = Kind::kQuaternion;
    output->lanes32[0] = value->getX();
    output->lanes32[1] = value->getY();
    output->lanes32[2] = value->getZ();
    output->lanes32[3] = value->getW();
    return true;
  }
  if (codec == 4 || codec == 9) {
    if (auto* hash = dmScript::ToHash(state, index)) { output->kind = Kind::kHash; output->lanes64[0] = *hash; return true; }
    if (lua_isstring(state, index)) { size_t length = 0; output->string = lua_tolstring(state, index, &length); output->kind = Kind::kString; output->stringLength = static_cast<uint32_t>(length); return true; }
    return false;
  }
  if (codec == 5) {
    auto* url = dmScript::ToURL(state, index); if (!url) return false; output->kind = Kind::kUrl;
    output->lanes64[0] = url->m_Socket; output->lanes64[1] = url->_reserved; output->lanes64[2] = url->m_Path; output->lanes64[3] = url->m_Fragment; return true;
  }
  if (codec == 6) {
    auto* value = dmScript::ToVector3(state, index); if (!value) return false; output->kind = Kind::kVector3;
    output->lanes32[0] = value->getX(); output->lanes32[1] = value->getY(); output->lanes32[2] = value->getZ(); return true;
  }
  if (codec == 7) {
    auto* value = dmScript::ToVector4(state, index); if (!value) return false; output->kind = Kind::kVector4;
    output->lanes32[0] = value->getX(); output->lanes32[1] = value->getY(); output->lanes32[2] = value->getZ(); output->lanes32[3] = value->getW(); return true;
  }
  if (codec == 8) {
    auto* value = dmScript::ToQuat(state, index); if (!value) return false; output->kind = Kind::kQuaternion;
    output->lanes32[0] = value->getX(); output->lanes32[1] = value->getY(); output->lanes32[2] = value->getZ(); output->lanes32[3] = value->getW(); return true;
  }
  return false;
}

struct EventCodecScratch {
  static constexpr size_t kFieldCapacity = 256;
  static constexpr size_t kElementCapacity = 256;
  static constexpr uint8_t kDepthCapacity = 8;
  std::array<Runtime::ComponentField, kFieldCapacity> fields{};
  std::array<Value, kElementCapacity> elements{};
  size_t fieldsUsed = 0;
  size_t elementsUsed = 0;
};

bool encodeValue(lua_State* state, int index, Value* output,
    EventCodecScratch* scratch, uint8_t depth) noexcept {
  *output = {};
  if (!lua_istable(state, index)) return encodeLeaf(state, index, 0, output);
  if (!scratch || depth == EventCodecScratch::kDepthCapacity) return false;

  const int absolute = index > 0 ? index : lua_gettop(state) + index + 1;
  size_t count = 0;
  bool stringKeys = true;
  bool arrayKeys = true;
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    ++count;
    stringKeys = stringKeys && lua_type(state, -2) == LUA_TSTRING;
    if (lua_type(state, -2) != LUA_TNUMBER) {
      arrayKeys = false;
    } else {
      const lua_Number numeric = lua_tonumber(state, -2);
      const lua_Integer integer = lua_tointeger(state, -2);
      if (numeric != static_cast<lua_Number>(integer) || integer < 1) arrayKeys = false;
    }
    lua_pop(state, 1);
  }
  if (count > UINT16_MAX || (!stringKeys && !arrayKeys)) return false;

  if (arrayKeys && count != 0) {
    if (scratch->elementsUsed > scratch->elements.size() ||
        count > scratch->elements.size() - scratch->elementsUsed) return false;
    Value* elements = scratch->elements.data() + scratch->elementsUsed;
    scratch->elementsUsed += count;
    for (size_t child = 0; child < count; ++child) {
      lua_rawgeti(state, absolute, static_cast<int>(child + 1));
      if (lua_isnil(state, -1) || !encodeValue(state, -1, &elements[child], scratch, depth + 1)) {
        lua_pop(state, 1);
        return false;
      }
      lua_pop(state, 1);
    }
    output->kind = Kind::kArray;
    output->elements = elements;
    output->childCount = static_cast<uint16_t>(count);
    return true;
  }

  if (scratch->fieldsUsed > scratch->fields.size() ||
      count > scratch->fields.size() - scratch->fieldsUsed) return false;
  Runtime::ComponentField* fields = scratch->fields.data() + scratch->fieldsUsed;
  scratch->fieldsUsed += count;
  size_t child = 0;
  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    fields[child].name = lua_tostring(state, -2);
    if (!fields[child].name || !encodeValue(state, -1, &fields[child].value, scratch, depth + 1)) {
      lua_pop(state, 2);
      return false;
    }
    ++child;
    lua_pop(state, 1);
  }
  output->kind = Kind::kObject;
  output->fields = fields;
  output->childCount = static_cast<uint16_t>(count);
  return true;
}

bool encodeArgument(lua_State* state, int index, Runtime::ComponentArgument* output,
    EventCodecScratch* scratch) noexcept {
  *output = {};
  if (!encodeValue(state, index, &output->value, scratch, 0)) return false;
  if (output->value.kind == Kind::kObject) {
    output->fields = output->value.fields;
    output->fieldCount = output->value.childCount;
  }
  return true;
}

Runtime::ComponentContext context(ContextKind value) noexcept {
  return value == ContextKind::kGameObject ? Runtime::ComponentContext::kGameObject :
      value == ContextKind::kGuiScene ? Runtime::ComponentContext::kGuiScene : Runtime::ComponentContext::kRender;
}

lua_bridge::scalar::ScriptAdapter::ComponentContext adapterContext(ContextKind value) noexcept {
  using AdapterContext = lua_bridge::scalar::ScriptAdapter::ComponentContext;
  return value == ContextKind::kGameObject ? AdapterContext::kGameObject :
      value == ContextKind::kGuiScene ? AdapterContext::kGui : AdapterContext::kRender;
}
}

BackendApi HermesBackend::api() noexcept { return {this, Revision, Attach, Dispatch, Detach}; }

uint32_t HermesBackend::Revision(void* opaque) noexcept {
  auto* backend = static_cast<HermesBackend*>(opaque);
  if (Runtime* runtime = backend->runtime()) return runtime->identity();
  return 0;
}

bool HermesBackend::Attach(void* opaque, const AttachRequest& request, ComponentHandle* output,
    char* error, size_t capacity) noexcept {
  auto* backend = static_cast<HermesBackend*>(opaque);
  if (backend->ensureRuntime_ && !backend->ensureRuntime_(backend->context_, request.state)) {
    fail(error, capacity, "Hermes component runtime or script bridge initialization failed");
    return false;
  }
  Runtime* runtime = backend->runtime();
  if (!runtime || !output) { fail(error, capacity, "Hermes component runtime is unavailable"); return false; }
  Runtime::ComponentHandle handle{};
  try {
    if (backend->adapterProvider_) {
      auto* adapter = backend->adapter();
      if (!adapter || !adapter->ensureComponentFallbackInstance(
          request.selfIndex, adapterContext(request.context))) {
        throw std::runtime_error("Component could not establish a bounded script-API context");
      }
    }
    handle = runtime->attachComponent(request.componentId, request.schemaFingerprint, context(request.context));
    const int specifications = request.propertySpecializationsIndex;
    const size_t count = lua_objlen(request.state, specifications);
    if (count > 32) throw std::runtime_error("Component has more than 32 specialized properties");
    for (size_t slot = 1; slot <= count; ++slot) {
      lua_rawgeti(request.state, specifications, static_cast<int>(slot));
      if (!lua_istable(request.state, -1)) throw std::runtime_error("Component property specialization is not a tuple");
      lua_rawgeti(request.state, -1, 1);
      const char* name = lua_tostring(request.state, -1);
      if (!name) throw std::runtime_error("Component property specialization has no string name");
      lua_rawgeti(request.state, -2, 2);
      const uint8_t codec = static_cast<uint8_t>(lua_tointeger(request.state, -1));
      lua_pop(request.state, 1);
      lua_pushvalue(request.state, -1);
      lua_rawget(request.state, request.selfIndex);
      Value value{}; const bool encoded = encodeLeaf(request.state, -1, codec, &value); lua_pop(request.state, 3);
      if (!encoded) throw std::runtime_error("Component editor property does not match its generated codec");
      runtime->setComponentProperty(handle, name, value);
    }
  } catch (const std::exception& exception) {
    if (handle) runtime->detachComponent(handle); fail(error, capacity, exception.what()); return false;
  }
  *output = {handle.slot, handle.generation}; return true;
}

bool HermesBackend::Dispatch(void* opaque, const DispatchRequest& request, bool* consumed,
    char* error, size_t capacity) noexcept {
  auto* backend = static_cast<HermesBackend*>(opaque); Runtime* runtime = backend->runtime();
  if (!runtime) { fail(error, capacity, "Hermes component runtime is unavailable"); return false; }
  auto* adapter = backend->adapter();
  if (backend->adapterProvider_ &&
      (!adapter || !adapter->pushComponentContext(adapterContext(request.context)))) {
    fail(error, capacity, adapter ? adapter->lastError() : "Component script adapter is unavailable");
    return false;
  }
  try {
    Runtime::ComponentHandle handle{request.handle.slot, request.handle.generation};
    if (request.event == EventKind::kReload) {
      runtime->reloadComponent(handle);
      if (adapter) adapter->popComponentContext();
      return true;
    }
    std::array<Runtime::ComponentArgument, 4> arguments{};
    EventCodecScratch scratch{};
    if (request.argumentCount > arguments.size()) throw std::runtime_error("Component event has too many arguments");
    for (uint8_t index = 0; index < request.argumentCount; ++index)
      if (!encodeArgument(request.state, request.argumentStart + index, &arguments[index], &scratch))
        throw std::runtime_error("Component event value exceeds the bounded recursive codec (256 fields, 256 elements, depth 8)");
    const bool result = runtime->dispatchComponent(handle, request.lifecycle, arguments.data(), request.argumentCount);
    if (adapter) adapter->popComponentContext();
    if (consumed) *consumed = result;
    return true;
  } catch (const std::exception& exception) {
    if (adapter) adapter->popComponentContext();
    fail(error, capacity, exception.what()); return false;
  }
}

void HermesBackend::Detach(void* opaque, ComponentHandle handle) noexcept {
  auto* backend = static_cast<HermesBackend*>(opaque);
  if (Runtime* runtime = backend->runtime()) runtime->detachComponent({handle.slot, handle.generation});
}

}  // namespace defold_hermes::component_proxy
#endif
