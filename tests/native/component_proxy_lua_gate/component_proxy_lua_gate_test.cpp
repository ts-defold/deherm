#include <defold_hermes/component_proxy_lua_gate.hpp>

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" {
#include <lua/lualib.h>
}

namespace component = defold_hermes::component_proxy;

namespace {
#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); return 1; } } while (false)

struct AllocatorStats { uint64_t calls = 0; bool track = false; };
void* Allocator(void* user, void* pointer, size_t, size_t size) {
  auto* stats = static_cast<AllocatorStats*>(user);
  if (size == 0) { std::free(pointer); return nullptr; }
  if (stats->track) ++stats->calls;
  return std::realloc(pointer, size);
}

int gCurrentKey;
void GetInstance(lua_State* state) { lua_pushlightuserdata(state, &gCurrentKey); lua_rawget(state, LUA_REGISTRYINDEX); }
void SetInstance(lua_State* state) { lua_pushlightuserdata(state, &gCurrentKey); lua_insert(state, -2); lua_rawset(state, LUA_REGISTRYINDEX); }
bool CurrentIsNil(lua_State* state) { GetInstance(state); const bool result = lua_isnil(state, -1); lua_pop(state, 1); return result; }

struct Backend {
  uint32_t revision = 1;
  uint32_t nextSlot = 1;
  uint32_t attaches = 0;
  uint32_t dispatches = 0;
  uint32_t reloads = 0;
  uint32_t detaches = 0;
  uint32_t propertyRows = 0;
  bool failNextAttach = false;
  bool failNext = false;
  bool sawGame = false;
  bool sawGui = false;
  bool sawRender = false;
};

uint32_t Revision(void* opaque) noexcept { return static_cast<Backend*>(opaque)->revision; }

bool Attach(void* opaque, const component::AttachRequest& request,
    component::ComponentHandle* output, char* error, size_t capacity) noexcept {
  auto& backend = *static_cast<Backend*>(opaque);
  if (!request.componentId || !request.schemaFingerprint || !lua_istable(request.state, request.selfIndex) ||
      !lua_istable(request.state, request.propertySpecializationsIndex)) {
    std::snprintf(error, capacity, "bad attach request"); return false;
  }
  if (backend.failNextAttach) {
    backend.failNextAttach = false;
    std::snprintf(error, capacity, "injected rebind failure");
    return false;
  }
  backend.propertyRows += static_cast<uint32_t>(lua_objlen(request.state, request.propertySpecializationsIndex));
  if (request.context == component::ContextKind::kGameObject) backend.sawGame = true;
  if (request.context == component::ContextKind::kGuiScene) backend.sawGui = true;
  if (request.context == component::ContextKind::kRender) backend.sawRender = true;
  *output = {backend.nextSlot++, 1}; ++backend.attaches; return true;
}

bool Dispatch(void* opaque, const component::DispatchRequest& request, bool* consumed,
    char* error, size_t capacity) noexcept {
  auto& backend = *static_cast<Backend*>(opaque);
  GetInstance(request.state);
  const bool hasInstance = !lua_isnil(request.state, -1);
  lua_pop(request.state, 1);
  if (!hasInstance) { std::snprintf(error, capacity, "component instance scope is nil"); return false; }
  if (backend.failNext) { backend.failNext = false; std::snprintf(error, capacity, "injected component failure"); return false; }
  if (request.event == component::EventKind::kReload) ++backend.reloads;
  if (request.event == component::EventKind::kInput && consumed) *consumed = true;
  ++backend.dispatches;
  return true;
}

void Detach(void* opaque, component::ComponentHandle) noexcept { ++static_cast<Backend*>(opaque)->detaches; }

bool Run(lua_State* state, const char* source) {
  if (luaL_loadstring(state, source) != 0) { std::fprintf(stderr, "lua load: %s\n", lua_tostring(state, -1)); return false; }
  if (lua_pcall(state, 0, 0, 0) != 0) { std::fprintf(stderr, "lua run: %s\n", lua_tostring(state, -1)); return false; }
  return true;
}
}

