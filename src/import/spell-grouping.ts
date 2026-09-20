import type { DemiplaneEngineEntry } from "./types.js";
import { findSpellEngines, isCurriculumSpell } from "./spell-engines.js";
import { toFoundrySlug } from "./slug-utils.js";
import {
  CLASS_SPELLCASTING,
  SUMMONER_SPELLCASTING,
  RUNES_SPELLCASTING_FEATURE,
  FOCUS_SELECTIONS,
  VINDICATOR_ARCHETYPE,
  baseConfigForFeature,
  eidolonTradition,
  type SpellcastingConfig,
} from "./spellcasting-features.js";

export { CLASS_SPELLCASTING };
export type { SpellcastingConfig };

const FONT_SPELL_SLOT = "divine-font";

export function isDivineFontSpell(eng: DemiplaneEngineEntry): boolean {
  return (eng.args?.spellSlot as string | undefined) === FONT_SPELL_SLOT;
}

/**
/**
 * Resolves a spell group's config. Most features are static table entries;
 * the summoner's tradition comes from its eidolon, and archetype
 * spellcasting (`wizard-spellcasting-archetype-rm`) follows its base class
 * (`wizard-spellcasting-rm`) — an archetype casts exactly like the class.
 * Anything else unknown yields null, routing the group to the unknown-source
 * sync error rather than guessing.
 */
