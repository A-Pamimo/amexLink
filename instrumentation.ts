export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertBootConfig } = await import("./lib/boot");
    assertBootConfig();
  }
}
