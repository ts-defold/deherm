#pragma once

#include <memory>
#include <cstddef>
#include <string>

#include <defold_hermes/lua_bridge_core.hpp>

struct SHUnit;

namespace defold_hermes {

using StaticUnitCreator = ::SHUnit* (*)();

class Host {
 public:
  virtual ~Host() = default;
  virtual void log(const std::string& level, const std::string& message) = 0;
  virtual double now() = 0;
  virtual std::string request(
      const std::string& channel,
      const std::string& payload) = 0;
};

class Runtime {
 public:
  struct Telemetry {
    uint64_t heapAllocatedBytes = 0;
    uint64_t heapSizeBytes = 0;
    /// Hermes cumulative peak used-before-collection; zero until the first GC.
    uint64_t peakAllocatedBytes = 0;
    uint32_t callbackRoots = 0;
    uint32_t componentInstances = 0;
    bool heapAvailable = false;
  };
  enum class ComponentContext : uint8_t { kGameObject, kGuiScene, kRender };
  enum class ComponentValueKind : uint8_t {
    kNil,
    kBoolean,
    kNumber,
    kString,
    kHash,
    kUrl,
    kVector3,
    kVector4,
    kQuaternion,
    kObject,
    kArray
  };
  struct ComponentField;
  struct ComponentValue {
    ComponentValueKind kind = ComponentValueKind::kNil;
    bool boolean = false;
    double number = 0.0;
    uint64_t lanes64[4]{};
    float lanes32[4]{};
    const char* string = nullptr;
    uint32_t stringLength = 0;
    const ComponentField* fields = nullptr;
    const ComponentValue* elements = nullptr;
    uint16_t childCount = 0;
  };
  struct ComponentField { const char* name = nullptr; ComponentValue value{}; };
  struct ComponentArgument {
    ComponentValue value{};
    const ComponentField* fields = nullptr;
    uint16_t fieldCount = 0;
  };
  struct ComponentHandle {
    uint32_t slot = UINT32_MAX;
    uint32_t generation = 0;
    explicit operator bool() const noexcept { return slot != UINT32_MAX; }
  };

  explicit Runtime(Host& host);
  ~Runtime();

  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;

  void load(const std::string& source, const std::string& sourceUrl);
  /** Evaluate AOT units and capture the application registered by the final unit. */
  void loadStatic(
      const StaticUnitCreator* unitCreators,
      size_t unitCount,
      const std::string& sourceUrl);
  void init();
  void update(double dt);
  void onMessage(const std::string& message);
  void finalize();
  bool invokeCallback(lua_bridge::Handle callback, uint32_t timer, double elapsed);
  bool releaseCallback(lua_bridge::Handle callback);
  const char* callbackError() const;
  uint32_t liveCallbacks() const;
  ComponentHandle attachComponent(const char* componentId, const char* schemaFingerprint,
      ComponentContext context);
  void setComponentProperty(ComponentHandle handle, const char* name, const ComponentValue& value);
  bool dispatchComponent(ComponentHandle handle, const char* lifecycle,
      const ComponentArgument* arguments, uint8_t argumentCount);
  void reloadComponent(ComponentHandle handle);
  void detachComponent(ComponentHandle handle);
  uint32_t liveComponents() const;
  uint32_t identity() const noexcept;
  /** Exact compiler fingerprint embedded in the evaluated development bundle. */
  std::string bundleFingerprint() const;
  /** Low-rate instrumentation snapshot; callers must keep it off hot paths. */
  Telemetry telemetry() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace defold_hermes
