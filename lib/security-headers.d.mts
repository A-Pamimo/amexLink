export type Header = { key: string; value: string };
export function buildCsp(opts?: { nonce?: string; dev?: boolean; plaidEnv?: string; upgrade?: boolean }): string;
export function securityHeaders(opts?: { dev?: boolean; hsts?: boolean; plaidEnv?: string; csp?: boolean }): Header[];
export function isPlainHttpOrigin(origin: unknown): boolean;
export const HSTS_VALUE: string;
export const noStore: Header;
