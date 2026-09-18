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

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace defold_hermes
