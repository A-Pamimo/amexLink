import { vi } from "vitest";

/**
 * Capture everything the code under test writes to the console AND to the raw
 * stdout/stderr streams (`lib/log.ts` writes JSON lines with
 * `process.stdout.write` / `process.stderr.write`, bypassing `console`).
 * Call `.restore()` when done.
 */
export function captureConsole() {
  const chunks: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    })
  );
  for (const stream of [process.stdout, process.stderr]) {
    spies.push(
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
        chunks.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as typeof stream.write)
    );
  }
  return {
    text: () => chunks.join("\n"),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
