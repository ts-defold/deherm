import {
  defineDefoldApp
} from "@defold-hermes/sdk";
import { add } from "@defold-hermes/sdk/ExampleMath";

defineDefoldApp((defold) => {
  let updates = 0;

  return {
    init() {
      defold.log("info", `init:${defold.runtime}`);
      defold.log("info", `module:${add(20, 22)}`);
      const reply = defold.request("ready", "typescript");
      if (!reply.endsWith(":ready:typescript")) {
        throw new Error(`Unexpected host reply: ${reply}`);
      }
      defold.log("debug", `clock-ready:${Number.isFinite(defold.now())}`);
    },

    update(dt) {
      updates += 1;
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
