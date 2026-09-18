import { bit, builtins, render, sys, vmath, window } from "../../packages/sdk/src/generated/script/index";

declare global {
  var __defoldAppV1: { init(): void } | undefined;
  var __defoldHostV1: { log(level: string, message: string): void };
}

globalThis.__defoldAppV1 = {
  init() {
    const configured = sys.getConfigInt("speed", 7);
    const width = render.getWidth();
    const hex = bit.tohex(255, 4);
    const exists = sys.exists("/known");
    window.setTitle("deherm");
    globalThis.__defoldHostV1.log("info", `values:${configured}:${width}:${hex}:${exists}`);

    const vector = vmath.vector3(3, 4, 0);
    const normalized = vmath.normalize(vector);
    const rotation = vmath.quatRotationZ(Math.PI);
    const quaternion = vmath.quat(1, 2, 3, 4);
    globalThis.__defoldHostV1.log(
      "info",
      `vmath:${vector.x}:${vmath.length(vector)}:${normalized.x.toFixed(6)}:${normalized.y.toFixed(6)}:${rotation.z.toFixed(6)}:${quaternion.w}`,
    );
    const normalizedZero = vmath.normalize(vmath.vector3());
    let rejectedNaN = false;
    try {
      vmath.length(normalizedZero);
    } catch {
      rejectedNaN = true;
    }
    globalThis.__defoldHostV1.log("info", `vmath-nan-rejected:${rejectedNaN}`);

    const hash = builtins.hash("my_hash");
    globalThis.__defoldHostV1.log("info", `hash:${typeof hash}:${hash === 0xa2bc06d97f580aabn}`);

    try {
      render.clear({} as never);
      throw new Error("render.clear unexpectedly executed");
    } catch (error) {
      globalThis.__defoldHostV1.log("info", `unsupported:${String(error)}`);
    }

    try {
      sys.getConfigInt("explode", 0);
      throw new Error("Lua error unexpectedly succeeded");
    } catch (error) {
      globalThis.__defoldHostV1.log("info", `lua-error:${String(error)}`);
    }

    globalThis.__defoldHostV1.log("info", `after-error:${sys.getConfigInt("speed", 1)}`);
  }
};
