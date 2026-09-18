// Compile-only signature audit. It intentionally takes no action and produces
// unresolved references; the policy report makes no link/behavior claim.
#include <dmsdk/dlib/profile.h>
#include <dmsdk/dlib/thread.h>
#include <dmsdk/gameobject/gameobject.h>
#include <dmsdk/sound/sound.h>

namespace {
[[maybe_unused]] auto* const kCreateInstanceId = &dmGameObject::CreateInstanceId;
[[maybe_unused]] auto* const kIsGroupMuted = &dmSound::IsGroupMuted;
[[maybe_unused]] auto* const kAllocTls = &dmThread::AllocTls;
[[maybe_unused]] auto* const kDetach = &dmThread::Detach;
[[maybe_unused]] auto* const kFreeTls = &dmThread::FreeTls;
[[maybe_unused]] auto* const kGetCurrentThread = &dmThread::GetCurrentThread;
[[maybe_unused]] auto* const kJoin = &dmThread::Join;
[[maybe_unused]] auto* const kProfilePropertyAddBool = &ProfilePropertyAddBool;
[[maybe_unused]] auto* const kProfilePropertyAddF32 = &ProfilePropertyAddF32;
[[maybe_unused]] auto* const kProfilePropertyAddF64 = &ProfilePropertyAddF64;
[[maybe_unused]] auto* const kProfilePropertyAddS32 = &ProfilePropertyAddS32;
[[maybe_unused]] auto* const kProfilePropertyAddS64 = &ProfilePropertyAddS64;
[[maybe_unused]] auto* const kProfilePropertyAddU32 = &ProfilePropertyAddU32;
[[maybe_unused]] auto* const kProfilePropertyAddU64 = &ProfilePropertyAddU64;
[[maybe_unused]] auto* const kProfilePropertySetBool = &ProfilePropertySetBool;
[[maybe_unused]] auto* const kProfilePropertySetF32 = &ProfilePropertySetF32;
[[maybe_unused]] auto* const kProfilePropertySetF64 = &ProfilePropertySetF64;
[[maybe_unused]] auto* const kProfilePropertySetS32 = &ProfilePropertySetS32;
[[maybe_unused]] auto* const kProfilePropertySetS64 = &ProfilePropertySetS64;
[[maybe_unused]] auto* const kProfilePropertySetU32 = &ProfilePropertySetU32;
[[maybe_unused]] auto* const kProfilePropertySetU64 = &ProfilePropertySetU64;
}
