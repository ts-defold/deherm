import path from "node:path";

/** ttsc descriptor for deherm compile-time language intrinsics. */
export default function dehermTtscPlugin(context) {
  return {
    name: "@ts-defold/deherm/ttsc",
    source: path.resolve(context.dirname, "ttsc/hash-literal"),
  };
}
