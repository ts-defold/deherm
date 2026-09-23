/**
 * A small, explicit cell for state that must survive same-realm bundle
 * evaluation during component HMR. The registry lives on globalThis, so a
 * freshly evaluated module cannot replace a caller-owned cell accidentally.
 */
export interface HmrPersistentCell<Value> {
  value: Value;
}

const registryKey = "__dehermHmrPersistentStateV1";
type Registry = Record<string, HmrPersistentCell<unknown>>;

function registry(): Registry {
  const host = globalThis as typeof globalThis & {
    __dehermHmrPersistentStateV1?: Registry;
  };
  if (host[registryKey] === undefined) host[registryKey] = Object.create(null) as Registry;
  return host[registryKey];
}

export function hmrPersistentState<Value>(key: string, create: () => Value): HmrPersistentCell<Value> {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("hmrPersistentState key must be a non-empty string");
  const cells = registry();
  const existing = cells[key];
  if (existing !== undefined) return existing as HmrPersistentCell<Value>;
  const cell: HmrPersistentCell<Value> = { value: create() };
  cells[key] = cell as HmrPersistentCell<unknown>;
  return cell;
}
