import { MODULE_ID } from "./types.js";

/**
 * Logs a debug message to the console when the debugImport setting is enabled.
 * All import lifecycle logging flows through this function.
 */
export function debugLog(message: string, ...rest: unknown[]): void {
  try {
    if (game.settings.get(MODULE_ID, "debugImport")) {
      // eslint-disable-next-line no-console -- console.log avoids the call stack that console.warn attaches to each debug line
      console.log(`${MODULE_ID} | [debug] ${message}`, ...rest);
    }
  } catch {
    // Settings not yet registered (e.g. during early init) — silently skip
  }
}
