#include <defold_hermes/generated_dmsdk_borrowed_handle.h>

#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>

namespace {
std::atomic<uint64_t> g_allocations{0};

struct ProviderContext {
    bool current_thread = true;
    uint64_t rejected_handle = UINT64_C(0xdead);
    uint64_t invocations = 0;
};

uint8_t is_current_thread(void* opaque)
{
    return static_cast<ProviderContext*>(opaque)->current_thread ? UINT8_C(1) : UINT8_C(0);
}

uint8_t validate_handle(void* opaque, uint16_t handle_kind, uint64_t value)
{
    const auto& context = *static_cast<ProviderContext*>(opaque);
    return handle_kind < deherm_dmsdk_borrowed_handle_kind_count() && value != context.rejected_handle;
}

DehermDmSdkBorrowedStatus invoke(
    void* opaque,
    uint16_t id,
    const uint64_t* arguments,
    uint32_t argument_count,
    uint64_t* out_result)
{
    auto& context = *static_cast<ProviderContext*>(opaque);
    ++context.invocations;
    uint64_t value = id;
    for (uint32_t index = 0; index < argument_count; ++index) value ^= arguments[index] + index;
    *out_result = value;
    return DEHERM_DMSDK_BORROWED_OK;
}
}

void* operator new(std::size_t size)
{
    g_allocations.fetch_add(1, std::memory_order_relaxed);
    if (void* value = std::malloc(size)) return value;
    throw std::bad_alloc();
}

void operator delete(void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }

int main()
{
    // Exact nested-enum support facts correctly move two former scalar rows to
    // the enum family; this provider harness covers the remaining 80 routes.
    assert(deherm_dmsdk_borrowed_count() == UINT32_C(80));
    assert(deherm_dmsdk_borrowed_handle_kind_count() == UINT32_C(32));
    const auto* descriptors = deherm_dmsdk_borrowed_descriptors();
    const auto* handle_kinds = deherm_dmsdk_borrowed_handle_kinds();
    assert(descriptors != nullptr && handle_kinds != nullptr);
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count(); ++index) {
        assert(descriptors[index].id == index);
        assert(descriptors[index].argument_count > 0);
        assert(descriptors[index].argument_count <= DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS);
        assert(descriptors[index].declaration_id != nullptr);
    }
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_handle_kind_count(); ++index) {
        assert(handle_kinds[index].id == index);
        assert(handle_kinds[index].name != nullptr);
        assert(handle_kinds[index].native_representation != nullptr);
    }

    uint64_t arguments[DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS] = {UINT64_C(0x1234), UINT64_C(7)};
    uint64_t result = 0;
    const auto& route = descriptors[0];
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_PROVIDER_MISSING);
    assert(deherm_dmsdk_borrowed_dispatch(UINT16_MAX, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_UNKNOWN_ID);
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count + 1, &result) == DEHERM_DMSDK_BORROWED_WRONG_ARITY);
    assert(deherm_dmsdk_borrowed_dispatch(route.id, nullptr, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_NULL_STORAGE);
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, nullptr) == DEHERM_DMSDK_BORROWED_NULL_STORAGE);

    DehermDmSdkBorrowedProvider invalid = {};
    assert(deherm_dmsdk_borrowed_set_provider(&invalid) == DEHERM_DMSDK_BORROWED_INVALID_PROVIDER);
    ProviderContext context;
    DehermDmSdkBorrowedProvider provider = {
        DEHERM_DMSDK_BORROWED_PROVIDER_ABI,
        &context,
        is_current_thread,
        validate_handle,
        invoke,
    };
    assert(deherm_dmsdk_borrowed_set_provider(&provider) == DEHERM_DMSDK_BORROWED_OK);
    context.current_thread = false;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_WRONG_THREAD);
    context.current_thread = true;
    arguments[0] = context.rejected_handle;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_INVALID_HANDLE);
    arguments[0] = UINT64_C(0);
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_INVALID_HANDLE);
    arguments[0] = UINT64_C(0x1234);
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_OK);

    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count(); ++index) {
        const auto& candidate = descriptors[index];
        arguments[0] = UINT64_C(0x1234) + index;
        arguments[1] = UINT64_C(7) + index;
        assert(deherm_dmsdk_borrowed_dispatch(
                   candidate.id,
                   arguments,
                   candidate.argument_count,
                   &result) == DEHERM_DMSDK_BORROWED_OK);
    }

    const uint64_t before = g_allocations.load(std::memory_order_relaxed);
    for (uint32_t iteration = 0; iteration < UINT32_C(100000); ++iteration) {
        assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_OK);
    }
    assert(g_allocations.load(std::memory_order_relaxed) == before);
    assert(context.invocations == UINT64_C(100001) + deherm_dmsdk_borrowed_count());
    assert(deherm_dmsdk_borrowed_set_provider(nullptr) == DEHERM_DMSDK_BORROWED_OK);
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_PROVIDER_MISSING);
    std::puts("dmsdk-borrowed-handle:ok");
    return 0;
}
