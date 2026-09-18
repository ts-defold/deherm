#include <dmsdk/dlib/vmath.h>
#include <dmsdk/dlib/message.h>
#include <dlib/hash.h>

extern "C" {
#include <dmsdk/lua/lauxlib.h>
}

// Standalone Hermes tests link Lua itself, not the complete Defold script
// runtime. These helpers preserve the POD userdata representation needed by
// the generated structured-Lua adapter. Packaged-engine tests use Defold's
// real implementations instead.
namespace dmScript {
namespace {
constexpr const char* kHash = "deherm.test.hash";
constexpr const char* kVector3 = "deherm.test.vector3";
constexpr const char* kVector4 = "deherm.test.vector4";
constexpr const char* kQuat = "deherm.test.quat";
constexpr const char* kMatrix4 = "deherm.test.matrix4";
constexpr const char* kUrl = "deherm.test.url";

void assignMetatable(lua_State* state, const char* name) {
  luaL_newmetatable(state, name);
  lua_setmetatable(state, -2);
}

void* typedUserdata(lua_State* state, int index, const char* name) {
  if (!lua_isuserdata(state, index) || !lua_getmetatable(state, index)) return nullptr;
  luaL_getmetatable(state, name);
  const bool matches = lua_rawequal(state, -1, -2) != 0;
  lua_pop(state, 2);
  return matches ? lua_touserdata(state, index) : nullptr;
}
}  // namespace

void PushHash(lua_State* state, dmhash_t hash) {
  *static_cast<dmhash_t*>(lua_newuserdata(state, sizeof(dmhash_t))) = hash;
  assignMetatable(state, kHash);
}

dmhash_t* ToHash(lua_State* state, int index) {
  return static_cast<dmhash_t*>(typedUserdata(state, index, kHash));
}

bool IsHash(lua_State* state, int index) { return ToHash(state, index) != nullptr; }

void PushVector3(lua_State* state, const dmVMath::Vector3& value) {
  *static_cast<dmVMath::Vector3*>(lua_newuserdata(state, sizeof(dmVMath::Vector3))) = value;
  assignMetatable(state, kVector3);
}

void PushVector4(lua_State* state, const dmVMath::Vector4& value) {
  *static_cast<dmVMath::Vector4*>(lua_newuserdata(state, sizeof(dmVMath::Vector4))) = value;
  assignMetatable(state, kVector4);
}

void PushQuat(lua_State* state, const dmVMath::Quat& value) {
  *static_cast<dmVMath::Quat*>(lua_newuserdata(state, sizeof(dmVMath::Quat))) = value;
  assignMetatable(state, kQuat);
}

void PushMatrix4(lua_State* state, const dmVMath::Matrix4& value) {
  *static_cast<dmVMath::Matrix4*>(lua_newuserdata(state, sizeof(dmVMath::Matrix4))) = value;
  assignMetatable(state, kMatrix4);
}

void PushURL(lua_State* state, const dmMessage::URL& value) {
  *static_cast<dmMessage::URL*>(lua_newuserdata(state, sizeof(dmMessage::URL))) = value;
  assignMetatable(state, kUrl);
}

dmVMath::Vector3* ToVector3(lua_State* state, int index) {
  return static_cast<dmVMath::Vector3*>(typedUserdata(state, index, kVector3));
}

bool IsVector3(lua_State* state, int index) { return ToVector3(state, index) != nullptr; }

dmVMath::Vector4* ToVector4(lua_State* state, int index) {
  return static_cast<dmVMath::Vector4*>(typedUserdata(state, index, kVector4));
}

bool IsVector4(lua_State* state, int index) { return ToVector4(state, index) != nullptr; }

dmVMath::Quat* ToQuat(lua_State* state, int index) {
  return static_cast<dmVMath::Quat*>(typedUserdata(state, index, kQuat));
}

bool IsQuat(lua_State* state, int index) { return ToQuat(state, index) != nullptr; }

dmVMath::Matrix4* ToMatrix4(lua_State* state, int index) {
  return static_cast<dmVMath::Matrix4*>(typedUserdata(state, index, kMatrix4));
}

dmMessage::URL* ToURL(lua_State* state, int index) {
  return static_cast<dmMessage::URL*>(typedUserdata(state, index, kUrl));
}

bool IsURL(lua_State* state, int index) { return ToURL(state, index) != nullptr; }

}  // namespace dmScript
