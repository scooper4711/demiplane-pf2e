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

export function groupSpells(engines: DemiplaneEngineEntry[]): GroupedSpells {
  const spellEngines = findSpellEngines(engines);
  const mainGroups = new Map<string, SpellGroup>();
  const innateSpells: DemiplaneEngineEntry[] = [];
  const hexSpells: DemiplaneEngineEntry[] = [];
  const fontSpells: DemiplaneEngineEntry[] = [];
  const rituals: DemiplaneEngineEntry[] = [];

  for (const eng of spellEngines) {
    if (isDivineFontSpell(eng)) {
      fontSpells.push(eng);
      continue;
    }

    const sourceType = eng.args?.sourceType as string | undefined;
    if (sourceType === "select-spell") {
      (isSelectedHexSpell(eng) ? hexSpells : innateSpells).push(eng);
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
