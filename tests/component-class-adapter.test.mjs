import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { build } from "esbuild";

const componentSdk = path.resolve("packages/sdk/src/component.ts");

test("class adapter creates one instance, copies properties, and retains state across definition reload", async () => {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: "component-class-runtime.ts",
      loader: "ts",
      contents: `
        import { component, defineComponent, property, ScriptComponent } from "@ts-defold/deherm/component";

        const properties = { speed: property.number(3) } as const;
        let constructors = 0;

        class First extends ScriptComponent<typeof properties> {
          static readonly properties = properties;
          counter = 0;
          constructor() { super(); constructors += 1; }
          init(): void { this.counter = this.props.speed; }
          update(dt: number): void { this.counter += dt; }
          onInput(): boolean { return this.counter > 0; }
        }

        class Reloaded extends ScriptComponent<typeof properties> {
          static readonly properties = properties;
          counter = -1000;
          constructor() { super(); constructors += 1; }
          update(dt: number): void { this.counter += dt * 10; }
          onReload(): void { this.counter += 100; }
        }

        class ConstructorOnly extends ScriptComponent {
          constructor() { super(); constructors += 1; }
        }

        const first = component(First);
        const reloaded = component(Reloaded);
        const constructorOnly = component(ConstructorOnly);
        const backing = { speed: 7 };
        first.init?.(backing);
        first.update?.(backing, 2);
        const consumed = first.onInput?.(backing, 1n as never, {});
        reloaded.update?.(backing, 3);
        reloaded.onReload?.(backing);

        const secondBacking = { speed: 4 };
        first.init?.(secondBacking);
        first.update?.(secondBacking, 1);
        constructorOnly.init?.({});

        const objectDefinition = defineComponent({ init(self: { value?: number }) { self.value = 9; } });
        const objectSelf: { value?: number } = {};
        objectDefinition.init?.(objectSelf);

        (globalThis as any).__classAdapterResult = {
          constructors,
          consumed,
          retainedCounter: (backing as any).__deherm_component_class_instance_v1.counter,
          secondCounter: (secondBacking as any).__deherm_component_class_instance_v1.counter,
          enumerableBackingKeys: Object.keys(backing),
          objectIdentity: objectSelf.value,
        };
      `
    },
    alias: {
      "@ts-defold/deherm/component": componentSdk
    },
    bundle: true,
    format: "iife",
    platform: "neutral",
    target: "es2020",
    write: false
  });
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(result.outputFiles[0].text, context);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__classAdapterResult)),
    {
      constructors: 3,
      consumed: true,
      retainedCounter: 139,
      secondCounter: 5,
      enumerableBackingKeys: ["speed"],
      objectIdentity: 9
    }
  );
});
