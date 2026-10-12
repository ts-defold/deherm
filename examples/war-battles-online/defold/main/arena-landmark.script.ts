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
  hashLiteral("#landmark-conifer-tall"),
  hashLiteral("#landmark-conifer-broad"),
  hashLiteral("#landmark-conifer-leaning"),
  hashLiteral("#landmark-low-cover-earth"),
  hashLiteral("#landmark-low-cover-stone"),
  hashLiteral("#landmark-low-cover-timber"),
  hashLiteral("#landmark-low-cover-rubble"),
  hashLiteral("#landmark-low-cover-neutral"),
  hashLiteral("#hex-cliff-0"),
  hashLiteral("#hex-cliff-1"),
  hashLiteral("#hex-cliff-2"),
  hashLiteral("#hex-cliff-3"),
  hashLiteral("#hex-cliff-4"),
  hashLiteral("#hex-cliff-5"),
  hashLiteral("#hex-cliff-6"),
  hashLiteral("#hex-cliff-7"),
  hashLiteral("#hex-cliff-8"),
  hashLiteral("#hex-cliff-9"),
  hashLiteral("#hex-cliff-10"),
  hashLiteral("#hex-cliff-11"),
  hashLiteral("#hex-cliff-12"),
  hashLiteral("#hex-cliff-13"),
  hashLiteral("#hex-cliff-14"),
  hashLiteral("#hex-cliff-15"),
  hashLiteral("#hex-cliff-16"),
  hashLiteral("#hex-cliff-17"),
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
