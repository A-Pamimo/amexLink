// Unique-id helper. Ids are unguessable (CSPRNG), not time-ordered.
export function newId(): string {
  return crypto.randomUUID();
}
