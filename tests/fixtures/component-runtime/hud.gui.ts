function defineComponent<const Definition>(definition: Definition): Definition { return definition; }
const host = (globalThis as typeof globalThis & {
  __defoldHostV1: { log(level: string, message: string): void };
}).__defoldHostV1;

export default defineComponent({
  init(): void { host.log("info", "gui:init:0"); },
  update(_self: unknown, dt: number): void { host.log("info", `gui:update:${dt.toFixed(2)}`); },
  onMessage(_self: unknown, messageId: string, message: { damage: number }, sender: string): void {
    host.log("info", `gui:message:${messageId}:${message.damage}:${sender}`);
  },
  onInput(_self: unknown, actionId: string, action: { pressed: boolean }): boolean {
    host.log("info", `gui:input:${actionId}:${action.pressed}`);
    return action.pressed;
  },
  onReload(self: { reloads?: number }): void {
    self.reloads = (self.reloads ?? 0) + 1;
    host.log("info", `gui:reload:${self.reloads}`);
  },
  final(): void { host.log("info", "gui:final:true"); }
});
