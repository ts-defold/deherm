import {
  defold,
  go,
  msg,
  vmath,
  type DefoldHash,
  type Vector3,
} from "@ts-defold/deherm";
import { defineComponent, property } from "@ts-defold/deherm/component";

interface RocketSelf {
  dir: Vector3;
  speed: number;
  life: number;
}

interface CollisionResponse {
  readonly otherId: DefoldHash;
}

const COLLISION_RESPONSE = defold.hash("collision_response");
const ANIMATION_DONE = defold.hash("animation_done");

function scaledAdd(position: Vector3, direction: Vector3, scale: number): Vector3 {
  return vmath.vector3(
    position.x + direction.x * scale,
    position.y + direction.y * scale,
    position.z + direction.z * scale,
  );
}

export default defineComponent({
  properties: {
    dir: property.vector3(0, 0, 0),
  },

  init(self: RocketSelf): void {
    self.speed = 400;
    self.life = 1.5;
  },

  update(self: RocketSelf, dt: number): void {
    self.life -= dt;
    if (self.life <= 0) {
      go.delete();
      return;
    }
    go.setPosition(scaledAdd(go.getPosition(), self.dir, self.speed * dt));
  },

  onMessage(_self: RocketSelf, messageId: DefoldHash, message: CollisionResponse): void {
    if (messageId === COLLISION_RESPONSE) {
      go.delete(message.otherId);
      msg.post("/gui#ui", "add_score", { score: 100 });
      msg.post("#sprite", "play_animation", { id: defold.hash("explosion") });
      go.setRotation(vmath.quat(0, 0, 0, 1));
    } else if (messageId === ANIMATION_DONE) {
      go.delete();
    }
  },
});
