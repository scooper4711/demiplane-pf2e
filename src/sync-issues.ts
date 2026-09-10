import { MODULE_ID } from "./import/types.js";
import type { ChoiceKey, ChoiceOverrides, UnmappedSlug, UnresolvedChoice } from "./import/types.js";

export const ISSUES_CHANGED_EVENT = "demiplaneSyncIssuesChanged";

type IssueSetKind = "import" | "export";

const UNMAPPED_FLAG = "unmappedSlugs";
const UNRESOLVED_CHOICES_FLAG = "unresolvedChoices";
const CHOICE_OVERRIDES_FLAG = "choiceOverrides";
const ACKNOWLEDGED_FLAG = "issuesAcknowledged";
const CONFLICT_NOTIFIED_FLAG = "conflictNotified";

/**
 * Reads the two sync-issue sets stored on the actor.
 *
 * - `import`: cleared at the start of each import, then repopulated as issues
 *   are encountered (missing slugs, import errors).
 * - `export`: accumulates over time as push problems arise (auth failures,
 *   quantity limits, failed pushes).
 *
 * These sets, plus the unmapped slugs, are the persistent record of what the
 * last sync produced. They are the data the dialog shows and the mapping editor
 * consumes, so they must survive the user glancing at them: dismissing the
 * dialog only marks them acknowledged (see `acknowledgeIssues`), it does not
 * delete them. A fresh import replaces them wholesale (`resetImportIssues`).
 *
 * The red indicator is separate from the data: it means "the latest sync
 * produced issues no one has looked at yet" — see `shouldShowIndicator`.
 */
export function getImportIssues(actor: Actor): Set<string> {
  return readIssueSet(actor, "import");
}

export function getExportIssues(actor: Actor): Set<string> {
  return readIssueSet(actor, "export");
}

/**
 * Slugs the last import could not resolve, stored as structured records.
 *
 * These are the single source of truth for unmapped slugs: the sync dialog
 * renders them through `formatUnmapped`, and the GM mapping screen groups them.
 * They are replaced wholesale on each import, so a slug that starts resolving
 * (via a new mapping, or new content) drops out with no pruning needed.
 */
