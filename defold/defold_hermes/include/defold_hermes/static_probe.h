#ifndef DEFOLD_HERMES_STATIC_PROBE_H
#define DEFOLD_HERMES_STATIC_PROBE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void defold_hermes_static_probe_report(double value);
void defold_hermes_static_lifecycle_report(uint32_t stage, double value);
void defold_hermes_static_vmath_report(uint32_t stage, double value);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // DEFOLD_HERMES_STATIC_PROBE_H
