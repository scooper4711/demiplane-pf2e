import type { DemiplaneEngineEntry } from "./types.js";
import { findSpellEngines, isCurriculumSpell } from "./spell-engines.js";
import { toFoundrySlug } from "./slug-utils.js";

export interface SpellcastingConfig {
  tradition: string;
  preparedType: "spontaneous" | "prepared";
  ability: string;
}

export const CLASS_SPELLCASTING: Record<string, SpellcastingConfig> = {
  "sorcerer-spellcasting-rm": { tradition: "arcane", preparedType: "spontaneous", ability: "cha" },
  "wizard-spellcasting-rm": { tradition: "arcane", preparedType: "prepared", ability: "int" },
  "bard-spellcasting-rm": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
  "cleric-spellcasting-rm": { tradition: "divine", preparedType: "prepared", ability: "wis" },
  "druid-spellcasting-rm": { tradition: "primal", preparedType: "prepared", ability: "wis" },
  "oracle-spellcasting-rm": { tradition: "divine", preparedType: "spontaneous", ability: "cha" },
  "witch-spellcasting-rm": { tradition: "occult", preparedType: "prepared", ability: "int" },
  "psychic-spellcasting-rm": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
  // Demiplane tags psychic spells with the bare feature (no -rm suffix).
  // Cha is the common key ability; an Int psychic would need a selection
  // signal Demiplane doesn't export.
  "psychic-spellcasting": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
  "magus-spellcasting-rm": { tradition: "arcane", preparedType: "prepared", ability: "int" },
};

const FONT_SPELL_SLOT = "divine-font";

export function isDivineFontSpell(eng: DemiplaneEngineEntry): boolean {
  return (eng.args?.spellSlot as string | undefined) === FONT_SPELL_SLOT;
}

/** Demiplane's `parentSpellFeature` for summoner repertoire spells. */
const SUMMONER_SPELLCASTING = "summoner-spellcasting-rm";

/**
 * Spellcasting tradition by eidolon (foundry slug). Per the eidolon rules, the
 * summoner's tradition is the eidolon's own. Only beast is covered by a live
 * fixture — the rest follow the rulebook and want a glance if one shows up in
 * a fixture with a wrong-tradition entry.
 */
const EIDOLON_TRADITIONS: Record<string, string> = {
  angel: "divine",
  beast: "primal",
  construct: "arcane",
  demon: "divine",
  dragon: "arcane",
  fey: "primal",
  ghost: "occult",
  plant: "primal",
  psychopomp: "divine",
  undead: "occult",
};

/**
 * Resolves a spell group's config. Most features are static table entries;
 * the summoner's tradition comes from its eidolon, so it is derived from the
 * character's `tabula/eidolon/*` engine. An unknown or missing eidolon yields
 * null, routing the group to the unknown-source sync error rather than
 * guessing a tradition.
 */
function configForFeature(source: string, engines: DemiplaneEngineEntry[]): SpellcastingConfig | null {
  if (source !== SUMMONER_SPELLCASTING) return CLASS_SPELLCASTING[source] ?? null;
  const eidolonSlug = engines.find(
    (e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/eidolon/") && e.args?.slug
  )?.args?.slug as string | undefined;
  const tradition = eidolonSlug ? EIDOLON_TRADITIONS[toFoundrySlug(eidolonSlug)] : undefined;
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
  /** Witch hexes the player selected (e.g. Phase Familiar) — focus spells. */
  hexes: DemiplaneEngineEntry[];
  font: DemiplaneEngineEntry[];
  /** Rituals — spells with no spellcasting entry; PF2e gathers them ephemerally. */
  rituals: DemiplaneEngineEntry[];
}

/** The `parentSpellFeature` value Demiplane tags a known ritual with. */
const RITUAL_FEATURE = "ritual";

/**
 * The `parentSpellFeature` Demiplane gives the Runescarred dedication's Spell
 * Runes feat. The feat grants its chosen spell (e.g. Mystic Armor) as a
 * once-per-day innate spell — not a class spellbook — so file it with the
 * innate bucket rather than forming a (config-less) spell group that would
 * trip the unknown-source error.
 */
const RUNES_SPELLCASTING_FEATURE = "spell-runes-spellcasting";

/**
 * Marks a selected spell as a witch hex. The player picks hexes (e.g. Phase
 * Familiar, the level-1 hex choice) through a `hex-spells-rm` builder row, so
 * the chosen spell engine's `sourceRow` carries that fragment. Such a pick is a
 * focus spell bound for the "Hexes" entry, not an innate spell.
 */
const HEX_SELECTION_MARKER = "hex-spells-rm";

function isSelectedHexSpell(eng: DemiplaneEngineEntry): boolean {
  const sourceRow = eng.args?.sourceRow as string | undefined;
  return typeof sourceRow === "string" && sourceRow.includes(HEX_SELECTION_MARKER);
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
  const hexSpells: DemiplaneEngineEntry[] = [];
  const schoolSpells: DemiplaneEngineEntry[] = [];
  const fontSpells: DemiplaneEngineEntry[] = [];
  const rituals: DemiplaneEngineEntry[] = [];

  for (const eng of spellEngines) {
    if (isDivineFontSpell(eng)) {
      fontSpells.push(eng);
      continue;
    }

    const sourceType = eng.args?.sourceType as string | undefined;
    if (sourceType === "select-spell") {
      if (isSelectedHexSpell(eng)) {
        hexSpells.push(eng);
        continue;
      }
      // School spells join the class group below; anything else selected
      // (e.g. a dedication cantrip) stays innate.
      if (isSchoolSpell(eng)) {
        schoolSpells.push(eng);
        continue;
      }
      innateSpells.push(eng);
      continue;
    }

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
  const classGroups = [...mainGroups.values()].filter((group) => group.source in CLASS_SPELLCASTING);
  if (classGroups.length === 1) {
    for (const eng of schoolSpells) addToGroup(classGroups[0]!, eng);
  } else {
    innateSpells.push(...schoolSpells);
  }

  return { main: [...mainGroups.values()], innate: innateSpells, hexes: hexSpells, font: fontSpells, rituals };
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
