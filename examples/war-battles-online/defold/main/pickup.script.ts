import { defineComponent, go, hashLiteral, msg, property, type DefoldHash } from "@deherm/project";

import {
  PICKUP_ARMOR,
  PICKUP_HEALTH,
  PICKUP_OVERDRIVE,
  WEAPON_AUTOCANNON,
  WEAPON_MORTAR,
  WEAPON_RAILGUN,
  WEAPON_RICOCHET,
  WEAPON_SCATTER,
} from "../src/generated-war-battles/index";
import { arenaMatch } from "../src/arena-match";

/**
 * One pickup pad.
 *
 * Pads are created by the arena director when the simulation says the pad is
 * live, and each one removes itself the moment its pad is taken. That is a
 * deliberate choice over enabling and disabling a sprite: creation and deletion
 * are the two object-lifetime routes this port has actually executed in a
 * packaged engine, and a pad changes state a handful of times a minute.
 */

const SPRITES: ReadonlyMap<number, DefoldHash> = new Map<number, DefoldHash>([
  [WEAPON_AUTOCANNON, hashLiteral("#pickup-machinegun")],
  [WEAPON_RAILGUN, hashLiteral("#pickup-railgun")],
  [WEAPON_SCATTER, hashLiteral("#pickup-scatter")],
  [WEAPON_MORTAR, hashLiteral("#pickup-mortar")],
  [WEAPON_RICOCHET, hashLiteral("#pickup-ricochet")],
  [PICKUP_HEALTH, hashLiteral("#pickup-health")],
  [PICKUP_ARMOR, hashLiteral("#pickup-armor")],
  [PICKUP_OVERDRIVE, hashLiteral("#pickup-overdrive")],
]);

interface PickupSelf {
  /** Editor property: the simulation pad this object draws. */
  index: number;
  /** Editor property: the pad's kind, so the sprite is right on the first frame. */
  kind: number;
}

export default defineComponent({
  properties: {
    index: property.number(0),
    kind: property.number(0),
  },

  init(self: PickupSelf): void {
    const sprite = SPRITES.get(Math.trunc(self.kind));
    if (sprite !== undefined) msg.post("#sprite", "play_animation", { id: sprite });
  },

  update(self: PickupSelf, _dt: number): void {
    const world = arenaMatch()?.world;
    if (world === undefined) return;
    if (world.pickupActive[Math.trunc(self.index)] === 0) go.delete();
  },
});
