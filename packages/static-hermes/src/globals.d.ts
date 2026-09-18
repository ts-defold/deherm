/** TypeScript checker projection of Static Hermes compiler intrinsics. */
type c_u32 = number;
type c_f32 = number;
type c_f64 = number;

declare const $SHBuiltin: {
  extern_c<T extends (...args: never[]) => unknown>(
    options: { include?: string; declared?: boolean; hv?: boolean },
    declaration: T
  ): T;
};
