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

void PushHash(lua_State* state, dmhash_t hash) {
  *static_cast<dmhash_t*>(lua_newuserdata(state, sizeof(dmhash_t))) = hash;
}

dmhash_t* ToHash(lua_State* state, int index) {
  return lua_isuserdata(state, index)
      ? static_cast<dmhash_t*>(lua_touserdata(state, index))
      : nullptr;
}

void PushVector3(lua_State* state, const dmVMath::Vector3& value) {
  *static_cast<dmVMath::Vector3*>(lua_newuserdata(state, sizeof(dmVMath::Vector3))) = value;
}

void PushVector4(lua_State* state, const dmVMath::Vector4& value) {
  *static_cast<dmVMath::Vector4*>(lua_newuserdata(state, sizeof(dmVMath::Vector4))) = value;
}

void PushQuat(lua_State* state, const dmVMath::Quat& value) {
  *static_cast<dmVMath::Quat*>(lua_newuserdata(state, sizeof(dmVMath::Quat))) = value;
}

void PushMatrix4(lua_State* state, const dmVMath::Matrix4& value) {
  *static_cast<dmVMath::Matrix4*>(lua_newuserdata(state, sizeof(dmVMath::Matrix4))) = value;
}

void PushURL(lua_State* state, const dmMessage::URL& value) {
  *static_cast<dmMessage::URL*>(lua_newuserdata(state, sizeof(dmMessage::URL))) = value;
}

dmVMath::Vector3* ToVector3(lua_State* state, int index) {
  return lua_isuserdata(state, index)
      ? static_cast<dmVMath::Vector3*>(lua_touserdata(state, index))
      : nullptr;
}

dmVMath::Vector4* ToVector4(lua_State* state, int index) {
  return lua_isuserdata(state, index)
      ? static_cast<dmVMath::Vector4*>(lua_touserdata(state, index))
      : nullptr;
}

dmVMath::Quat* ToQuat(lua_State* state, int index) {
  return lua_isuserdata(state, index)
      ? static_cast<dmVMath::Quat*>(lua_touserdata(state, index))
      : nullptr;
}

dmVMath::Matrix4* ToMatrix4(lua_State* state, int index) {
  return lua_isuserdata(state, index)
      ? static_cast<dmVMath::Matrix4*>(lua_touserdata(state, index))
      : nullptr;
}

dmMessage::URL* ToURL(lua_State* state, int index) {
  return lua_isuserdata(state, index)
      ? static_cast<dmMessage::URL*>(lua_touserdata(state, index))
      : nullptr;
}

}  // namespace dmScript
