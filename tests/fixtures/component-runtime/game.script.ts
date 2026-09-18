function defineComponent<const Definition>(definition: Definition): Definition { return definition; }
const property = { number(value: number): number { return value; } };
const host = (globalThis as typeof globalThis & {
  __defoldHostV1: { log(level: string, message: string): void };
}).__defoldHostV1;

export default defineComponent({
  properties: { speed: property.number(120) },
  init(self: { speed?: number; reloads?: number; total?: number }): void {
    host.log("info", `game:init:${self.speed ?? 0}`);
  },
  update(self: { total?: number }, dt: number): void {
    self.total = (self.total ?? 0) + dt;
    host.log("info", `game:update:${self.total.toFixed(2)}`);
  },
  onMessage(_self: unknown, messageId: string, message: { damage: number }, sender: string): void {
    host.log("info", `game:message:${messageId}:${message.damage}:${sender}`);
  },
  onInput(_self: unknown, actionId: string, action: {
    pressed: boolean;
    nested?: { label: string };
    samples?: readonly number[];
  }): boolean {
    if (action.nested) {
      host.log("info", `game:complex:${action.nested?.label}:${action.samples?.[1]}`);
    }
    host.log("info", `game:input:${actionId}:${action.pressed}`);
    return action.pressed;
  },
  onReload(self: { reloads?: number }): void {
    self.reloads = (self.reloads ?? 0) + 1;
    host.log("info", `game:reload:${self.reloads}`);
  },
  final(): void { host.log("info", "game:final:true"); }
});
