#pragma once

#include <cstdint>

namespace defold_hermes::bundle_resource {

struct View {
  const char* data;
  uint32_t size;
  uint64_t generation;
};

/**
 * Return a stable view of the currently committed bundle resource.
 *
 * Defold invokes resource recreate callbacks and extension updates on the
 * engine thread. The pointer remains valid until the next recreate or destroy
 * callback for this resource.
 */
bool view(void* resource, View* out);

}  // namespace defold_hermes::bundle_resource
