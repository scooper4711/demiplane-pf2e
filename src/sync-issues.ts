import { MODULE_ID } from "./import/types.js";
import type { UnmappedSlug } from "./import/types.js";

export const ISSUES_CHANGED_EVENT = "demiplaneSyncIssuesChanged";

export type IssueSetKind = "import" | "export";

const UNMAPPED_FLAG = "unmappedSlugs";

/**
 * Reads the two sync-issue sets stored on the actor.
 *
 * - `import`: cleared at the start of each import, then repopulated as issues
 *   are encountered (missing slugs, import errors).
 * - `export`: accumulates over time as push problems arise (auth failures,
 *   quantity limits, failed pushes) and is only cleared when the user dismisses
 *   the sync dialog.
 *
 * The titlebar indicator is shown whenever either set is non-empty.
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
  notifyChanged(actor);
}

export function hasActiveIssues(actor: Actor): boolean {
  return getImportIssues(actor).size > 0 || getExportIssues(actor).size > 0 || getUnmappedSlugs(actor).length > 0;
}

/** Clears the import set and starts a fresh import. */
export function resetImportIssues(actor: Actor): void {
  void writeIssueSet(actor, "import", new Set());
  void actor.setFlag(MODULE_ID, UNMAPPED_FLAG, []);
  notifyChanged(actor);
}

export function clearExportIssues(actor: Actor): void {
  void writeIssueSet(actor, "export", new Set());
  notifyChanged(actor);
}

/** Clears both sets, used when the user dismisses the sync dialog. */
export function clearAllIssues(actor: Actor): void {
  void writeIssueSet(actor, "import", new Set());
  void writeIssueSet(actor, "export", new Set());
  void actor.setFlag(MODULE_ID, UNMAPPED_FLAG, []);
  notifyChanged(actor);
}

export function addImportIssue(actor: Actor, message: string): void {
  const issues = getImportIssues(actor);
  issues.add(message);
  void writeIssueSet(actor, "import", issues);
  notifyChanged(actor);
}

export function addExportIssue(actor: Actor, message: string): void {
  const issues = getExportIssues(actor);
  issues.add(message);
  void writeIssueSet(actor, "export", issues);
  notifyChanged(actor);
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
