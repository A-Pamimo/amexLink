import { vi } from "vitest";

/** Capture everything the code under test writes to the console; call `.restore()` when done. */
export function captureConsole() {
  const chunks: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    })
  );
  return {
    text: () => chunks.join("\n"),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
