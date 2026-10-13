import { defineComponent, gui, type DefoldHash, type Node } from "@deherm/project";

const SNAKE_STATE: DefoldHash = "#snake_state";

interface HudState {
  score: Node;
  hint: Node;
}
interface SnakeStateMessage {
  score: number;
  status: string;
}

export default defineComponent({
  init(self: HudState): void {
    self.score = gui.getNode("score");
    self.hint = gui.getNode("hint");
  },
  onMessage(self: HudState, messageId: DefoldHash, message: SnakeStateMessage): void {
    if (messageId !== SNAKE_STATE) return;
    gui.setText(self.score, `SCORE ${String(message.score).padStart(3, "0")}`);
    gui.setText(
      self.hint,
      message.status === "lost"
        ? "GAME OVER  /  PRESS R TO RESTART"
        : message.status === "won"
          ? "BOARD CLEARED  /  PRESS R TO RESTART"
          : message.status === "paused"
            ? "PAUSED  /  PRESS SPACE TO RESUME"
            : "ARROWS / WASD TO TURN    SPACE TO PAUSE    R TO RESTART",
    );
  },
});
