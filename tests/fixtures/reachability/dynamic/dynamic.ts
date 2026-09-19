// A project that indexes the generated Defold surface with a computed name.
// The checker cannot resolve which route this reaches, so a release build must
// be told explicitly that it is opting into the complete surface.
import { gui } from "@ts-defold/deherm";

export function reach(key: "getScreenPosition" | "getId"): unknown {
  return gui[key](gui.getNode("root"));
}
