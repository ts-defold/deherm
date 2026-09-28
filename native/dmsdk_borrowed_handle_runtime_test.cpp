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
    bool force_result = false;
    bool suppress_result_write = false;
    uint64_t forced_result = 0;
    DehermDmSdkBorrowedStatus forced_status = DEHERM_DMSDK_BORROWED_OK;
    uint64_t rejected_handle = UINT64_C(0xdead);
    uint64_t invocations = 0;
    uint64_t transitions = 0;
    uint16_t last_transition_id = UINT16_MAX;
    uint8_t last_transition_position = UINT8_MAX;
    uint8_t last_transition_effect = DEHERM_DMSDK_HANDLE_NONE;
};

uint8_t is_current_thread(void* opaque)
{
    return static_cast<ProviderContext*>(opaque)->current_thread ? UINT8_C(1) : UINT8_C(0);
}

extern "C" int deherm_dmsdk_borrowed_exact_call_run(void);

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
    if (context.suppress_result_write) return context.forced_status;
    if (context.force_result) {
        *out_result = context.forced_result;
        return context.forced_status;
    }
    uint64_t value = id;
    for (uint32_t index = 0; index < argument_count; ++index) value ^= arguments[index] + index;
    switch (deherm_dmsdk_borrowed_descriptors()[id].result_kind) {
        case DEHERM_DMSDK_BORROWED_VOID: value = UINT64_C(0); break;
        case DEHERM_DMSDK_BORROWED_BOOL: value &= UINT64_C(1); break;
        case DEHERM_DMSDK_BORROWED_U8: value &= UINT64_C(0xff); break;
        case DEHERM_DMSDK_BORROWED_U16: value &= UINT64_C(0xffff); break;
        case DEHERM_DMSDK_BORROWED_U32: value &= UINT64_C(0xffffffff); break;
        case DEHERM_DMSDK_BORROWED_F32: value = UINT64_C(0x3f800000); break;
        case DEHERM_DMSDK_BORROWED_I32:
            value = static_cast<uint64_t>(static_cast<int64_t>(static_cast<int32_t>(value)));
            break;
        default: break;
    }
    *out_result = value;
    return DEHERM_DMSDK_BORROWED_OK;
}

