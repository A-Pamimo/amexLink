/**
 * Error types shared across repos, sync and route handlers.
 * Messages carry ids only: never a token, ciphertext, or provider body.
 */

/**
 * The stored access token for an item cannot be decrypted (wrong data key,
 * tampered row, unknown key version). The item needs a re-link. Callers must
 * not retry the provider call; the ciphertext is never attached to this error.
 */
export class TokenUnreadableError extends Error {
  readonly item_id: string;
  constructor(item_id: string) {
    super(`access token for item ${item_id} cannot be decrypted; re-link required`);
    this.name = "TokenUnreadableError";
    this.item_id = item_id;
  }
}
