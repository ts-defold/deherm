import { b2d, bit, defold, render, socket, sound, sys, vmath, window } from "../../packages/sdk/src/generated/script/index";

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
    globalThis.__defoldHostV1.log("info", `overload-dot:${vmath.dot(vector, vector)}`);
    globalThis.__defoldHostV1.log("info", `value-tail-gain:${sound.getGroupGain("music")}`);
    const normalizedZero = vmath.normalize(vmath.vector3());
    let rejectedNaN = false;
    try {
      vmath.length(normalizedZero);
    } catch {
      rejectedNaN = true;
    }
    globalThis.__defoldHostV1.log("info", `vmath-nan-rejected:${rejectedNaN}`);

    const hash = defold.hash("my_hash");
    globalThis.__defoldHostV1.log("info", `hash:${typeof hash}:${hash === 0xa2bc06d97f580aabn}`);

    const body = b2d.getBody(".")! as NonNullable<ReturnType<typeof b2d.getBody>> & {
      readonly runtime: number;
      readonly slot: number;
      readonly generation: number;
      readonly kind: string;
      dispose(): void;
    };
    b2d.body.dump(body);
    globalThis.__defoldHostV1.log(
      "info",
      `handle:${body.kind}:${body.runtime}:${body.slot}:${body.generation}:${Object.keys(body).sort().join(",")}:true:${typeof body.dispose}`,
    );
    body.dispose();
    body.dispose();
    let disposedRejected = false;
    try {
      b2d.body.dump(body);
    } catch {
      disposedRejected = true;
    }
    globalThis.__defoldHostV1.log("info", `handle-disposed:${disposedRejected}`);

    sys.save("state", { score: 42, nested: { label: "ok", values: [1, 2, 3] } });
    const loaded = sys.load("state") as {
      readonly score: number;
      readonly nested: { readonly label: string; readonly values: readonly number[] };
    };
    globalThis.__defoldHostV1.log(
      "info",
      `universal:${loaded.score}:${loaded.nested.label}:${loaded.nested.values[2]}`,
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    let cycleRejected = false;
    try {
      sys.save("state", cyclic);
    } catch {
      cycleRejected = true;
    }
    globalThis.__defoldHostV1.log("info", `universal-cycle:${cycleRejected}`);
    let luaCycleRejected = false;
    try {
      sys.load("cycle");
    } catch {
      luaCycleRejected = true;
    }
    globalThis.__defoldHostV1.log("info", `universal-lua-cycle:${luaCycleRejected}`);

    window.setListener((self, event, data) => {
      globalThis.__defoldHostV1.log(
        "info",
        `callback:${String(self)}:${event}:${data.width}:${data.height}`,
      );
    });

    let finalized = 0;
    const attempt = socket.newtry(() => { ++finalized; });
    const closureSuccess = attempt(true, "payload") as readonly [boolean, string];
    globalThis.__defoldHostV1.log(
      "info",
      `closure-success:${closureSuccess[0]}:${closureSuccess[1]}`,
    );
    let directClosureError = false;
    try {
      attempt(null, "direct-boom");
    } catch (error) {
      directClosureError = String(error).includes("direct-boom") &&
        !String(error).includes("__deherm_lua_error_table_v1__");
    }
    globalThis.__defoldHostV1.log(
      "info",
      `closure-error:${directClosureError}:${finalized}`,
    );

    const protectedCall = socket.protect((mode: unknown) => {
      const nested = socket.newtry(() => { ++finalized; });
      if (mode === "bad") return nested(null, "protected-boom");
      return { __dehermCallbackResultsV1: true, values: [mode, 7] };
    });
    const protectedSuccess = protectedCall("ok") as readonly [string, number];
    const protectedError = protectedCall("bad") as readonly [null, string];
    globalThis.__defoldHostV1.log(
      "info",
      `protect-success:${protectedSuccess[0]}:${protectedSuccess[1]}`,
    );
    globalThis.__defoldHostV1.log(
      "info",
      `protect-error:${protectedError[0] === null}:${protectedError[1]}:${finalized}`,
    );

    const loadedResource = sys.loadResource("/exists");
    const missingResource = sys.loadResource("/missing");
    globalThis.__defoldHostV1.log(
      "info",
      `load-resource:${loadedResource[0]}:${loadedResource[1] === undefined}:${missingResource[1]}`,
    );

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
