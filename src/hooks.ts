/**
 * Re-exports HookManager for backward compatibility.
 *
 * The legacy registerHooks() function is retained as a convenience wrapper
 * for use in module.ts until task 13.1 wires the full component graph.
 */
export { HookManager } from "./hook-manager.js";
