import { gui } from "@ts-defold/deherm";
import { defineComponent } from "@ts-defold/deherm/component";

interface HudSelf {
  score: number;
}

export default defineComponent({
  init(self: HudSelf): void {
    self.score = 0;
    gui.setEnabled(gui.getNode("backdrop"), true);
    gui.setLayer(gui.getNode("score"), "overlay");
    gui.setFont(gui.getNode("score"), "hud_font");
    gui.setLayout("Landscape");
  },
});
