import { MODULE_ID } from "./import/types.js";
import type { UnmappedSlug } from "./import/types.js";

export const ISSUES_CHANGED_EVENT = "demiplaneSyncIssuesChanged";

type IssueSetKind = "import" | "export";

const UNMAPPED_FLAG = "unmappedSlugs";
const ACKNOWLEDGED_FLAG = "issuesAcknowledged";

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

/** True when any issue data is currently stored, regardless of acknowledgement. */
export function hasActiveIssues(actor: Actor): boolean {
  return getImportIssues(actor).size > 0 || getExportIssues(actor).size > 0 || getUnmappedSlugs(actor).length > 0;
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
  void actor.setFlag(MODULE_ID, ACKNOWLEDGED_FLAG, false);
  notifyChanged(actor);
}

/** Clears every issue set and the acknowledgement flag. */
export function clearAllIssues(actor: Actor): void {
  void writeIssueSet(actor, "import", new Set());
  void writeIssueSet(actor, "export", new Set());
  void actor.setFlag(MODULE_ID, UNMAPPED_FLAG, []);
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

export function addExportIssue(actor: Actor, message: string): void {
  const issues = getExportIssues(actor);
  issues.add(message);
  void writeIssueSet(actor, "export", issues);
  markUnacknowledged(actor);
  notifyChanged(actor);
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
