import { execFile, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "scripts", "sync.mjs");
const SECRET = "s".repeat(40);

function run(env: Record<string, string>, args: string[] = []) {
  // Fresh env: no inherited CRON_SECRET / BASE_URL.
  return spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("scripts/sync.mjs", () => {
  it("refuses to run without CRON_SECRET", () => {
    const r = run({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CRON_SECRET");
  });

  it("refuses a short CRON_SECRET", () => {
    expect(run({ CRON_SECRET: "short" }).status).toBe(1);
  });

  it("refuses a non-loopback BASE_URL unless --allow-remote, and never contacts it", () => {
    const r = run({ CRON_SECRET: SECRET, BASE_URL: "https://example.invalid" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not loopback");
    expect(r.stderr).not.toContain(SECRET);
  });

  it("sends the bearer, prints counts and codes only, exits non-zero when an item failed", async () => {
    let seenAuth: string | undefined;
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: [
            { item_id: "a", ok: true, added: 2, modified: 1, removed: 0 },
            { item_id: "b", ok: false, added: 0, modified: 0, removed: 0, error_code: "relink_required" },
          ],
          totals: { added: 2, modified: 1, removed: 0 },
          access_token: "access-sandbox-should-not-print",
        })
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        execFile(
          process.execPath,
          [script],
          { env: { PATH: process.env.PATH ?? "", CRON_SECRET: SECRET, BASE_URL: `http://127.0.0.1:${port}` } as unknown as NodeJS.ProcessEnv },
          (err, stdout, stderr) =>
            resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
        );
      });
      expect(seenAuth).toBe(`Bearer ${SECRET}`);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("item=a ok added=2 modified=1 removed=0");
      expect(r.stdout).toContain("item=b failed code=relink_required");
      expect(r.stdout).toContain("failed=1");
      expect(r.stdout + r.stderr).not.toContain("access-sandbox");
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    } finally {
      server.close();
    }
  });
});
