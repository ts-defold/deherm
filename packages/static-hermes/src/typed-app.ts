// Sound-typed Static Hermes lifecycle proof. This is intentionally ordinary
// TypeScript syntax accepted directly by the sound `-typed` frontend; the production ttsc
// backend will generate this shape from defineDefoldApp authoring code.
"use strict";

const __ffiLifecycleReport = $SHBuiltin.extern_c(
  {include: "defold_hermes/static_probe.h"},
  function defold_hermes_static_lifecycle_report(
    stage: c_u32,
    value: c_f64
  ): void { throw 0; }
);

class TypedDefoldApp {
  updates: number;

  constructor() {
    this.updates = 0;
  }

  init(): void {
    __ffiLifecycleReport(1, 1);
  }

  update(dt: number): void {
    this.updates += 1;
    __ffiLifecycleReport(2, dt);
  }

  onMessage(message: string): void {
    __ffiLifecycleReport(3, message.length);
  }

  final(): void {
    __ffiLifecycleReport(4, this.updates);
  }
}

globalThis.__defoldAppV1 = new TypedDefoldApp();
