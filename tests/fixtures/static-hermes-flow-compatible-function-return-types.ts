"use strict";

const __ffiFlowCompatibleReport = $SHBuiltin.extern_c(
  { include: "defold_hermes/static_probe.h" },
  function deherm_static_flow_compatible_report(stage: c_u32, value: c_f64): void { throw 0; }
);

const functionExpression = function addOne(value: number): number {
  return value + 1;
};
const arrow = (value: number): number => value + 2;

class ReturnAnnotatedMethod {
  addThree(value: number): number {
    return value + 3;
  }
}

const methods = new ReturnAnnotatedMethod();
__ffiFlowCompatibleReport(1, functionExpression(39));
__ffiFlowCompatibleReport(2, arrow(39));
__ffiFlowCompatibleReport(3, methods.addThree(39));
