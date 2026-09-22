#pragma once

#include <stdint.h>

namespace sample {

uint32_t accumulate(uint32_t value, int32_t delta);

struct Counter {
  uint32_t step(uint32_t amount) const;
};

template <typename T>
T identity(T value) {
  return value;
}

}  // namespace sample
