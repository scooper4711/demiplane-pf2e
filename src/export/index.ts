/**
 * Export package: Foundry → Demiplane push pipeline.
 * hook-manager.ts (Foundry document hooks) feeds export-manager.ts
 * (debounced, retried push) via change-buffer.ts. Depends on core and sync
 * primitives only. This barrel is the complete public surface.
 */
export { ExportManager, ExportResult } from "./export-manager.js";
export { HookManager, queueAllDetailChanges, queueAllItemChanges, queueCombatResourceChanges } from "./hook-manager.js";
