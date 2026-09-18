declare module "@ts-defold/deherm/component" {
  interface PropertyDescriptor<Value, Kind extends string> {
    readonly __value?: Value;
    readonly __kind?: Kind;
  }

  interface DefoldHash { readonly __defoldHash: unique symbol }
  interface DefoldUrl { readonly __defoldUrl: unique symbol }
  interface DefoldVector3 { readonly __defoldVector3: unique symbol }
  interface DefoldVector4 { readonly __defoldVector4: unique symbol }
  interface DefoldQuaternion { readonly __defoldQuaternion: unique symbol }
  interface DefoldResource<Kind extends string> { readonly __defoldResource?: Kind }

  type PropertyMap = Readonly<Record<string, PropertyDescriptor<unknown, string>>>;
  type PropertyValue<Descriptor> = Descriptor extends PropertyDescriptor<infer Value, string> ? Value : never;
  type ComponentSelf<Properties extends PropertyMap> = {
    -readonly [Name in keyof Properties]: PropertyValue<Properties[Name]>;
  };

  interface ComponentDefinition<Properties extends PropertyMap> {
    readonly properties?: Properties;
    init?(self: ComponentSelf<Properties>): void;
    update?(self: ComponentSelf<Properties>, dt: number): void;
    final?(self: ComponentSelf<Properties>): void;
    onMessage?(self: ComponentSelf<Properties>, messageId: unknown, message: unknown, sender: unknown): void;
    onInput?(self: ComponentSelf<Properties>, actionId: unknown, action: unknown): boolean;
    onReload?(self: ComponentSelf<Properties>): void;
  }

  export const property: {
    number(value: number): PropertyDescriptor<number, "number">;
    boolean(value: boolean): PropertyDescriptor<boolean, "boolean">;
    string(value: string): PropertyDescriptor<string, "string">;
    hash(value: string): PropertyDescriptor<DefoldHash, "hash">;
    url(): PropertyDescriptor<DefoldUrl, "url">;
    vector3(x: number, y: number, z: number): PropertyDescriptor<DefoldVector3, "vector3">;
    vector4(x: number, y: number, z: number, w: number): PropertyDescriptor<DefoldVector4, "vector4">;
    quaternion(x: number, y: number, z: number, w: number): PropertyDescriptor<DefoldQuaternion, "quaternion">;
    atlas(path?: string): PropertyDescriptor<DefoldResource<"atlas">, "atlas">;
    buffer(path?: string): PropertyDescriptor<DefoldResource<"buffer">, "buffer">;
    font(path?: string): PropertyDescriptor<DefoldResource<"font">, "font">;
    material(path?: string): PropertyDescriptor<DefoldResource<"material">, "material">;
    renderTarget(path?: string): PropertyDescriptor<DefoldResource<"renderTarget">, "renderTarget">;
    texture(path?: string): PropertyDescriptor<DefoldResource<"texture">, "texture">;
    tileSource(path?: string): PropertyDescriptor<DefoldResource<"tileSource">, "tileSource">;
  };

  export function defineComponent<const Properties extends PropertyMap>(
    definition: ComponentDefinition<Properties>
  ): ComponentDefinition<Properties>;
}
