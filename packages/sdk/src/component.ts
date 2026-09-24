import type { DefoldHash, DefoldUrl } from "./address";

export type { DefoldHash, DefoldUrl } from "./address";

// Component authoring is part of the revision-neutral npm package, while the
// full branded SDK is materialized from the selected Defold policy. Keep the
// editor-property shapes structural here so this subpath is independently
// usable before that revision-specific surface exists.
export type ComponentVector3 = Readonly<{ x: number; y: number; z: number }>;
export type ComponentVector4 = Readonly<{ x: number; y: number; z: number; w: number }>;
export type ComponentQuaternion = Readonly<{ x: number; y: number; z: number; w: number }>;

export interface PropertyDescriptor<Value, Kind extends string> {
  readonly __value?: Value;
  readonly __kind?: Kind;
}

export interface DefoldResource<Kind extends string> {
  readonly __defoldResource?: Kind;
}

export type PropertyMap = Readonly<Record<string, PropertyDescriptor<unknown, string>>>;

export type PropertyValue<Descriptor> =
  Descriptor extends PropertyDescriptor<infer Value, string> ? Value : never;

export type ComponentSelf<Properties extends PropertyMap> = {
  -readonly [Name in keyof Properties]: PropertyValue<Properties[Name]>;
};

export interface ComponentDefinition {
  readonly properties?: PropertyMap;
  init?(self: any): void;
  update?(self: any, dt: number): void;
  lateUpdate?(self: any, dt: number): void;
  fixedUpdate?(self: any, dt: number): void;
  final?(self: any): void;
  onMessage?(self: any, messageId: DefoldHash, message: any, sender: DefoldUrl): void;
  onInput?(self: any, actionId: DefoldHash, action: any): boolean;
  onReload?(self: any): void;
}

/**
 * Base lifecycle contract for a class-authored game-object component.
 *
 * Editor properties are copied onto the instance before `init`. Declare their
 * direct fields for ergonomic `this.speed` access, or supply the property map
 * generic and use the allocation-free `this.props.speed` view.
 */
export class ScriptComponent<Properties extends PropertyMap = PropertyMap> {
  get props(): ComponentSelf<Properties> {
    return this as unknown as ComponentSelf<Properties>;
  }
}

export interface ScriptComponent<Properties extends PropertyMap = PropertyMap> {
  init?(): void;
  update?(dt: number): void;
  lateUpdate?(dt: number): void;
  fixedUpdate?(dt: number): void;
  final?(): void;
  onMessage?(messageId: DefoldHash, message: unknown, sender: DefoldUrl): void;
  onInput?(actionId: DefoldHash, action: unknown): boolean;
  onReload?(): void;
}

/** Class authoring contract for a `*.gui.ts` component. */
export class GuiComponent<Properties extends PropertyMap = PropertyMap> extends ScriptComponent<Properties> {}

/** Class authoring contract for a `*.render.ts` component. */
export class RenderComponent<Properties extends PropertyMap = PropertyMap> {
  get props(): ComponentSelf<Properties> {
    return this as unknown as ComponentSelf<Properties>;
  }
}

export interface RenderComponent<Properties extends PropertyMap = PropertyMap> {
  init?(): void;
  update?(dt: number): void;
  onMessage?(messageId: DefoldHash, message: unknown, sender: DefoldUrl): void;
  onReload?(): void;
}

export type ComponentClassInstance<Properties extends PropertyMap = PropertyMap> =
  ScriptComponent<Properties> | GuiComponent<Properties> | RenderComponent<Properties>;

export interface ComponentClass<
  Properties extends PropertyMap = PropertyMap,
  Instance extends ComponentClassInstance = ComponentClassInstance
> {
  new(): Instance;
  readonly properties?: Properties;
}

function descriptor<Value, Kind extends string>(): PropertyDescriptor<Value, Kind> {
  // Property declarations are consumed statically by the component generator.
  // A shared frozen sentinel avoids allocating one object per property at runtime.
  return emptyDescriptor as PropertyDescriptor<Value, Kind>;
}

const emptyDescriptor = Object.freeze({});

