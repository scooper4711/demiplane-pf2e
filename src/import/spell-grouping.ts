import type { DemiplaneEngineEntry } from "./types.js";
import { findSpellEngines, isCurriculumSpell } from "./spell-engines.js";

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
};

const FONT_SPELL_SLOT = "divine-font";

export function isDivineFontSpell(eng: DemiplaneEngineEntry): boolean {
  return (eng.args?.spellSlot as string | undefined) === FONT_SPELL_SLOT;
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

    addToGroup(getOrCreateGroup(mainGroups, parentFeature), eng);
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

function getOrCreateGroup(groups: Map<string, SpellGroup>, parentFeature: string): SpellGroup {
  if (!groups.has(parentFeature)) {
    groups.set(parentFeature, {
      source: parentFeature,
      config: CLASS_SPELLCASTING[parentFeature] ?? null,
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
