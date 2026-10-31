import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { seedTotp, stateFileFor, writeState, type E2EContext } from "./helpers/client";
import { buildOnce, makeConfig, startServer, stopServer, type RunningServer } from "./helpers/server";

export const MAIN_PORT = 3131;

let server: RunningServer | null = null;
let dir: string | null = null;

export async function setup(project: TestProject): Promise<void> {
  buildOnce();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "amexlens-e2e-"));
  const cfg = makeConfig(MAIN_PORT, dir);
  server = await startServer(cfg);

  // Enrol the first factor exactly as the owner would, through the setup routes.
  const seeded = await seedTotp(cfg);
  const stateFile = stateFileFor(dir);
  writeState(stateFile, { secret: seeded.secret, lastStep: seeded.lastStep, recovery: seeded.recovery });

  const ctx: E2EContext = {
    base: cfg.origin,
    origin: cfg.origin,
    dbPath: cfg.dbPath,
    logFile: cfg.logFile,
    setupToken: cfg.setupToken,
    cronSecret: cfg.cronSecret,
    stateFile,
  };
  project.provide("e2e", ctx);
}

export async function teardown(): Promise<void> {
  if (server) await stopServer(server);
  server = null;
  if (dir && process.env.E2E_KEEP_TMP !== "1") fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}
