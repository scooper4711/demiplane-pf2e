/**
 * PF2e system data shapes this module reads and writes.
 *
 * @dfreds/foundry-types deliberately leaves `Actor#system` / `Item#system`
 * as generic `object`: only the PF2e system itself knows those shapes, and it
 * does not publish them as a package. Rather than scattering
 * `as unknown as { … }` inline (or `as never` on whole document operations),
 * the shapes this module actually touches live here, with `actorSystem` /
 * `itemSystem` as the single narrowing boundary.
 *
 * Field comments cite the PF2e source they mirror
 * (`pf2e/src/module/actor/...`, `pf2e/src/module/item/...`).
 */

/** PF2e stores many scalar details under a `value` wrapper. */
export interface ValueOf<TValue> {
  value: TValue;
}

export interface Pf2eHitPoints {
  value: number;
  max: number;
  temp: number;
}

export interface Pf2eCurrency {
  pp: number;
  gp: number;
  sp: number;
  cp: number;
}

/** Mirrors CharacterBiography in pf2e/src/module/actor/character/data.ts. */
export interface Pf2eBiography {
  appearance: string;
  backstory: string;
  birthPlace: string;
  attitude: string;
  beliefs: string;
  edicts: string[];
  anathema: string[];
  likes: string;
  dislikes: string;
  catchphrases: string;
  campaignNotes: string;
  allies: string;
  enemies: string;
  organizations: string;
}

export interface Pf2eCharacterDetails {
  age: ValueOf<string>;
  biography: Pf2eBiography;
  deity: ValueOf<string>;
  ethnicity: ValueOf<string>;
  gender: ValueOf<string>;
  height: ValueOf<string>;
  languages: ValueOf<string[]>;
  level: ValueOf<number>;
  nationality: ValueOf<string>;
  weight: ValueOf<string>;
}

/** Mirrors PathfinderSocietyData in pf2e/src/module/actor/character/data.ts. */
export interface Pf2ePathfinderSocietyData {
  playerNumber: number | null;
  characterNumber: number | null;
}

/** Subset of CharacterSystemData this module reads (pf2e/src/module/actor/character/data.ts). */
export interface Pf2eCharacterSystem {
  attributes: { hp: Pf2eHitPoints };
  /** Attribute boosts keyed by the level at which they were taken. */
  build: { attributes: { boosts: Record<string, string[]> } };
  currency: Pf2eCurrency;
  details: Pf2eCharacterDetails;
  pfs: Pf2ePathfinderSocietyData;
  resources: {
    focus: { value: number; max: number };
    heroPoints: { value: number; max: number };
  };
  skills: Record<string, { rank: number }>;
  slug: string | null;
}

/** Fields shared by every PF2e actor subtype this module reads. */
export interface Pf2eActorSystem {
  attributes: { hp: Pf2eHitPoints };
  details: { level: ValueOf<number> };
  slug: string | null;
}

/** Physical-item equipped state (pf2e/src/module/item/physical/data.ts). */
export interface Pf2eEquipped {
  carryType: string;
  handsHeld?: number;
  inSlot?: boolean;
  invested?: boolean | null;
}

/**
 * Fields this module reads or writes on PF2e item system data. Everything is
 * optional so one shape serves every subtype without forcing callers to narrow
 * first; per-subtype extras (spell slots, lore proficiency, …) are included
 * where this module touches them.
 */
export interface Pf2eItemSystem {
  slug: string | null;
  rules: Record<string, unknown>[];
  description?: ValueOf<string>;
  quantity?: number;
  equipped?: Pf2eEquipped;
  level?: ValueOf<number> & { taken?: number };
  location?: string | null | { value?: string | null };
  boosts?: Record<string, { value: string[]; selected: string | null }>;
  /** Lore items carry `system.proficient.value`; background items `trainedSkills.lore`. */
  proficient?: ValueOf<number>;
  trainedSkills?: { lore?: string[] };
  /** Spellcasting entries track slots per rank. */
  slots?: Record<string, { prepared: Record<string, unknown>; value: number; max: number }>;
}

/** PF2e writes ChoiceSet results here; GrantItem rules resolve against them. */
export interface Pf2eItemFlags {
  rulesSelections?: Record<string, unknown>;
}

/** Module flags this module stores on actors (see `sync-issues.ts`). */
export interface DemiplaneActorFlags {
  characterId?: string;
  lastImportTimestamp?: number;
  lastExportTimestamp?: number;
  lastUpdated?: string;
  engineSig?: string;
  importIssues?: string[];
  exportIssues?: string[];
  /** Slugs the last import could not resolve, replaced wholesale each import. */
  unmappedSlugs?: Array<{ slug: string; kind: string }>;
  /** Whether the current sync issues have been seen (dialog dismissed). */
  issuesAcknowledged?: boolean;
  /** Tokens for in-flight imports/pushes, replicated across clients. */
  syncActiveTokens?: string[];
}