function configForFeature(source: string, engines: DemiplaneEngineEntry[]): SpellcastingConfig | null {
  if (source !== SUMMONER_SPELLCASTING) {
    return baseConfigForFeature(source);
  }
  const eidolonSlug = engines.find(
    (e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/eidolon/") && e.args?.slug
  )?.args?.slug as string | undefined;
  const tradition = eidolonSlug ? eidolonTradition(toFoundrySlug(eidolonSlug)) : null;
  if (!tradition) return null;
  return { tradition, preparedType: "spontaneous", ability: "cha" };
}

export interface SpellGroup {
  source: string;
  config: SpellcastingConfig | null;
  spellbook: DemiplaneEngineEntry[];
  curriculumSpellbook: DemiplaneEngineEntry[];
  prepared: DemiplaneEngineEntry[];
  curriculumPrepared: DemiplaneEngineEntry[];
}

export interface GroupedSpells {
  main: SpellGroup[];
  innate: DemiplaneEngineEntry[];
  /** Player-selected focus spells (witch hexes, devotion spells, qi spells), grouped by entry. */
  focus: FocusSelection[];
  font: DemiplaneEngineEntry[];
  /** Rituals — spells with no spellcasting entry; PF2e gathers them ephemerally. */
  rituals: DemiplaneEngineEntry[];
}

/** One focus entry's player-selected spells, with its entry identity resolved. */
export interface FocusSelection {
  entryName: string;
  tradition: string;
  ability: string;
  engines: DemiplaneEngineEntry[];
}

/**
 * Resolves one focus entry's identity. Fixed table values win; the witch's
 * hexes borrow the class config instead. A vindicator-edge ranger's warden
 * spells are divine rather than the usual primal.
 */
function resolveFocusSelection(
  marker: string,
  group: DemiplaneEngineEntry[],
  engines: DemiplaneEngineEntry[],
  classConfig: SpellcastingConfig | null | undefined
): FocusSelection {
  const config = FOCUS_SELECTIONS[marker];
  let tradition = config?.tradition ?? classConfig?.tradition ?? "occult";
  if (marker === "select-warden-spell" && engines.some((e) => e.name === VINDICATOR_ARCHETYPE)) {
    tradition = "divine";
  }
  return {
    entryName: config?.entryName ?? marker,
    tradition,
    ability: config?.ability ?? classConfig?.ability ?? "int",
    engines: group,
  };
}

/** The `parentSpellFeature` value Demiplane tags a known ritual with. */
const RITUAL_FEATURE = "ritual";

/**
 * Marks a selected spell as a player-picked focus spell. The player picks
 * these through a focus-group builder row (a witch's hexes, a champion's
 * devotion spells, a monk's qi spells), so the chosen spell engine's
 * `sourceRow` carries that group — e.g. `hex-spells-rm`, `devotion-spells-rm`,
 * `qi-spells-rm`. Such a pick is a focus spell bound for its focus entry, not
 * an innate spell.
 */
function focusSelectionMarker(eng: DemiplaneEngineEntry): string | null {
  const sourceRow = eng.args?.sourceRow as string | undefined;
  if (typeof sourceRow !== "string") return null;
  for (const marker of Object.keys(FOCUS_SELECTIONS)) {
    if (sourceRow.includes(marker)) return marker;
  }
  return null;
}

/**
 * Marks a selected spell as a school spell (e.g. a universalist's Grease via
 * `select-spell-school-of-unified-magical-theory-rm`). A school spell is an
 * extra known spell cast with the class's own slots — not an innate spell —
 * so it joins the class spellbook group rather than the innate bucket.
 */
const SCHOOL_SELECTION_MARKER = "select-spell-school-";

function isSchoolSpell(eng: DemiplaneEngineEntry): boolean {
  const sourceRow = eng.args?.sourceRow as string | undefined;
  return typeof sourceRow === "string" && sourceRow.includes(SCHOOL_SELECTION_MARKER);
}

export function groupSpells(engines: DemiplaneEngineEntry[]): GroupedSpells {
  const spellEngines = findSpellEngines(engines);
  const mainGroups = new Map<string, SpellGroup>();
  const innateSpells: DemiplaneEngineEntry[] = [];
  const focusSelections = new Map<string, DemiplaneEngineEntry[]>();
  const schoolSpells: DemiplaneEngineEntry[] = [];
  const fontSpells: DemiplaneEngineEntry[] = [];
  const rituals: DemiplaneEngineEntry[] = [];

  for (const eng of spellEngines) {
    if (isDivineFontSpell(eng)) {
      fontSpells.push(eng);
      continue;
    }

    if (routeSelectSpell(eng, focusSelections, schoolSpells, innateSpells)) continue;

    const parentFeature = eng.args?.parentSpellFeature as string | undefined;

    if (parentFeature === RUNES_SPELLCASTING_FEATURE) {
      innateSpells.push(eng);
      continue;
    }

    // A ritual belongs to no class spellbook — PF2e keeps rituals in an
    // ephemeral entry it builds from the character's ritual-trait spells — so
    // collect them separately rather than forming a (config-less) spell group.
    if (parentFeature === RITUAL_FEATURE) {
      rituals.push(eng);
      continue;
    }

    // "scroll"/"wand" parent features are spells carried by a scroll or wand
    // consumable (attached to the item by the equipment importer), not entries
    // in a class spellbook — skip them so they don't form a phantom spell group.
    if (!parentFeature || parentFeature === "scroll" || parentFeature === "wand") continue;

    addToGroup(getOrCreateGroup(mainGroups, parentFeature, engines), eng);
  }

  // School spells are known spells cast with class slots, so they join the
  // class spellbook — but only when exactly one class group exists. With zero
  // or several (multiclass ambiguity), keep the previous behavior (innate)
  // rather than guessing or duplicating across entries.
  const classGroups = [...mainGroups.values()].filter((group) => baseConfigForFeature(group.source) !== null);
  if (classGroups.length === 1) {
    for (const eng of schoolSpells) addToGroup(classGroups[0]!, eng);
  } else {
    innateSpells.push(...schoolSpells);
  }

  const main = [...mainGroups.values()];
  return {
    main,
    innate: innateSpells,
    focus: [...focusSelections].map(([marker, group]) =>
      resolveFocusSelection(marker, group, engines, main[0]?.config)
    ),
    font: fontSpells,
    rituals,
  };
}

/**
 * Routes one player-selected spell (`sourceType: "select-spell"`): focus
 * selections (hexes, devotion spells, qi spells) join their focus group,
 * school spells join the class spellbook below, and anything else selected
 * (e.g. a dedication cantrip) stays innate. Returns true when handled.
 */
function routeSelectSpell(
  eng: DemiplaneEngineEntry,
  focusSelections: Map<string, DemiplaneEngineEntry[]>,
  schoolSpells: DemiplaneEngineEntry[],
  innateSpells: DemiplaneEngineEntry[]
): boolean {
  if ((eng.args?.sourceType as string | undefined) !== "select-spell") return false;
  const marker = focusSelectionMarker(eng);
  if (marker) {
    const group = focusSelections.get(marker) ?? [];
    group.push(eng);
    focusSelections.set(marker, group);
    return true;
  }
  if (isSchoolSpell(eng)) {
    schoolSpells.push(eng);
    return true;
  }
  innateSpells.push(eng);
  return true;
}

function getOrCreateGroup(
  groups: Map<string, SpellGroup>,
  parentFeature: string,
  engines: DemiplaneEngineEntry[]
): SpellGroup {
  if (!groups.has(parentFeature)) {
    groups.set(parentFeature, {
      source: parentFeature,
      config: configForFeature(parentFeature, engines),
      spellbook: [],
      curriculumSpellbook: [],
      prepared: [],
      curriculumPrepared: [],
    });
  }
  return groups.get(parentFeature)!;
}

function addToGroup(group: SpellGroup, eng: DemiplaneEngineEntry): void {
  const isPrepare = eng.args?.isPrepare === true;
  const isCurriculum = isCurriculumSpell(eng);

  if (isPrepare) {
    (isCurriculum ? group.curriculumPrepared : group.prepared).push(eng);
    return;
  }

  if (isCurriculum) {
    group.curriculumSpellbook.push(eng);
  }
  // All spellbook spells go into main spellbook (curriculum spells appear in both)
  group.spellbook.push(eng);
}
