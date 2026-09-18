#include <defold_hermes/bundle_resource.hpp>

#include <dmsdk/resource/resource.hpp>

#include <cstring>
#include <cstdint>
#include <memory>
#include <new>

namespace defold_hermes::bundle_resource {
namespace {

struct Bundle {
  std::unique_ptr<uint8_t[]> bytes;
  uint32_t size = 0;
  uint64_t generation = 1;
};

bool copyBytes(std::unique_ptr<uint8_t[]>* destination, uint32_t* destinationSize,
               const void* source, uint32_t size) {
  if (!destination || (size != 0 && !source)) return false;
  std::unique_ptr<uint8_t[]> candidate;
  if (size != 0) {
    candidate.reset(new (std::nothrow) uint8_t[size]);
    if (!candidate) return false;
    std::memcpy(candidate.get(), source, size);
  }
  *destination = std::move(candidate);
  *destinationSize = size;
  return true;
}

dmResource::Result create(const dmResource::ResourceCreateParams* params) {
  auto* resource = new (std::nothrow) Bundle();
  if (!resource) return dmResource::RESULT_OUT_OF_MEMORY;
  if (!copyBytes(&resource->bytes, &resource->size, params->m_Buffer, params->m_BufferSize)) {
    delete resource;
    return dmResource::RESULT_OUT_OF_MEMORY;
  }
  dmResource::SetResource(params->m_Resource, resource);
  dmResource::SetResourceSize(params->m_Resource, params->m_BufferSize);
  return dmResource::RESULT_OK;
}

dmResource::Result destroy(const dmResource::ResourceDestroyParams* params) {
  delete static_cast<Bundle*>(dmResource::GetResource(params->m_Resource));
  dmResource::SetResource(params->m_Resource, nullptr);
  return dmResource::RESULT_OK;
}

dmResource::Result recreate(const dmResource::ResourceRecreateParams* params) {
  auto* resource = static_cast<Bundle*>(dmResource::GetResource(params->m_Resource));
  if (!resource) return dmResource::RESULT_INVALID_DATA;

  // Allocate the candidate buffer before touching the committed generation.
  // A failed allocation leaves both the active bytes and generation unchanged.
  std::unique_ptr<uint8_t[]> candidate;
  uint32_t candidateSize = 0;
  if (!copyBytes(&candidate, &candidateSize, params->m_Buffer, params->m_BufferSize)) {
    return dmResource::RESULT_OUT_OF_MEMORY;
  }
  resource->bytes = std::move(candidate);
  resource->size = candidateSize;
  resource->generation += 1;
  if (resource->generation == 0) resource->generation = 1;
  dmResource::SetResourceSize(params->m_Resource, params->m_BufferSize);
  return dmResource::RESULT_OK;
}

ResourceResult registerType(HResourceTypeContext context, HResourceType type) {
  return static_cast<ResourceResult>(dmResource::SetupType(
      context,
      type,
      nullptr,
      nullptr,
      create,
      nullptr,
      destroy,
      recreate));
}

ResourceResult deregisterType(HResourceTypeContext, HResourceType) {
  return RESOURCE_RESULT_OK;
}

}  // namespace

bool view(void* opaque, View* out) {
  if (!opaque || !out) return false;
  const auto* resource = static_cast<const Bundle*>(opaque);
  out->data = !resource->bytes
      ? ""
      : reinterpret_cast<const char*>(resource->bytes.get());
  out->size = resource->size;
  out->generation = resource->generation;
  return true;
}

}  // namespace defold_hermes::bundle_resource

DM_DECLARE_RESOURCE_TYPE(
    DehermBundleResource,
    "dehermc",
    defold_hermes::bundle_resource::registerType,
    defold_hermes::bundle_resource::deregisterType);
