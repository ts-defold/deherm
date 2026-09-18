import { msg, sprite, type DefoldUrl } from "@ts-defold/deherm";
import { defineComponent } from "@ts-defold/deherm/component";

interface BulletSelf {
  variant: string;
  target: DefoldUrl;
}

function suffix(index: number): string {
  return index > 0 ? `-${index}` : "";
}

export default defineComponent({
  init(self: BulletSelf): void {
    // Every name here is computed, read from state, or assembled from parts.
    // None of it is checkable, and none of it may be rejected.
    sprite.playFlipbook("#sprite", self.variant);
    sprite.playFlipbook("#sprite", `walk${suffix(1)}`);
    msg.post(self.target, "enable");
    msg.post(".", "enable");
    msg.post("#", "enable");
    msg.post("@render:", "clear_color");
  },
});
