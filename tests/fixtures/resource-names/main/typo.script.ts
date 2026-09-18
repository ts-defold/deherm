import { msg, sprite } from "@ts-defold/deherm";
import { defineComponent } from "@ts-defold/deherm/component";

export default defineComponent({
  init(): void {
    sprite.playFlipbook("#sprite", "wlak");
    msg.post("#shootr", "create");
    msg.post("/playr", "enable");
  },
});