export interface DemiplaneItemFlags {
  imported?: boolean;
}

/** One world-scoped setting per slug kind (see `slug-mapping.ts`). */
export interface SlugMappings {
  [slug: string]: { uuid: string; name: string };
}

/** Minimal document surface the accessors below need. `system` is optional so plain data records qualify too. */
interface WithSystem {
  readonly system?: unknown;
}

/**
 * Narrows an actor's generic system data to the PF2e shape. The single place
 * where the module asserts knowledge of the system's data model.
 */
export function actorSystem(actor: WithSystem): Pf2eActorSystem {
  return actor.system as Pf2eActorSystem;
}

/** Character-specific system data (details, currency, skills, …). */
export function characterSystem(actor: WithSystem): Pf2eCharacterSystem {
  return actor.system as Pf2eCharacterSystem;
}

/** Narrows an item's generic system data to the PF2e shape. */
export function itemSystem(item: WithSystem): Pf2eItemSystem {
  return item.system as Pf2eItemSystem;
}

/** A document that can serialize itself to plain source data. */
interface ToObjectDocument {
  toObject: () => object;
}

/**
 * Serializes a compendium document to a plain, mutable data record for stamping
 * and item creation. `toObject` returns the system-specific source shape; the
 * import pipeline treats it as an open record it can stamp flags onto, so this
 * is the one place that widening happens.
 */
export function toPlainData(doc: ToObjectDocument): Record<string, unknown> {
  return doc.toObject() as Record<string, unknown>;
}

/**
 * Reads system data off a freshly created embedded document.
 * `createEmbeddedDocuments` is typed to return base `Document`s (which carry
 * no `system`), but items created on an actor always have one. Structural
 * read so it also works with the plain-object stand-ins used in tests.
 */
export function documentSystem(doc: unknown): Pf2eItemSystem | undefined {
  if (typeof doc !== "object" || doc === null || !("system" in doc)) return undefined;
  return doc.system as Pf2eItemSystem;
}

/** Reads this module's item flags without a cast at each call site. */
export function demiplaneItemFlags(item: { readonly flags?: Record<string, unknown> }): DemiplaneItemFlags {
  return (item.flags?.["demiplane-pf2e"] ?? {}) as DemiplaneItemFlags;
}

// ─── Document internals not on the base `Document` type ──────────────────────

/**
 * An item's authored rule elements, read from `_source.system.rules` (the form
 * before active effects) and falling back to prepared `system.rules`. Grant
 * resolution needs the authored form, which the base document type doesn't
 * expose. Structural read so test stand-ins work too.
 */
export function sourceRules(item: {
  system?: { rules?: Array<Record<string, unknown>> };
}): Array<Record<string, unknown>> {
  const source = (item as { _source?: { system?: { rules?: Array<Record<string, unknown>> } } })._source?.system;
  return source?.rules ?? item.system?.rules ?? [];
}

/** The compendium document id an item was granted/created from, if any. */
export function itemSourceId(item: object): string | undefined {
  return (item as { sourceId?: string }).sourceId;
}

/** The `_stats.compendiumSource` UUID PF2e records on granted items, if any. */
export function compendiumSource(item: object): string | undefined {
  return (item as { _stats?: { compendiumSource?: string } })._stats?.compendiumSource;
}

// ─── PF2e runtime globals ────────────────────────────────────────────────────

/**
 * The PF2e language keys registered at runtime. Prefers `game.pf2e.system.config`
 * and falls back to `CONFIG.PF2E`, matching how the system exposes it across
 * versions. Returns an empty object when neither is present. `foundry-globals.d.ts`
 * types `game.pf2e` and `CONFIG.PF2E` loosely, so this is the one place that
 * knows the `languages` shape.
 */
export function pf2eLanguages(): Record<string, string> {
  const fromGame = (
    game.pf2e as { system?: { config?: { PF2E?: { languages?: Record<string, string> } } } } | undefined
  )?.system?.config?.PF2E?.languages;
  return fromGame ?? CONFIG.PF2E?.languages ?? {};
}

/** A builtin PF2e rule-element class (e.g. `ChoiceSet`) by name, or `undefined`. */
export function builtinRuleElement(name: string): { prototype: Record<string, unknown> } | undefined {
  const builtin = game.pf2e?.RuleElements?.builtin?.[name];
  return builtin as { prototype: Record<string, unknown> } | undefined;
}