export const property = Object.freeze({
  number(_value: number): PropertyDescriptor<number, "number"> {
    return descriptor();
  },
  boolean(_value: boolean): PropertyDescriptor<boolean, "boolean"> {
    return descriptor();
  },
  string(_value: string): PropertyDescriptor<string, "string"> {
    return descriptor();
  },
  hash(_value: string): PropertyDescriptor<DefoldHash, "hash"> {
    return descriptor();
  },
  url(): PropertyDescriptor<DefoldUrl, "url"> {
    return descriptor();
  },
  vector3(_x: number, _y: number, _z: number): PropertyDescriptor<ComponentVector3, "vector3"> {
    return descriptor();
  },
  vector4(_x: number, _y: number, _z: number, _w: number): PropertyDescriptor<ComponentVector4, "vector4"> {
    return descriptor();
  },
  quaternion(_x: number, _y: number, _z: number, _w: number): PropertyDescriptor<ComponentQuaternion, "quaternion"> {
    return descriptor();
  },
  /**
   * Revision-parametric resource property. Use this when a selected Defold
   * policy exposes a resource constructor newer than the convenience methods
   * below; the component compiler validates `kind` against that policy.
   */
  resource<const Kind extends string>(_kind: Kind, _path?: string): PropertyDescriptor<DefoldResource<Kind>, "resource"> {
    return descriptor();
  },
  atlas(_path?: string): PropertyDescriptor<DefoldResource<"atlas">, "atlas"> {
    return descriptor();
  },
  buffer(_path?: string): PropertyDescriptor<DefoldResource<"buffer">, "buffer"> {
    return descriptor();
  },
  font(_path?: string): PropertyDescriptor<DefoldResource<"font">, "font"> {
    return descriptor();
  },
  material(_path?: string): PropertyDescriptor<DefoldResource<"material">, "material"> {
    return descriptor();
  },
  renderTarget(_path?: string): PropertyDescriptor<DefoldResource<"renderTarget">, "renderTarget"> {
    return descriptor();
  },
  texture(_path?: string): PropertyDescriptor<DefoldResource<"texture">, "texture"> {
    return descriptor();
  },
  tileSource(_path?: string): PropertyDescriptor<DefoldResource<"tileSource">, "tileSource"> {
    return descriptor();
  }
});

export function defineComponent<const Definition extends ComponentDefinition>(
  definition: Definition
): Definition {
  return definition;
}

const classInstanceSlot = "__deherm_component_class_instance_v1";

interface InternalClassInstance {
  init?: () => void;
  update?: (dt: number) => void;
  lateUpdate?: (dt: number) => void;
  fixedUpdate?: (dt: number) => void;
  final?: () => void;
  onMessage?: (messageId: DefoldHash, message: unknown, sender: DefoldUrl) => void;
  onInput?: (actionId: DefoldHash, action: unknown) => boolean;
  onReload?: () => void;
  [name: string]: unknown;
}

interface InternalComponentSelf {
  [classInstanceSlot]?: InternalClassInstance;
  [name: string]: unknown;
}

function ensureClassInstance(
  Type: new() => InternalClassInstance,
  self: InternalComponentSelf,
  propertyNames: readonly string[]
): InternalClassInstance {
  const retained = self[classInstanceSlot];
  if (retained) return retained;

  const instance = new Type();
  for (let index = 0; index < propertyNames.length; ++index) {
    const name = propertyNames[index];
    instance[name] = self[name];
  }
  Object.defineProperty(self, classInstanceSlot, {
    configurable: true,
    value: instance,
  });
  return instance;
}

/**
 * Adapt a class-authored component to the same definition ABI used by
 * `defineComponent`. Generation reads the class declaration statically; this
 * runtime adapter only creates one state instance per attached Defold instance
 * and forwards lifecycle calls with that state as `this`.
 */
export function component<
  const Properties extends PropertyMap,
  Instance extends ComponentClassInstance
>(Type: ComponentClass<Properties, Instance>): ComponentDefinition {
  const InternalType = Type as unknown as new() => InternalClassInstance;
  const prototype = InternalType.prototype;
  const properties = Type.properties;
  const propertyNames = properties ? Object.keys(properties) : [];
  const definition: ComponentDefinition = properties ? { properties } : {};

  const init = prototype.init;
  definition.init = function classInit(self): void {
    const instance = ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames);
    if (typeof init === "function") {
      init.call(instance);
    }
  };

  const update = prototype.update;
  if (typeof update === "function") {
    definition.update = function classUpdate(self, dt): void {
      update.call(ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames), dt);
    };
  }

  const lateUpdate = prototype.lateUpdate;
  if (typeof lateUpdate === "function") {
    definition.lateUpdate = function classLateUpdate(self, dt): void {
      lateUpdate.call(ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames), dt);
    };
  }

  const fixedUpdate = prototype.fixedUpdate;
  if (typeof fixedUpdate === "function") {
    definition.fixedUpdate = function classFixedUpdate(self, dt): void {
      fixedUpdate.call(ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames), dt);
    };
  }

  const final = prototype.final;
  if (typeof final === "function") {
    definition.final = function classFinal(self): void {
      final.call(ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames));
    };
  }

  const onMessage = prototype.onMessage;
  if (typeof onMessage === "function") {
    definition.onMessage = function classOnMessage(self, messageId, message, sender): void {
      onMessage.call(
        ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames),
        messageId,
        message,
        sender
      );
    };
  }

  const onInput = prototype.onInput;
  if (typeof onInput === "function") {
    definition.onInput = function classOnInput(self, actionId, action): boolean {
      return onInput.call(
        ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames),
        actionId,
        action
      );
    };
  }

  const onReload = prototype.onReload;
  if (typeof onReload === "function") {
    definition.onReload = function classOnReload(self): void {
      onReload.call(ensureClassInstance(InternalType, self as InternalComponentSelf, propertyNames));
    };
  }

  return definition;
}
