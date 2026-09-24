import {
  defold,
  defineComponent,
  type ComponentDefinition,
  go,
  hashLiteral,
  msg,
  property,
  vmath,
  type DefoldHash,
  type Vector3,
} from "@deherm/project";

import { MAX_PROJECTILES } from "../src/generated-war-battles/index";
import { arenaMatch, directionRadians, pixelX, pixelY } from "../src/arena-match";

/**
 * A projectile, in either of the two shapes this scene needs.
 *
 * `slot < 0` is the tutorial rocket: a physics-driven object with a `dir`
 * vector3 property, a kinematic collision object in the `rockets` group, and the
 * once-forward explosion. It is the scripted demonstration the packaged runtime
 * gates observe, and its behaviour and its markers are deliberately unchanged.
 *
 * `slot >= 0` is an arena shot: a pure renderer bound to one authoritative
 * projectile slot, with no physics at all. Hits, bounces and splash are decided
 * by `BattleWorld`, identically on the server and on every client; Box2D has no
 * opinion about them.
 */

const COLLISION_RESPONSE = hashLiteral("#collision_response");
const ANIMATION_DONE = hashLiteral("#animation_done");
const EXPLOSION = hashLiteral("#explosion");

const SPEED = 400;
const LIFETIME = 1;

/** Arena projectile sprites, indexed by weapon id. */
const WEAPON_SPRITES: readonly DefoldHash[] = [
  hashLiteral("#proj-cannon"),
  hashLiteral("#proj-cannon"),
  hashLiteral("#proj-machinegun"),
  hashLiteral("#proj-railgun"),
  hashLiteral("#proj-scatter"),
  hashLiteral("#proj-mortar"),
  hashLiteral("#proj-ricochet"),
];

interface RocketSelf {
  /** Editor property written by `factory.create` on the tutorial rocket. */
  dir: Vector3;
  /** Editor property: authoritative projectile slot, or -1 for the tutorial rocket. */
  slot: number;
  /** Editor property: the slot's generation when this object was created. */
  generation: number;
  /** Editor property: weapon id, used to pick the sprite. */
  weapon: number;
  speed: number;
  life: number;
  exploded: boolean;
  arena: boolean;
  z: number;
}

// The explicit type argument keeps the branded `Vector3` descriptor out of the
// declaration surface of this module's default export.
export default defineComponent<ComponentDefinition>({
  properties: {
    dir: property.vector3(0, 0, 0),
    slot: property.number(-1),
    generation: property.number(0),
    weapon: property.number(0),
  },

  init(self: RocketSelf): void {
    self.arena = Math.trunc(self.slot) >= 0;
    self.speed = SPEED;
    self.life = LIFETIME;
    self.exploded = false;
    if (self.arena) {
      self.z = go.getPosition().z;
      const weapon = Math.trunc(self.weapon);
      const sprite = WEAPON_SPRITES[weapon >= 0 && weapon < WEAPON_SPRITES.length ? weapon : 0]!;
      msg.post("#sprite", "play_animation", { id: sprite });
      return;
    }
    go.setRotation(vmath.quatRotationZ(Math.atan2(self.dir.y, self.dir.x)));
    defold.log("info", `war-battles:rocket-init:${self.dir.x.toFixed(2)}:${self.dir.y.toFixed(2)}`);
  },

  update(self: RocketSelf, dt: number): void {
    if (self.arena) {
      const world = arenaMatch()?.world;
      if (world === undefined) return;
      const slot = Math.trunc(self.slot);
      if (
        slot >= MAX_PROJECTILES ||
        world.projectileActive[slot] === 0 ||
        world.projectileGeneration[slot] !== Math.trunc(self.generation)
      ) {
        go.delete();
        return;
      }
      go.setPosition(vmath.vector3(pixelX(world.projectileX[slot]!), pixelY(world.projectileY[slot]!), self.z));
      go.setRotation(
        vmath.quatRotationZ(directionRadians(world.projectileDirectionX[slot]!, world.projectileDirectionY[slot]!)),
      );
      return;
    }

    if (self.exploded) return;
    self.life -= dt;
    if (self.life <= 0) {
      defold.log("info", "war-battles:rocket-expired");
      go.delete();
      return;
    }
    const position = go.getPosition();
    go.setPosition(
      vmath.vector3(position.x + self.dir.x * self.speed * dt, position.y + self.dir.y * self.speed * dt, position.z),
    );
  },

  onMessage(self: RocketSelf, messageId: DefoldHash, message: { readonly other_id: DefoldHash }): void {
    if (self.arena) return;
    if (messageId === COLLISION_RESPONSE) {
      if (self.exploded) return;
      self.exploded = true;
      go.delete(message.other_id);
      msg.post("/gui#ui", "add_score", { score: 100 });
      msg.post("#sprite", "play_animation", { id: EXPLOSION });
      go.setRotation(vmath.quat(0, 0, 0, 1));
      defold.log("info", "war-battles:rocket-hit");
    } else if (messageId === ANIMATION_DONE) {
      defold.log("info", "war-battles:rocket-explosion-done");
      go.delete();
    }
  },
});
