import { defold, gui, type DefoldHash } from "@ts-defold/deherm";
import { defineComponent } from "@ts-defold/deherm/component";

interface UiSelf {
  score: number;
}

interface AddScore {
  readonly score: number;
}

const ADD_SCORE = defold.hash("add_score");

export default defineComponent({
  init(self: UiSelf): void {
    self.score = 0;
  },

  onMessage(self: UiSelf, messageId: DefoldHash, message: AddScore): void {
    if (messageId !== ADD_SCORE) return;
    self.score += message.score;
    gui.setText(gui.getNode("score"), self.score);
  },
});
