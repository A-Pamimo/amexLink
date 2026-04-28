#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DB_PATH ?? "data/amexlens.sqlite";
const backupsDir = path.join(path.dirname(dbPath), "backups");

if (!fs.existsSync(dbPath)) {
  console.error(`No db file at ${dbPath}`);
  process.exit(1);
}
fs.mkdirSync(backupsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(backupsDir, `amexlens-${stamp}.sqlite`);
fs.copyFileSync(dbPath, dest);
console.log(`backed up -> ${dest}`);
