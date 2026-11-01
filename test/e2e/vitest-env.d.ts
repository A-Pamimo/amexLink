import type { E2EContext } from "./helpers/client";

declare module "vitest" {
  export interface ProvidedContext {
    e2e: E2EContext;
  }
}
