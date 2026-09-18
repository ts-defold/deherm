import type { DefoldHash, DefoldUrl, Quaternion, Vector3, Vector4 } from "./index";

export interface PropertyDescriptor<Value, Kind extends string> {
  readonly __value?: Value;
  readonly __kind?: Kind;
}

export interface DefoldResource<Kind extends string> {
  readonly __defoldResource?: Kind;
}

export type PropertyMap = Readonly<Record<string, PropertyDescriptor<unknown, string>>>;

export interface ComponentDefinition {
  readonly properties?: PropertyMap;
  init?(self: any): void;
  update?(self: any, dt: number): void;
  final?(self: any): void;
  onMessage?(self: any, messageId: DefoldHash, message: any, sender: DefoldUrl): void;
  onInput?(self: any, actionId: DefoldHash, action: any): boolean;
  onReload?(self: any): void;
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
  vector3(_x: number, _y: number, _z: number): PropertyDescriptor<Vector3, "vector3"> {
    return descriptor();
  },
  vector4(_x: number, _y: number, _z: number, _w: number): PropertyDescriptor<Vector4, "vector4"> {
    return descriptor();
  },
  quaternion(_x: number, _y: number, _z: number, _w: number): PropertyDescriptor<Quaternion, "quaternion"> {
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

export function defineComponent<const Definition extends ComponentDefinition>(definition: Definition): Definition {
  return definition;
}
