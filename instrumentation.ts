export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { log } = await import("./lib/log");
    try {
      const { assertBootConfig } = await import("./lib/boot");
      assertBootConfig();
    } catch (err) {
      // Next 15 would otherwise keep the process alive and answer 500s. A
      // supervisor (systemd, docker) needs a non-zero exit to notice and alert.
      const reason = err instanceof Error ? err.message : String(err);
      log.error("boot_refused", { reason });
      process.exit(1);
    }
  }
}
