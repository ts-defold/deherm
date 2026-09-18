#include <defold_hermes/generated_dmsdk_scratch_scalar_out.h>

#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

namespace {
std::atomic<uint64_t> g_allocations{0};

struct ProviderContext {
    bool current_thread = true;
    bool fail = false;
    bool invalid_output = false;
    bool reenter = false;
    uint64_t rejected_handle = UINT64_C(0xdead);
    uint64_t invocations = 0;
    DehermDmSdkScratchStatus nested_status = DEHERM_DMSDK_SCRATCH_OK;
};

uint8_t is_current_thread(void* opaque)
{
    return static_cast<ProviderContext*>(opaque)->current_thread ? UINT8_C(1) : UINT8_C(0);
}

uint8_t validate_handle(void* opaque, uint16_t handle_kind, uint64_t value)
{
    const auto& context = *static_cast<ProviderContext*>(opaque);
    return handle_kind < deherm_dmsdk_scratch_handle_kind_count() && value != context.rejected_handle;
}

uint64_t lane_value(uint8_t kind)
{
    switch (kind) {
        case DEHERM_DMSDK_SCRATCH_BOOL: return UINT64_C(1);
        case DEHERM_DMSDK_SCRATCH_I32: return static_cast<uint64_t>(INT64_C(-17));
        case DEHERM_DMSDK_SCRATCH_U16: return UINT64_C(17);
        case DEHERM_DMSDK_SCRATCH_U32: return UINT64_C(23);
        case DEHERM_DMSDK_SCRATCH_U64: return UINT64_C(0x123456789abcdef0);
        case DEHERM_DMSDK_SCRATCH_F32: {
            const float value = 1.25f;
            uint32_t bits = 0;
            std::memcpy(&bits, &value, sizeof(bits));
            return bits;
        }
        case DEHERM_DMSDK_SCRATCH_ENUM: return UINT64_C(0);
        default: return UINT64_C(1);
    }
}

DehermDmSdkScratchStatus invoke(
    void* opaque,
    uint16_t id,
    uint64_t* slots,
    uint32_t parameter_count,
    uint64_t* out_result)
{
    auto& context = *static_cast<ProviderContext*>(opaque);
    ++context.invocations;
    if (context.fail) return DEHERM_DMSDK_SCRATCH_PROVIDER_ERROR;
    const auto& descriptor = deherm_dmsdk_scratch_descriptors()[id];
    if (context.reenter) {
        context.reenter = false;
        uint64_t nested_slots[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS] = {};
        uint64_t nested_result = 0;
        context.nested_status = deherm_dmsdk_scratch_dispatch(
            id, nested_slots, parameter_count, &nested_result);
    }
    *out_result = lane_value(descriptor.result_kind);
    for (uint32_t index = 0; index < parameter_count; ++index) {
        if (descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT ||
            descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_INOUT) {
            slots[index] = lane_value(descriptor.parameter_kinds[index]);
        }
    }
    if (context.invalid_output) {
        for (uint32_t index = 0; index < parameter_count; ++index) {
            if (descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT &&
                descriptor.parameter_kinds[index] == DEHERM_DMSDK_SCRATCH_BOOL) {
                slots[index] = UINT64_C(2);
            }
        }
    }
    return DEHERM_DMSDK_SCRATCH_OK;
}

void seed_inputs(const DehermDmSdkScratchDescriptor& descriptor, uint64_t* slots)
{
    for (uint32_t index = 0; index < descriptor.parameter_count; ++index) {
        if (descriptor.parameter_directions[index] == DEHERM_DMSDK_SCRATCH_OUT) {
            slots[index] = UINT64_MAX;
        } else if (descriptor.parameter_kinds[index] == DEHERM_DMSDK_SCRATCH_HANDLE) {
            slots[index] = UINT64_C(0x1000) + index;
        } else {
            slots[index] = lane_value(descriptor.parameter_kinds[index]);
        }
    }
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
    assert(deherm_dmsdk_scratch_count() == UINT32_C(7));
    assert(deherm_dmsdk_scratch_handle_kind_count() == UINT32_C(4));
    const auto* descriptors = deherm_dmsdk_scratch_descriptors();
    assert(descriptors != nullptr && deherm_dmsdk_scratch_handle_kinds() != nullptr);
    for (uint32_t index = 0; index < deherm_dmsdk_scratch_count(); ++index) {
        assert(descriptors[index].id == index);
        assert(descriptors[index].parameter_count <= DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS);
        assert(descriptors[index].output_count == 1);
    }

    uint64_t slots[DEHERM_DMSDK_SCRATCH_MAX_PARAMETERS] = {};
    uint64_t result = UINT64_MAX;
    const auto& route = descriptors[0];
    seed_inputs(route, slots);
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_PROVIDER_MISSING);
    assert(slots[2] == 0 && result == 0);
    assert(deherm_dmsdk_scratch_dispatch(UINT16_MAX, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_UNKNOWN_ID);
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count + 1, &result) == DEHERM_DMSDK_SCRATCH_WRONG_ARITY);
    assert(deherm_dmsdk_scratch_dispatch(route.id, nullptr, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_NULL_STORAGE);
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, nullptr) == DEHERM_DMSDK_SCRATCH_NULL_STORAGE);

    DehermDmSdkScratchProvider invalid = {};
    assert(deherm_dmsdk_scratch_set_provider(&invalid) == DEHERM_DMSDK_SCRATCH_INVALID_PROVIDER);
    ProviderContext context;
    DehermDmSdkScratchProvider provider = {
        DEHERM_DMSDK_SCRATCH_PROVIDER_ABI,
        &context,
        is_current_thread,
        validate_handle,
        invoke,
    };
    assert(deherm_dmsdk_scratch_set_provider(&provider) == DEHERM_DMSDK_SCRATCH_OK);

    context.current_thread = false;
    seed_inputs(route, slots);
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_WRONG_THREAD);
    assert(slots[2] == 0);
    context.current_thread = true;
    seed_inputs(route, slots);
    slots[0] = context.rejected_handle;
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_INVALID_HANDLE);
    assert(slots[2] == 0);
    seed_inputs(route, slots);
    slots[1] = UINT64_C(0x10000);
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_INVALID_LANE);
    assert(slots[2] == 0);

    context.fail = true;
    seed_inputs(route, slots);
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_PROVIDER_ERROR);
    assert(slots[2] == 0 && result == 0);
    context.fail = false;

    context.invalid_output = true;
    const auto& bool_output_route = descriptors[1];
    seed_inputs(bool_output_route, slots);
    assert(deherm_dmsdk_scratch_dispatch(bool_output_route.id, slots, bool_output_route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_INVALID_LANE);
    assert(slots[3] == 0 && result == 0);
    context.invalid_output = false;

    context.reenter = true;
    seed_inputs(route, slots);
    assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_OK);
    assert(context.nested_status == DEHERM_DMSDK_SCRATCH_REENTRANT);

    for (uint32_t index = 0; index < deherm_dmsdk_scratch_count(); ++index) {
        const auto& candidate = descriptors[index];
        seed_inputs(candidate, slots);
        assert(deherm_dmsdk_scratch_dispatch(candidate.id, slots, candidate.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_OK);
    }

    seed_inputs(route, slots);
    const uint64_t before = g_allocations.load(std::memory_order_relaxed);
    for (uint32_t iteration = 0; iteration < UINT32_C(100000); ++iteration) {
        assert(deherm_dmsdk_scratch_dispatch(route.id, slots, route.parameter_count, &result) == DEHERM_DMSDK_SCRATCH_OK);
    }
    assert(g_allocations.load(std::memory_order_relaxed) == before);
    assert(deherm_dmsdk_scratch_set_provider(nullptr) == DEHERM_DMSDK_SCRATCH_OK);
    std::puts("dmsdk-scratch-scalar-out:ok");
    return 0;
}
