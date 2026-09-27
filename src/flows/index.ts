/**
 * Flows package: cross-direction sync orchestration (guarded import, manual
 * export, push-conflict recovery). This is the single bridge allowed to reach
 * into import/ and export/ — always via their barrels. Sits above core,
 * sync, import, and export; depends on nothing else.
 * This barrel is the complete public surface.
 */
export {
  ExportCharacterFn,
  ImportCharacterFn,
  SyncFlowDeps,
  exportLinkedCharacter,
  handlePushConflict,
  importLinkedCharacter,
  recoverStaleSyncPauses,
} from "./sync-flows.js";
