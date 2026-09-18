/** Local authoring identity used until the context-filtered SDK exports the component helper. */
export function defineComponent<const Definition extends object>(definition: Definition): Definition {
  return definition;
}
