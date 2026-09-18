#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum SampleMode {
  SAMPLE_MODE_ADD = 0,
  SAMPLE_MODE_MULTIPLY = 1
} SampleMode;

typedef struct SamplePoint {
  float x;
  float y;
} SamplePoint;

uint32_t sample_accumulate(uint32_t value, int32_t delta);
double sample_apply(double value, SampleMode mode);
const char* sample_label(SampleMode mode);
SamplePoint sample_translate(SamplePoint point, float x, float y);

#ifdef __cplusplus
}
#endif
