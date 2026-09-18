import { defineComponent, gui, hashLiteral, type DefoldHash, type Node } from "@deherm/project";

declare const __defoldHostV1: {
  log(level: "info", message: string): void;
};

const ADD_SCORE = hashLiteral("#add_score");

interface UiSelf {
  score: number;
  node: Node;
}

interface AddScore {
  readonly score: number;
}

export default defineComponent({
  init(self: UiSelf): void {
    self.score = 0;
    self.node = gui.getNode("score");
    gui.setText(self.node, "SCORE 0");
    __defoldHostV1.log("info", "war-battles:ui-init");
  },

  onMessage(self: UiSelf, messageId: DefoldHash, message: AddScore): void {
    if (messageId !== ADD_SCORE) return;
    self.score += message.score;
    gui.setText(self.node, `SCORE ${self.score}`);
    __defoldHostV1.log("info", `war-battles:score:${self.score}`);
  },
});