void transition_handle(
    void* opaque,
    uint16_t id,
    uint8_t position,
    uint16_t,
    uint64_t,
    uint8_t effect)
{
    auto& context = *static_cast<ProviderContext*>(opaque);
    ++context.transitions;
    context.last_transition_id = id;
    context.last_transition_position = position;
    context.last_transition_effect = effect;
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
    static_assert(DEHERM_DMSDK_BORROWED_PROVIDER_ABI == UINT32_C(3), "provider ABI migration was not atomic");
    assert(deherm_dmsdk_borrowed_count() > UINT32_C(0));
    assert(deherm_dmsdk_borrowed_handle_kind_count() > UINT32_C(0));
    const auto* descriptors = deherm_dmsdk_borrowed_descriptors();
    const auto* handle_kinds = deherm_dmsdk_borrowed_handle_kinds();
    assert(descriptors != nullptr && handle_kinds != nullptr);
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count(); ++index) {
        assert(descriptors[index].id == index);
        assert(descriptors[index].argument_count > 0);
        assert(descriptors[index].argument_count <= DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS);
        assert(descriptors[index].declaration_id != nullptr);
        for (uint32_t argument = 0; argument < descriptors[index].argument_count; ++argument) {
            if (descriptors[index].argument_kinds[argument] == DEHERM_DMSDK_BORROWED_HANDLE) {
                assert(descriptors[index].argument_effects[argument] >= DEHERM_DMSDK_HANDLE_BORROW);
                assert(descriptors[index].argument_effects[argument] <= DEHERM_DMSDK_HANDLE_FINALIZE);
            } else {
                assert(descriptors[index].argument_effects[argument] == DEHERM_DMSDK_HANDLE_NONE);
            }
        }
    }
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_handle_kind_count(); ++index) {
        assert(handle_kinds[index].id == index);
        assert(handle_kinds[index].name != nullptr);
        assert(handle_kinds[index].native_representation != nullptr);
    }

    uint64_t arguments[DEHERM_DMSDK_BORROWED_MAX_ARGUMENTS] = {UINT64_C(0x1234), UINT64_C(7)};
    uint64_t result = UINT64_MAX;
    const DehermDmSdkBorrowedDescriptor* borrowed_route = nullptr;
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count() && borrowed_route == nullptr; ++index) {
        bool only_borrows = true;
        for (uint32_t argument = 0; argument < descriptors[index].argument_count; ++argument) {
            if (descriptors[index].argument_kinds[argument] == DEHERM_DMSDK_BORROWED_HANDLE &&
                descriptors[index].argument_effects[argument] != DEHERM_DMSDK_HANDLE_BORROW) {
                only_borrows = false;
                break;
            }
        }
        if (only_borrows)
            borrowed_route = &descriptors[index];
    }
    assert(borrowed_route != nullptr);
    const auto& route = *borrowed_route;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_PROVIDER_MISSING);
    assert(result == UINT64_C(0));
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(UINT16_MAX, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_UNKNOWN_ID);
    assert(result == UINT64_C(0));
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count + 1, &result) == DEHERM_DMSDK_BORROWED_WRONG_ARITY);
    assert(result == UINT64_C(0));
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, nullptr, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_NULL_STORAGE);
    assert(result == UINT64_C(0));
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
        transition_handle,
    };
    assert(deherm_dmsdk_borrowed_set_provider(&provider) == DEHERM_DMSDK_BORROWED_OK);
    context.current_thread = false;
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_WRONG_THREAD);
    assert(result == UINT64_C(0));
    context.current_thread = true;
    const DehermDmSdkBorrowedDescriptor* lifecycle_route = nullptr;
    uint32_t lifecycle_transition_count = 0;
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count() && lifecycle_route == nullptr; ++index) {
        for (uint32_t argument = 0; argument < descriptors[index].argument_count; ++argument) {
            if (descriptors[index].argument_effects[argument] > DEHERM_DMSDK_HANDLE_BORROW) {
                lifecycle_route = &descriptors[index];
                break;
            }
        }
    }
    assert(lifecycle_route != nullptr);
    for (uint32_t argument = 0; argument < lifecycle_route->argument_count; ++argument) {
        arguments[argument] = lifecycle_route->argument_kinds[argument] == DEHERM_DMSDK_BORROWED_HANDLE
            ? UINT64_C(0x8123) + argument
            : UINT64_C(1);
        if (lifecycle_route->argument_effects[argument] > DEHERM_DMSDK_HANDLE_BORROW)
            ++lifecycle_transition_count;
    }
    const uint64_t transitions_before = context.transitions;
    assert(deherm_dmsdk_borrowed_dispatch(
               lifecycle_route->id, arguments, lifecycle_route->argument_count, &result) ==
           DEHERM_DMSDK_BORROWED_OK);
    assert(context.transitions == transitions_before + lifecycle_transition_count);
    assert(context.last_transition_id == lifecycle_route->id);
    assert(context.last_transition_effect > DEHERM_DMSDK_HANDLE_BORROW);
    context.force_result = true;
    context.forced_result = UINT64_C(0);
    context.forced_status = DEHERM_DMSDK_BORROWED_PROVIDER_ERROR;
    const uint64_t transitions_before_failure = context.transitions;
    assert(deherm_dmsdk_borrowed_dispatch(
               lifecycle_route->id, arguments, lifecycle_route->argument_count, &result) ==
           DEHERM_DMSDK_BORROWED_PROVIDER_ERROR);
    assert(context.transitions == transitions_before_failure);
    context.force_result = false;
    context.forced_status = DEHERM_DMSDK_BORROWED_OK;
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count(); ++index) {
        const auto& candidate = descriptors[index];
        for (uint32_t argument = 0; argument < candidate.argument_count; ++argument) {
            arguments[argument] = candidate.argument_kinds[argument] == DEHERM_DMSDK_BORROWED_HANDLE ? UINT64_C(0x1234) + argument : UINT64_C(1);
        }
        for (uint32_t argument = 0; argument < candidate.argument_count; ++argument) {
            if (candidate.argument_kinds[argument] == DEHERM_DMSDK_BORROWED_U8) {
                arguments[argument] = UINT64_C(256);
                result = UINT64_MAX;
                assert(deherm_dmsdk_borrowed_dispatch(candidate.id, arguments, candidate.argument_count, &result) == DEHERM_DMSDK_BORROWED_INVALID_VALUE);
                assert(result == UINT64_C(0));
                arguments[argument] = UINT64_C(1);
            } else if (candidate.argument_kinds[argument] == DEHERM_DMSDK_BORROWED_U16) {
                arguments[argument] = UINT64_C(65536);
                result = UINT64_MAX;
                assert(deherm_dmsdk_borrowed_dispatch(candidate.id, arguments, candidate.argument_count, &result) == DEHERM_DMSDK_BORROWED_INVALID_VALUE);
                assert(result == UINT64_C(0));
                arguments[argument] = UINT64_C(1);
            }
        }
    }
    struct InvalidResultCase { uint8_t kind; uint64_t value; };
    const InvalidResultCase invalid_results[] = {
        {DEHERM_DMSDK_BORROWED_BOOL, UINT64_C(2)},
        {DEHERM_DMSDK_BORROWED_U8, UINT64_C(256)},
        {DEHERM_DMSDK_BORROWED_U16, UINT64_C(65536)},
        {DEHERM_DMSDK_BORROWED_I32, UINT64_C(0x00000000ffffffff)},
        {DEHERM_DMSDK_BORROWED_U32, UINT64_C(0x100000000)},
        {DEHERM_DMSDK_BORROWED_F32, UINT64_C(0x100000000)},
    };
    context.force_result = true;
    for (const auto& invalid : invalid_results) {
        const DehermDmSdkBorrowedDescriptor* candidate = nullptr;
        for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count(); ++index) {
            if (descriptors[index].result_kind == invalid.kind) { candidate = &descriptors[index]; break; }
        }
        assert(candidate != nullptr);
        for (uint32_t argument = 0; argument < candidate->argument_count; ++argument) {
            arguments[argument] = candidate->argument_kinds[argument] == DEHERM_DMSDK_BORROWED_HANDLE
                ? UINT64_C(0x1234) + argument
                : UINT64_C(1);
        }
        context.forced_result = invalid.value;
        context.forced_status = DEHERM_DMSDK_BORROWED_OK;
        result = UINT64_MAX;
        assert(deherm_dmsdk_borrowed_dispatch(candidate->id, arguments, candidate->argument_count, &result) == DEHERM_DMSDK_BORROWED_INVALID_VALUE);
        assert(result == UINT64_C(0));
        context.forced_result = UINT64_C(0);
        context.forced_status = DEHERM_DMSDK_BORROWED_PROVIDER_ERROR;
        result = UINT64_MAX;
        assert(deherm_dmsdk_borrowed_dispatch(candidate->id, arguments, candidate->argument_count, &result) == DEHERM_DMSDK_BORROWED_PROVIDER_ERROR);
        assert(result == UINT64_C(0));
    }
    context.force_result = false;
    context.forced_status = DEHERM_DMSDK_BORROWED_OK;
    arguments[0] = context.rejected_handle;
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_INVALID_HANDLE);
    assert(result == UINT64_C(0));
    arguments[0] = UINT64_C(0);
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_INVALID_HANDLE);
    assert(result == UINT64_C(0));
    arguments[0] = UINT64_C(0x1234);
    const DehermDmSdkBorrowedDescriptor* void_route = nullptr;
    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count(); ++index) {
        if (descriptors[index].result_kind == DEHERM_DMSDK_BORROWED_VOID) {
            void_route = &descriptors[index];
            break;
        }
    }
    assert(void_route != nullptr);
    for (uint32_t argument = 0; argument < void_route->argument_count; ++argument) {
        arguments[argument] = void_route->argument_kinds[argument] == DEHERM_DMSDK_BORROWED_HANDLE
            ? UINT64_C(0x1234) + argument
            : UINT64_C(1);
    }
    context.suppress_result_write = true;
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(
               void_route->id, arguments, void_route->argument_count, &result) ==
           DEHERM_DMSDK_BORROWED_OK);
    assert(result == UINT64_C(0));
    context.suppress_result_write = false;
    context.invocations = 0;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_OK);

    for (uint32_t index = 0; index < deherm_dmsdk_borrowed_count(); ++index) {
        const auto& candidate = descriptors[index];
        for (uint32_t argument = 0; argument < candidate.argument_count; ++argument) {
            arguments[argument] = candidate.argument_kinds[argument] == DEHERM_DMSDK_BORROWED_HANDLE
                ? UINT64_C(0x1234) + index + argument
                : UINT64_C(1);
        }
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
    result = UINT64_MAX;
    assert(deherm_dmsdk_borrowed_dispatch(route.id, arguments, route.argument_count, &result) == DEHERM_DMSDK_BORROWED_PROVIDER_MISSING);
    assert(result == UINT64_C(0));
    assert(deherm_dmsdk_borrowed_exact_call_run() == 0);
    std::puts("dmsdk-borrowed-handle:ok");
    return 0;
}
