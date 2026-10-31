export type Header = { key: string; value: string };
export function buildCsp(opts?: { nonce?: string; dev?: boolean; plaidEnv?: string }): string;
export function securityHeaders(opts?: { dev?: boolean; hsts?: boolean; plaidEnv?: string; csp?: boolean }): Header[];
export const noStore: Header;
