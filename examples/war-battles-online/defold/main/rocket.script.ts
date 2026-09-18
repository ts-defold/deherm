import {
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

declare const __defoldHostV1: {
  log(level: "info", message: string): void;
};

const COLLISION_RESPONSE = hashLiteral("#collision_response");
const ANIMATION_DONE = hashLiteral("#animation_done");
const EXPLOSION = hashLiteral("#explosion");

const SPEED = 400;
const LIFETIME = 1;

interface RocketSelf {
  /** Editor property written by `factory.create`. */
  dir: Vector3;
  speed: number;
  life: number;
  exploded: boolean;
}

interface CollisionResponse {
  readonly other_id: DefoldHash;
}

// The explicit type argument keeps the branded `Vector3` descriptor out of the
// declaration surface of this module's default export.
export default defineComponent<ComponentDefinition>({
  properties: {
    dir: property.vector3(0, 0, 0),
  },

  init(self: RocketSelf): void {
    self.speed = SPEED;
    self.life = LIFETIME;
    self.exploded = false;
    go.setRotation(vmath.quatRotationZ(Math.atan2(self.dir.y, self.dir.x)));
    __defoldHostV1.log("info", `war-battles:rocket-init:${self.dir.x.toFixed(2)}:${self.dir.y.toFixed(2)}`);
  },

  update(self: RocketSelf, dt: number): void {
    if (self.exploded) return;
    self.life -= dt;
    if (self.life <= 0) {
      __defoldHostV1.log("info", "war-battles:rocket-expired");
      go.delete();
      return;
    }
    const position = go.getPosition();
    go.setPosition(vmath.vector3(
      position.x + self.dir.x * self.speed * dt,
      position.y + self.dir.y * self.speed * dt,
      position.z,
    ));
  },

  onMessage(self: RocketSelf, messageId: DefoldHash, message: CollisionResponse): void {
    if (messageId === COLLISION_RESPONSE) {
      if (self.exploded) return;
      self.exploded = true;
      go.delete(message.other_id);
      msg.post("/gui#ui", "add_score", { score: 100 });
      msg.post("#sprite", "play_animation", { id: EXPLOSION });
      go.setRotation(vmath.quat(0, 0, 0, 1));
      __defoldHostV1.log("info", "war-battles:rocket-hit");
    } else if (messageId === ANIMATION_DONE) {
      __defoldHostV1.log("info", "war-battles:rocket-explosion-done");
      go.delete();
    }
  },
});
