import { MODULE_ID } from "./types.js";

/**
 * Logs a debug message to the console when the debugImport setting is enabled.
 * All import lifecycle logging flows through this function.
 */
export function debugLog(message: string): void {
  try {
    if (game.settings.get(MODULE_ID, "debugImport")) {
      console.warn(`${MODULE_ID} | [debug] ${message}`);
    }
  } catch {
    // Settings not yet registered (e.g. during early init) — silently skip
  }
}
