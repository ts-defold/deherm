import {
  component,
  property,
  ScriptComponent,
  type DefoldHash,
} from "@ts-defold/deherm/component";

class ClassPlayer extends ScriptComponent {
  static readonly properties = {
    speed: property.number(90),
    team: property.hash("blue"),
  } as const;

  declare speed: number;
  declare team: DefoldHash;
  private elapsed = 0;

  init(): void {
    this.elapsed = this.speed;
  }

  update(dt: number): void {
    this.elapsed += dt;
  }

  onInput(_actionId: DefoldHash, _action: unknown): boolean {
    return false;
  }

  onReload(): void {
    this.elapsed += 1;
  }
}

export default component(ClassPlayer);
