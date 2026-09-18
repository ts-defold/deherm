import { defold, defineDefoldApp } from "@ts-defold/deherm";
import { add } from "@ts-defold/deherm/modules/ExampleMath";
import { runScriptRealEngineProbes } from "./generated/script-real-engine-probes";
import { runScriptValueRealEngineProbes } from "./generated/script-value-real-engine-probes";

declare const __DEFOLD_HERMES_BUILD_FINGERPRINT__: string;

defineDefoldApp((host) => {
  let updates = 0;

  return {
    init() {
      host.log("info", `init:${host.runtime}`);
      host.log("info", `bundle:${__DEFOLD_HERMES_BUILD_FINGERPRINT__}`);
      host.log("info", `module:${add(20, 22)}`);
      runScriptRealEngineProbes((message) => host.log("info", message));
      if (host.runtime === "hermes") {
        runScriptValueRealEngineProbes((message) => host.log("info", message));
      } else if (host.runtime === "browser") {
        const value = defold.hash("my_hash");
        if (value !== 0xa2bc06d97f580aabn) {
          throw new Error(`Unexpected browser hash payload: ${value.toString(16)}`);
        }
        host.log("info", "script-value:builtins.hash.my_hash:ok");
      }

      const reply = host.request("ready", "typescript");
      if (!reply.endsWith(":ready:typescript")) {
        throw new Error(`Unexpected host reply: ${reply}`);
      }
      host.log("debug", `clock-ready:${Number.isFinite(host.now())}`);
    },

    update(dt) {
      updates += 1;
      if (updates === 1) host.log("info", `lifecycle:update:${updates}`);
      host.log("debug", `update:${updates}:${dt.toFixed(6)}`);
    },

    onMessage(message) {
      host.log("info", `message:${message}`);
    },

    final() {
      host.log("info", "final:ok");
    }
  };
});
