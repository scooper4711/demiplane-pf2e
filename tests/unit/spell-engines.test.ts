import { describe, it, expect } from "vitest";
import type { DemiplaneEngineEntry } from "../../src/import/types.js";
import {
  findSpellEngines,
  findSpellbookSpells,
  findPreparedSpells,
  isCurriculumSpell,
} from "../../src/import/spell-engines.js";

function engine(overrides: Partial<DemiplaneEngineEntry>): DemiplaneEngineEntry {
  return {
    id: "e1",
    name: "tabula/spell/some-spell-rm.eng",
    type: "DemiplaneEngine",
    args: {},
    ...overrides,
  } as DemiplaneEngineEntry;
}

describe("spell-engines", () => {
  const spellEngines: DemiplaneEngineEntry[] = [
    engine({
      name: "tabula/spell/fireball-rm.eng",
      args: {
        addSpellData: { baseSpellbookSpell: true },
        isPrepare: true,
        spellSlot: "wizard-school-spellbook-slot-1",
      },
    }),
    engine({ name: "tabula/spell/mage-hand-rm.eng", args: { isPrepare: false } }),
    engine({ name: "tabula/feat/power-attack-rm.eng", type: "DemiplaneEngine", args: {} }),
  ];

  it("findSpellEngines returns only spell engines", () => {
    const found = findSpellEngines(spellEngines);
    expect(found).toHaveLength(2);
    expect(found.every((e) => e.name.startsWith("tabula/spell/"))).toBe(true);
  });

  it("findSpellbookSpells returns only base spellbook spells", () => {
    const found = findSpellbookSpells(spellEngines);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("tabula/spell/fireball-rm.eng");
  });

  it("findPreparedSpells returns only prepared spells", () => {
    const found = findPreparedSpells(spellEngines);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("tabula/spell/fireball-rm.eng");
  });

  it("isCurriculumSpell detects wizard school spellbook slot", () => {
    expect(isCurriculumSpell(spellEngines[0])).toBe(true);
    expect(isCurriculumSpell(spellEngines[1])).toBe(false);
    expect(isCurriculumSpell(engine({ args: { spellSlot: "some-other-slot" } }))).toBe(false);
    expect(isCurriculumSpell(engine({ args: {} }))).toBe(false);
  });
});
