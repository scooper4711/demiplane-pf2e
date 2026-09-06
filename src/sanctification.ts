import { MODULE_ID } from "./import/types.js";

/**
 * A PF2e sanctification value. `none` is the deliberate opt-out for a deity that
 * only *can* be holy/unholy — a real choice, not "unset".
 */
export type Sanctification = "holy" | "unholy" | "none";

/** The valid sanctification values, in the order PF2e lists its ChoiceSet options. */
export const SANCTIFICATION_VALUES: readonly Sanctification[] = ["holy", "unholy", "none"] as const;

/**
 * Per-character sanctification state, stored on the actor when — and only when —
 * the character's deity presents a *real* sanctification choice (a "can be"
 * deity such as Sarenrae, whose options include the "none" opt-out).
 *
 * A "must be" deity (Iomedae → holy) is deterministic and is resolved silently
 * during import, so it never produces this record: its absence is the signal
 * that the sync dialog should not show a sanctification selector.
 */
export interface SanctificationState {
  /** The sanctification options the deity actually allows (e.g. `["holy", "none"]`). */
  options: Sanctification[];
  /** The current selection: the import default until the player changes it. */
  selected: Sanctification;
  /**
   * Whether the player has explicitly confirmed the selection. The import flags
   * an unconfirmed default as a sync issue once; setting the value in the dialog
   * acknowledges it so it does not re-appear on later imports.
   */
  acknowledged: boolean;
}

const SANCTIFICATION_FLAG = "sanctification";

/** Type guard for a raw string that may be a {@link Sanctification}. */
export function isSanctification(value: unknown): value is Sanctification {
  return typeof value === "string" && (SANCTIFICATION_VALUES as readonly string[]).includes(value);
}

/** Reads the per-character sanctification state, or `undefined` when not applicable. */
export function getSanctification(actor: Actor): SanctificationState | undefined {
  const raw = actor.getFlag(MODULE_ID, SANCTIFICATION_FLAG) as Partial<SanctificationState> | undefined;
  if (!raw || !Array.isArray(raw.options) || !isSanctification(raw.selected)) return undefined;
  const options = raw.options.filter(isSanctification);
  if (options.length === 0) return undefined;
  return { options, selected: raw.selected, acknowledged: raw.acknowledged === true };
}

/**
 * Records the sanctification choice discovered during import. Called only for a
 * "can be" deity (multiple options). Preserves a prior explicit acknowledgement
 * and selection across re-imports so the player's decision is not overwritten.
 */
export async function recordSanctificationChoice(
  actor: Actor,
  options: Sanctification[],
  importDefault: Sanctification
): Promise<void> {
  const existing = getSanctification(actor);
  const selected = existing?.acknowledged ? existing.selected : importDefault;
  const acknowledged = existing?.acknowledged ?? false;
  await actor.setFlag(MODULE_ID, SANCTIFICATION_FLAG, { options, selected, acknowledged });
}

/**
 * Persists the player's explicit sanctification selection from the sync dialog.
 * Marks it acknowledged so the import stops flagging it as an unresolved choice.
 */
export async function setSanctificationSelection(actor: Actor, selected: Sanctification): Promise<void> {
  const existing = getSanctification(actor);
  const options = existing?.options ?? [...SANCTIFICATION_VALUES];
  await actor.setFlag(MODULE_ID, SANCTIFICATION_FLAG, { options, selected, acknowledged: true });
}
