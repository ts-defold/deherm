import { builtins, defineDefoldApp } from "@defold-hermes/sdk";
import { add } from "@defold-hermes/sdk/ExampleMath";
import { runScriptRealEngineProbes } from "./generated/script-real-engine-probes";
import { runScriptValueRealEngineProbes } from "./generated/script-value-real-engine-probes";

declare const __DEFOLD_HERMES_BUILD_FINGERPRINT__: string;

defineDefoldApp((defold) => {
  let updates = 0;

  return {
    init() {
      defold.log("info", `init:${defold.runtime}`);
      defold.log("info", `bundle:${__DEFOLD_HERMES_BUILD_FINGERPRINT__}`);
      defold.log("info", `module:${add(20, 22)}`);
      runScriptRealEngineProbes((message) => defold.log("info", message));
      if (defold.runtime === "hermes") {
        runScriptValueRealEngineProbes((message) => defold.log("info", message));
      } else if (defold.runtime === "browser") {
        const value = builtins.hash("my_hash");
        if (value !== 0xa2bc06d97f580aabn) {
          throw new Error(`Unexpected browser hash payload: ${value.toString(16)}`);
        }
        defold.log("info", "script-value:builtins.hash.my_hash:ok");
      }

      const reply = defold.request("ready", "typescript");
      if (!reply.endsWith(":ready:typescript")) {
        throw new Error(`Unexpected host reply: ${reply}`);
      }
      defold.log("debug", `clock-ready:${Number.isFinite(defold.now())}`);
    },

    update(dt) {
      updates += 1;
      if (updates === 1) defold.log("info", `lifecycle:update:${updates}`);
      defold.log("debug", `update:${updates}:${dt.toFixed(6)}`);
    },

    onMessage(message) {
      defold.log("info", `message:${message}`);
    },

    final() {
      defold.log("info", "final:ok");
    }
  };
});
