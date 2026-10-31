#!/usr/bin/env node
// Prints a fresh 32-byte AES-256-GCM data key for TOKEN_ENCRYPTION_KEY.
// The key line goes to stdout (so `npm run key:generate >> .env.local` works);
// the reminder goes to stderr.
import { randomBytes } from "node:crypto";

process.stdout.write(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\n`);
process.stderr.write(
  "Store this key in a password manager. Never put it in data/, in backups, or in git; losing it means re-linking every card.\n"
);
