import "server-only";

/**
 * Per-item in-process mutex: a promise chain keyed by item_id. Single Node process and a
 * single SQLite file make this sufficient (SECURITY.md F-13). State is on globalThis so route
 * bundles that each include this module still share one lock table.
 */
const KEY = Symbol.for("amexlens.itemLocks");

function locks(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  return (g[KEY] ??= new Map());
}

export async function withItemLock<T>(item_id: string, fn: () => Promise<T>): Promise<T> {
  const table = locks();
  const prev = table.get(item_id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `gate` always resolves, so the chain never rejects.
  const tail = prev.then(() => gate);
  table.set(item_id, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (table.get(item_id) === tail) table.delete(item_id);
  }
}

/** Test hook: returns the live lock table (empty when nothing is held or queued). */
export const _locksForTest = locks;
