import { defineComponent, hashLiteral, msg, property, type DefoldHash } from "@deherm/project";

const LANDMARKS: readonly DefoldHash[] = [
  hashLiteral("#landmark-field-bunker"),
  hashLiteral("#landmark-rock-outcrop"),
  hashLiteral("#landmark-supply-dump"),
  hashLiteral("#landmark-tank-wreck"),
  hashLiteral("#landmark-fuel-cluster"),
  hashLiteral("#landmark-gun-nest"),
  hashLiteral("#landmark-radio-mast"),
  hashLiteral("#landmark-scrap-barricade"),
  hashLiteral("#landmark-shell-crater"),
];

interface LandmarkSelf {
  /** Editor/factory property: generated landmark index. */
  kind: number;
}

export default defineComponent({
  properties: {
    kind: property.number(0),
  },

  init(self: LandmarkSelf): void {
    const index = Math.max(0, Math.min(LANDMARKS.length - 1, Math.trunc(self.kind)));
    msg.post("#sprite", "play_animation", { id: LANDMARKS[index]! });
  },
});
