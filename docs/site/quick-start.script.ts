import { defold, defineComponent, go, property, vmath } from "@deherm/project";

interface Player {
  speed: number;
}

export default defineComponent({
  properties: {
    speed: property.number(180),
  },

  init(): void {
    defold.log("info", "TypeScript is running in Defold");
  },

  update(self: Player, dt: number): void {
    const position = go.getPosition();
    go.setPosition(vmath.vector3(position.x + self.speed * dt, position.y, position.z));
  },
});
