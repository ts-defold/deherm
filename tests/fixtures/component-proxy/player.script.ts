import { defineComponent, property } from "@ts-defold/deherm/component";

interface PlayerSelf {
  readonly speed: number;
}

export default defineComponent({
  properties: {
    speed: property.number(120),
    enabled: property.boolean(true),
    title: property.string("War Battles"),
    team: property.hash("blue"),
    target: property.url(),
    spawn: property.vector3(1, 2.5, -3),
    tint: property.vector4(1, 0.5, 0.25, 1),
    rotation: property.quaternion(0, 0, 0, 1),
    tankAtlas: property.atlas("/assets/tanks.atlas"),
  },

  init(self: PlayerSelf): void {
    void self;
  },

  update(_self: PlayerSelf, _dt: number): void {},
  final(_self: PlayerSelf): void {},
  onMessage(_self: PlayerSelf, _messageId: unknown, _message: unknown, _sender: unknown): void {},
  onInput(_self: PlayerSelf, _actionId: unknown, _action: unknown): boolean {
    return false;
  },
  onReload(_self: PlayerSelf): void {},
});
