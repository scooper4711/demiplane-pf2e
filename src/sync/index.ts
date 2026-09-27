/**
 * Sync coordination package: link integrity, write gating, pause tokens,
 * writer election, issue store, and notices. Depends only on core.
 * Cross-direction orchestration lives in flows/ (above this package).
 * This barrel is the complete public surface.
 */
export { findActorLinkedTo, reconcileDuplicateLink } from "./actor-link.js";
export { isClientElectedWriter } from "./sync-election.js";
export {
  ISSUES_CHANGED_EVENT,
  acknowledgeIssues,
  addExportIssue,
  addImportIssues,
  clearConflictNotified,
  getChoiceOverrides,
  getExportIssues,
  getImportIssues,
  getUnmappedSlugs,
  getUnresolvedChoices,
  hasNotifiedConflict,
  markConflictNotified,
  removeChoiceOverride,
  resetImportIssues,
  setChoiceOverride,
  setUnmappedSlugs,
  setUnresolvedChoices,
  shouldShowIndicator,
} from "./sync-issues.js";
export { registerSyncNotice } from "./sync-notice.js";
export { beginSyncPause, clearSyncPause, endSyncPause, isRemoteSyncActive, isSyncActive } from "./sync-pause.js";
export {
  DEFAULT_WRITE_LEVEL,
  WRITE_LEVEL_DESCRIPTIONS,
  WRITE_LEVEL_LABELS,
  WRITE_LEVEL_SETTING,
  canDeleteInventory,
  canSoftDeleteInventory,
  canWriteBiography,
  canWriteCampaignNotes,
  canWriteCurrency,
  canWriteFocusPoints,
  canWriteHeroPoints,
  canWriteHitPoints,
  canWriteInventoryContainer,
  canWriteInventoryEquipped,
  canWriteInventoryQuantity,
  canWriteLanguages,
  canWriteOrganizedPlayId,
  canWriteSessionState,
  canWriteSpellSlots,
  isWritingEnabled,
  shouldSkipZeroQuantityItems,
} from "./write-level.js";
