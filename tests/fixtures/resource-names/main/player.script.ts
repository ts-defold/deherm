import { msg, sprite } from "@ts-defold/deherm";
import { defineComponent } from "@ts-defold/deherm/component";

interface PlayerSelf {
  moving: boolean;
}

export default defineComponent({
  init(self: PlayerSelf): void {
    self.moving = false;
    sprite.playFlipbook("#sprite", "walk");
    msg.post("#shooter", "create");
    msg.post("/hud", "enable");
  },
});