int main() {
  AllocatorStats allocator;
  lua_State* state = lua_newstate(Allocator, &allocator);
  CHECK(state != nullptr);
  luaL_openlibs(state);
  Backend backend;
  component::LuaRuntime runtime(
      {&backend, Revision, Attach, Dispatch, Detach}, {GetInstance, SetInstance});
  CHECK(runtime.valid());
  runtime.registerLuaApi(state);
  CHECK(CurrentIsNil(state));

  CHECK(Run(state, R"LUA(
    goSelf = { speed = 120, enabled = true }
    guiSelf = {}
    renderSelf = {}
    assert(defold_hermes.attachComponent(goSelf, "go", "0123456789012345678901234567890123456789012345678901234567890123", "game-object", {{"speed",1},{"enabled",2}}))
    assert(defold_hermes.attachComponent(guiSelf, "gui", "1123456789012345678901234567890123456789012345678901234567890123", "gui-scene", {}))
    assert(defold_hermes.attachComponent(renderSelf, "render", "2123456789012345678901234567890123456789012345678901234567890123", "render-instance+graphics", {}))
    defold_hermes.dispatchLifecycle(goSelf, "go", "init")
    defold_hermes.dispatchLifecycle(guiSelf, "gui", "update", 0.25)
    defold_hermes.dispatchMessage(renderSelf, "render", 17, { value = 4 }, "sender")
    assert(defold_hermes.dispatchInput(goSelf, "go", 19, { pressed = true }))
    defold_hermes.dispatchReload(goSelf, "go")
  )LUA"));
  CHECK(runtime.live() == 3 && backend.attaches == 3 && backend.propertyRows == 2);
  CHECK(backend.dispatches == 5 && backend.reloads == 1);
  CHECK(backend.sawGame && backend.sawGui && backend.sawRender && CurrentIsNil(state));

  backend.failNext = true;
  CHECK(Run(state, R"LUA(
    local ok, error = pcall(defold_hermes.dispatchLifecycle, goSelf, "go", "update", 0.5)
    assert(not ok and string.find(error, "injected component failure", 1, true))
    defold_hermes.dispatchLifecycle(goSelf, "go", "update", 0.5)
  )LUA"));
  CHECK(CurrentIsNil(state));

  backend.revision = 2;
  backend.failNextAttach = true;
  CHECK(Run(state, R"LUA(
    local ok, error = pcall(defold_hermes.dispatchReload, goSelf, "go")
    assert(not ok and string.find(error, "injected rebind failure", 1, true))
    defold_hermes.dispatchReload(goSelf, "go")
    defold_hermes.dispatchLifecycle(goSelf, "go", "update", 0.5)
  )LUA"));
  CHECK(backend.attaches == 4 && backend.propertyRows == 4 && backend.reloads == 2);
  CHECK(CurrentIsNil(state));

  CHECK(Run(state, "function warmedDispatch() defold_hermes.dispatchLifecycle(goSelf, 'go', 'update', 0.1) end; warmedDispatch()"));
  const uint64_t before = allocator.calls;
  allocator.track = true;
  for (uint32_t index = 0; index < 1024; ++index) {
    lua_getglobal(state, "warmedDispatch");
    CHECK(lua_pcall(state, 0, 0, 0) == 0);
  }
  allocator.track = false;
  CHECK(allocator.calls == before);

  CHECK(Run(state, R"LUA(
    churnSelf = {}
    churnProperties = {}
    function warmedAttachDetach()
      assert(defold_hermes.attachComponent(churnSelf, "churn", "3123456789012345678901234567890123456789012345678901234567890123", "game-object", churnProperties))
      assert(defold_hermes.detachComponent(churnSelf, "churn"))
    end
    warmedAttachDetach()
  )LUA"));
  const uint64_t beforeChurn = allocator.calls;
  const uint32_t detachBeforeChurn = backend.detaches;
  allocator.track = true;
  for (uint32_t index = 0; index < 1024; ++index) {
    lua_getglobal(state, "warmedAttachDetach");
    CHECK(lua_pcall(state, 0, 0, 0) == 0);
  }
  allocator.track = false;
  CHECK(allocator.calls == beforeChurn);
  CHECK(backend.detaches == detachBeforeChurn + 1024);

  const uint32_t detachBeforeFinal = backend.detaches;
  CHECK(Run(state, R"LUA(
    assert(defold_hermes.detachComponent(goSelf, "go"))
    assert(defold_hermes.detachComponent(goSelf, "go"))
    assert(defold_hermes.detachComponent(guiSelf, "gui"))
    assert(defold_hermes.detachComponent(renderSelf, "render"))
  )LUA"));
  CHECK(runtime.live() == 0 && backend.detaches == detachBeforeFinal + 1);
  runtime.shutdown();
  lua_close(state);
  std::puts("component-proxy-lua-runtime:contexts:3:ok");
  std::puts("component-proxy-lua-runtime:lifecycle-message-input-reload-detach:ok");
  std::puts("component-proxy-lua-runtime:nil-scope-recovery:ok");
  std::puts("component-proxy-lua-runtime:runtime-rebind-retry:ok");
  std::puts("component-proxy-lua-runtime:lua-allocations-warmed:0");
  std::puts("component-proxy-lua-runtime:attachment-churn-lua-allocations:0");
  return 0;
}
