#include <defold_hermes/callback_lifecycle_registry.hpp>
#include <defold_hermes/generated_script_callback_lifecycle.hpp>

#include <atomic>
#include <cstddef>
#include <cstring>
#include <cstdlib>
#include <iostream>
#include <new>

namespace {
std::atomic<size_t> gAllocations{0};
std::atomic<bool> gTrackAllocations{false};

void expect(bool value, const char* message) {
  if (!value) { std::cerr << "FAIL: " << message << '\n'; std::exit(1); }
}

struct CallbackContext { uint32_t calls = 0; uint32_t releases = 0; bool result = true; };
bool invoke(void* raw, defold_hermes::lua_bridge::Handle) noexcept {
  auto* context = static_cast<CallbackContext*>(raw); ++context->calls; return context->result;
}
void release(void* raw, defold_hermes::lua_bridge::Handle) noexcept {
  ++static_cast<CallbackContext*>(raw)->releases;
}

struct ReentrantContext {
  defold_hermes::callback_lifecycle::Registry* registry = nullptr;
  defold_hermes::callback_lifecycle::Lease lease{};
  CallbackContext callback{};
};
bool cancelDuringInvoke(void* raw, defold_hermes::lua_bridge::Handle) noexcept {
  auto* context = static_cast<ReentrantContext*>(raw);
  ++context->callback.calls;
  return context->registry->cancel(context->lease, &context->callback, release, 99);
}

defold_hermes::lua_bridge::Handle callback(uint32_t slot) {
  return {7, slot, 1, 1};
}

const defold_hermes::callback_lifecycle::Route* route(const char* canonicalId) {
  namespace lifecycle = defold_hermes::callback_lifecycle;
  for (size_t index = 0; index < lifecycle::kRouteCount; ++index) {
    if (std::strcmp(lifecycle::routes()[index].canonicalId, canonicalId) == 0) return &lifecycle::routes()[index];
  }
  return nullptr;
}
}  // namespace

void* operator new(std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) ++gAllocations;
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
  if (gTrackAllocations.load(std::memory_order_relaxed)) ++gAllocations;
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
  namespace lifecycle = defold_hermes::callback_lifecycle;
  const lifecycle::Route* oneShot = route("script:go.animate");
  const lifecycle::Route* terminal = route("script:http.request");
  const lifecycle::Route* persistent = route("script:physics.set_event_listener");
  const lifecycle::Route* closure = route("script:socket.newtry");
  expect(oneShot && oneShot->lifetime == lifecycle::Lifetime::kOneShot && oneShot->registryEligible, "generated one-shot route is missing");
  expect(terminal && terminal->lifetime == lifecycle::Lifetime::kTerminalEvent && terminal->registryEligible, "generated terminal route is missing");
  expect(persistent && persistent->lifetime == lifecycle::Lifetime::kPersistentReplaceable && persistent->registryEligible, "generated persistent route is missing");
  expect(closure && closure->lifetime == lifecycle::Lifetime::kHigherOrderClosure && !closure->registryEligible, "higher-order closure was incorrectly registry-eligible");

  lifecycle::Registry registry(4, 7, 99);
  CallbackContext one{};
  auto oneLease = registry.retain(oneShot->stableId, 10, callback(1), oneShot->lifetime, 99);
  expect(static_cast<bool>(oneLease), "one-shot retain failed");
  const size_t allocationBaseline = gAllocations.load();
  gTrackAllocations.store(true);
  expect(registry.invoke(oneLease, false, &one, invoke, &one, release, 99), "one-shot invoke failed");
  expect(one.calls == 1 && one.releases == 1, "one-shot was not released exactly once after invocation");
  expect(!registry.invoke(oneLease, false, &one, invoke, &one, release, 99), "released one-shot lease was reusable");

  CallbackContext event{};
  auto eventLease = registry.retain(terminal->stableId, 20, callback(2), terminal->lifetime, 99);
  expect(registry.invoke(eventLease, false, &event, invoke, &event, release, 99), "non-terminal event invoke failed");
  expect(event.calls == 1 && event.releases == 0, "non-terminal event was released early");
  expect(registry.invoke(eventLease, true, &event, invoke, &event, release, 99), "terminal event invoke failed");
  expect(event.calls == 2 && event.releases == 1, "terminal event was not released exactly once");

  CallbackContext replacement{};
  auto oldLease = registry.retain(persistent->stableId, 30, callback(3), persistent->lifetime, 99);
  expect(oldLease && registry.cancelOwner(30, &replacement, release, 99) == 1, "persistent owner replacement cancellation failed");
  expect(replacement.releases == 1, "persistent replacement did not release the previous callback");
  auto newLease = registry.retain(persistent->stableId, 30, callback(4), persistent->lifetime, 99);
  expect(newLease && registry.cancel(newLease, &replacement, release, 99), "persistent replacement lease was not cancellable");
  expect(replacement.releases == 2, "persistent replacement release count drifted");

  ReentrantContext reentrant{&registry};
  reentrant.lease = registry.retain(oneShot->stableId, 40, callback(5), oneShot->lifetime, 99);
  expect(static_cast<bool>(reentrant.lease), "reentrant lease retain failed");
  expect(registry.invoke(reentrant.lease, false, &reentrant, cancelDuringInvoke, &reentrant.callback, release, 99), "reentrant callback cancellation failed");
  expect(reentrant.callback.calls == 1 && reentrant.callback.releases == 1, "reentrant cancellation did not defer release until invocation returned");

  CallbackContext wrongThread{};
  auto wrongThreadLease = registry.retain(oneShot->stableId, 50, callback(6), oneShot->lifetime, 99);
  expect(!registry.cancel(wrongThreadLease, &wrongThread, release, 100), "wrong-thread cancellation was accepted");
  expect(registry.cancel(wrongThreadLease, &wrongThread, release, 99) && wrongThread.releases == 1, "owner-thread cancellation failed after rejection");
  expect(!registry.retain(closure->stableId, 60, callback(7), closure->lifetime, 99), "higher-order closure was retained in lifecycle registry");

  CallbackContext teardown{};
  expect(static_cast<bool>(registry.retain(oneShot->stableId, 70, callback(8), oneShot->lifetime, 99)), "teardown setup first retain failed");
  expect(static_cast<bool>(registry.retain(terminal->stableId, 71, callback(9), terminal->lifetime, 99)), "teardown setup second retain failed");
  expect(registry.teardown(&teardown, release, 99) == 2 && teardown.releases == 2, "teardown did not release all live callbacks");
  expect(!registry.retain(oneShot->stableId, 72, callback(10), oneShot->lifetime, 99), "teardown registry accepted a new callback");
  gTrackAllocations.store(false);
  expect(gAllocations.load() == allocationBaseline, "callback lifecycle operations allocated after construction");
  expect(registry.stats().wrongThread == 1 && registry.stats().live == 0, "registry accounting drifted");
  std::cout << "script-callback-lifecycle:ok allocations:0\n";
}
