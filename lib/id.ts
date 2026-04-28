// Tiny unique-id helper. Avoids adding a nanoid dep for one call site.
export function newId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}_${r}`;
}
