import { describe, it, expect } from "vitest";
import { groupSpells } from "../../src/import/spell-grouping.js";
import type { DemiplaneEngineEntry } from "../../src/import/types.js";

function spell(slug: string, args: Record<string, unknown>): DemiplaneEngineEntry {
  return { id: slug, name: `tabula/spell/${slug}.eng`, type: "DemiplaneEngine", args } as DemiplaneEngineEntry;
}

describe("groupSpells", () => {
  it("routes class-spellcasting spells into a main group", () => {
    const { main } = groupSpells([spell("frostbite-rm", { parentSpellFeature: "witch-spellcasting-rm" })]);
    expect(main).toHaveLength(1);
    expect(main[0]!.source).toBe("witch-spellcasting-rm");
    expect(main[0]!.spellbook).toHaveLength(1);
  });

  it("does not route scroll- or wand-carried spells into a spell group", () => {
    // These spells belong to a scroll/wand consumable and are attached to the
    // item by the equipment importer, not to a class spellbook.
    const { main } = groupSpells([
      spell("blessed-boundary-rm", { parentSpellFeature: "scroll" }),
      spell("blink", { parentSpellFeature: "wand" }),
    ]);
    expect(main).toHaveLength(0);
  });

  it("ignores spells with no parent feature", () => {
    const { main } = groupSpells([spell("orphan-rm", {})]);
    expect(main).toHaveLength(0);
  });

  it("routes rituals into the rituals bucket, not a spell group", () => {
    // A ritual belongs to no class spellbook — PF2e keeps it in an ephemeral
    // Rituals entry — so it must not form a (config-less) main spell group.
    const { main, rituals } = groupSpells([spell("halt-death-rm", { parentSpellFeature: "ritual" })]);

    expect(main).toHaveLength(0);
    expect(rituals).toHaveLength(1);
    expect(rituals[0]!.args?.slug).toBeUndefined();
    expect(rituals[0]!.name).toBe("tabula/spell/halt-death-rm.eng");
  });

  it("keeps rituals separate from class spells in the same character", () => {
    const { main, rituals } = groupSpells([
      spell("frostbite-rm", { parentSpellFeature: "witch-spellcasting-rm" }),
      spell("halt-death-rm", { parentSpellFeature: "ritual" }),
    ]);

    expect(main).toHaveLength(1);
    expect(main[0]!.spellbook).toHaveLength(1);
    expect(rituals).toHaveLength(1);
  });
});
