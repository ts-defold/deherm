import { gui } from "@ts-defold/deherm";
import { defineComponent } from "@ts-defold/deherm/component";

export default defineComponent({
  init(): void {
    gui.setEnabled(gui.getNode("backrop"), true);
    gui.setLayer(gui.getNode("score"), "overlai");
    gui.setFont(gui.getNode("score"), "hud_fnt");
    gui.setLayout("Portrait");
  },
});