export function getUnmappedSlugs(actor: Actor): UnmappedSlug[] {
  const raw = actor.getFlag(MODULE_ID, UNMAPPED_FLAG) as UnmappedSlug[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

export function setUnmappedSlugs(actor: Actor, records: UnmappedSlug[]): void {
  void actor.setFlag(MODULE_ID, UNMAPPED_FLAG, records);
  if (records.length > 0) markUnacknowledged(actor);
  notifyChanged(actor);
}

/**
 * ChoiceSets the last import could not resolve, stored as structured records.
 *
 * Mirrors unmapped slugs: the sync dialog renders dropdowns from these, and
 * they are replaced wholesale on each import, so a record whose ChoiceSet
 * starts resolving (or disappears) drops out with no pruning needed.
 */
export function getUnresolvedChoices(actor: Actor): UnresolvedChoice[] {
  const raw = actor.getFlag(MODULE_ID, UNRESOLVED_CHOICES_FLAG) as UnresolvedChoice[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

export function setUnresolvedChoices(actor: Actor, records: UnresolvedChoice[]): void {
  void actor.setFlag(MODULE_ID, UNRESOLVED_CHOICES_FLAG, records);
  if (records.length > 0) markUnacknowledged(actor);
  notifyChanged(actor);
}

/**
 * The actor's stored ChoiceSet picks (`key -> option value`). Per-actor, not a
 * world setting: a choice belongs to one character's build. Unlike the
 * unresolved records above, overrides are NEVER cleared by imports — they must
 * survive so re-imports keep honoring them; stale ones simply stop matching
 * and go inert.
 */
export function getChoiceOverrides(actor: Actor): ChoiceOverrides {
  const raw = actor.getFlag(MODULE_ID, CHOICE_OVERRIDES_FLAG) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return {};
  const overrides: ChoiceOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") overrides[key as ChoiceKey] = value;
  }
  return overrides;
}

/** Stores one user pick. Deliberately does not touch acknowledgement: an
 * override is user data answering an issue, not a new issue. */
export function setChoiceOverride(actor: Actor, key: ChoiceKey, value: string): void {
  const overrides = getChoiceOverrides(actor);
  overrides[key] = value;
  void actor.setFlag(MODULE_ID, CHOICE_OVERRIDES_FLAG, overrides);
  notifyChanged(actor);
}

/** Removes one user pick (the dialog's explicit "not chosen" state). */
export function removeChoiceOverride(actor: Actor, key: ChoiceKey): void {
  const overrides = getChoiceOverrides(actor);
  if (!(key in overrides)) return;
  delete overrides[key];
  void actor.setFlag(MODULE_ID, CHOICE_OVERRIDES_FLAG, overrides);
  notifyChanged(actor);
}

/** True when any issue data is currently stored, regardless of acknowledgement. */
export function hasActiveIssues(actor: Actor): boolean {
  return (
    getImportIssues(actor).size > 0 ||
    getExportIssues(actor).size > 0 ||
    getUnmappedSlugs(actor).length > 0 ||
    getUnresolvedChoices(actor).length > 0
  );
}

/**
 * Whether the red indicator should be shown: there are issues AND no one has
 * acknowledged the current batch by dismissing the dialog. Acknowledgement is
 * reset whenever new issues arrive, so a fresh sync relights the dot.
 */
export function shouldShowIndicator(actor: Actor): boolean {
  return hasActiveIssues(actor) && !isAcknowledged(actor);
}

/**
 * Marks the current issues as seen without deleting them, so the dialog still
 * shows them (and the mapping editor still has the unmapped slugs) on a second
 * open. Used by the sync dialog's Dismiss button.
 */
export function acknowledgeIssues(actor: Actor): void {
  void actor.setFlag(MODULE_ID, ACKNOWLEDGED_FLAG, true);
  notifyChanged(actor);
}

/**
 * Clears the import set and unmapped slugs at the start of a fresh import and
 * resets acknowledgement, so any issues the new import produces relight the
 * dot and a clean import turns it off.
 */
export function resetImportIssues(actor: Actor): void {
  void writeIssueSet(actor, "import", new Set());
  void actor.setFlag(MODULE_ID, UNMAPPED_FLAG, []);
  void actor.setFlag(MODULE_ID, UNRESOLVED_CHOICES_FLAG, []);
  void actor.setFlag(MODULE_ID, ACKNOWLEDGED_FLAG, false);
  // An import re-baselines the character (fresh lastUpdated/engineSig), so any
  // prior conflict is resolved — re-arm the conflict warning for the future.
  void actor.setFlag(MODULE_ID, CONFLICT_NOTIFIED_FLAG, false);
  notifyChanged(actor);
}

/** Clears every issue set and the acknowledgement flag. */
export function clearAllIssues(actor: Actor): void {
  void writeIssueSet(actor, "import", new Set());
  void writeIssueSet(actor, "export", new Set());
  void actor.setFlag(MODULE_ID, UNMAPPED_FLAG, []);
  void actor.setFlag(MODULE_ID, UNRESOLVED_CHOICES_FLAG, []);
  void actor.setFlag(MODULE_ID, ACKNOWLEDGED_FLAG, false);
  notifyChanged(actor);
}

export function addImportIssue(actor: Actor, message: string): void {
  const issues = getImportIssues(actor);
  issues.add(message);
  void writeIssueSet(actor, "import", issues);
  markUnacknowledged(actor);
  notifyChanged(actor);
}

/**
 * Adds several import issues in a single flag write.
 *
 * Adding them one at a time via {@link addImportIssue} is unsafe in a loop: each
 * call reads the flag synchronously from the in-memory document but writes it
 * back with an un-awaited `setFlag`. Because the in-memory value only updates
 * once that write resolves, every call in a tight loop reads the same stale set,
 * adds only its own message, and the last write wins — so all but the final
 * issue are silently dropped. Batching reads once, adds all, and writes once
 * (awaited), so every issue survives.
 */
export async function addImportIssues(actor: Actor, messages: string[]): Promise<void> {
  if (messages.length === 0) return;
  const issues = getImportIssues(actor);
  for (const message of messages) issues.add(message);
  await writeIssueSet(actor, "import", issues);
  markUnacknowledged(actor);
  notifyChanged(actor);
}

export function addExportIssue(actor: Actor, message: string): void {
  const issues = getExportIssues(actor);
  issues.add(message);
  void writeIssueSet(actor, "export", issues);
  markUnacknowledged(actor);
  notifyChanged(actor);
}

/**
 * Whether the user has already been warned about the current unresolved push
 * conflict. Auto-pushes retry about every two seconds, so the conflict handler
 * checks this before toasting to avoid warning on every retry. The flag is
 * cleared by {@link resetImportIssues} on the next import, which re-baselines
 * the character and re-arms the warning for a future conflict.
 */
export function hasNotifiedConflict(actor: Actor): boolean {
  return actor.getFlag(MODULE_ID, CONFLICT_NOTIFIED_FLAG) === true;
}

/** Records that the user has now been warned about the current push conflict. */
export function markConflictNotified(actor: Actor): void {
  void actor.setFlag(MODULE_ID, CONFLICT_NOTIFIED_FLAG, true);
}

/**
 * Re-arms the conflict warning so the next detected conflict warns again. Used
 * before an explicit manual push so the user always gets direct feedback, even
 * if a background auto-push already warned for the same conflict.
 */
export function clearConflictNotified(actor: Actor): void {
  void actor.setFlag(MODULE_ID, CONFLICT_NOTIFIED_FLAG, false);
}

function isAcknowledged(actor: Actor): boolean {
  return actor.getFlag(MODULE_ID, ACKNOWLEDGED_FLAG) === true;
}

function markUnacknowledged(actor: Actor): void {
  void actor.setFlag(MODULE_ID, ACKNOWLEDGED_FLAG, false);
}

function readIssueSet(actor: Actor, kind: IssueSetKind): Set<string> {
  const raw = actor.getFlag(MODULE_ID, `${kind}Issues`) as string[] | undefined;
  const values = Array.isArray(raw) ? raw : [];
  return new Set(values);
}

function writeIssueSet(actor: Actor, kind: IssueSetKind, issues: Set<string>): Promise<unknown> {
  return actor.setFlag(MODULE_ID, `${kind}Issues`, Array.from(issues));
}

function notifyChanged(actor: Actor): void {
  if (typeof Hooks !== "undefined") {
    Hooks.callAll(ISSUES_CHANGED_EVENT, actor);
  }
}
