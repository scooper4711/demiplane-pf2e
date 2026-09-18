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

  it("routes a selected hex into the hexes bucket, not innate", () => {
    // A player picks a hex (e.g. Phase Familiar) through a hex-spells-rm builder
    // row, so its select-spell engine's sourceRow carries that marker. It is a
    // focus spell bound for the Hexes entry, not an innate spell.
    const { hexes, innate } = groupSpells([
      spell("phase-familiar-rm", {
        sourceType: "select-spell",
        sourceRow: "…_hex-spells-rm-…_select-spell-hex-spells-rm-…",
      }),
    ]);

    expect(hexes).toHaveLength(1);
    expect(hexes[0]!.args?.slug).toBeUndefined();
    expect(hexes[0]!.name).toBe("tabula/spell/phase-familiar-rm.eng");
    expect(innate).toHaveLength(0);
  });

  it("keeps a non-hex selected spell (dedication cantrip) in the innate bucket", () => {
    // Runescarred's Root Reading is a select-spell whose sourceRow does not name
    // the hex group, so it stays innate rather than becoming a hex.
    const { hexes, innate } = groupSpells([
      spell("root-reading", {
        sourceType: "select-spell",
        sourceRow: "…_select-spell-runescarred-dedication-…",
      }),
    ]);

    expect(hexes).toHaveLength(0);
    expect(innate).toHaveLength(1);
    expect(innate[0]!.name).toBe("tabula/spell/root-reading.eng");
  });

  it("files a school-selected spell in the class spellbook, not innate", () => {
    // A universalist's Grease is an extra known spell cast with class slots
    // (sourceRow names the school selection row), so it joins the wizard group
    // rather than the innate bucket.
    const { main, innate } = groupSpells([
      spell("frostbite-rm", { parentSpellFeature: "wizard-spellcasting-rm" }),
      spell("grease-rm", {
        sourceType: "select-spell",
        sourceRow: "…_select-spell-school-of-unified-magical-theory-rm-…",
      }),
    ]);

    expect(main).toHaveLength(1);
    expect(main[0]!.spellbook).toHaveLength(2);
    expect(innate).toHaveLength(0);
  });

  it("falls back to innate for school spells without exactly one class group", () => {
    const schoolSpell = () =>
      spell("grease-rm", {
        sourceType: "select-spell",
        sourceRow: "…_select-spell-school-of-unified-magical-theory-rm-…",
      });

    // No class group to attach to.
    expect(groupSpells([schoolSpell()]).innate).toHaveLength(1);

    // Multiclass ambiguity: rather than guess or duplicate, keep prior behavior.
    const { main, innate } = groupSpells([
      spell("frostbite-rm", { parentSpellFeature: "wizard-spellcasting-rm" }),
      spell("soothe-rm", { parentSpellFeature: "bard-spellcasting-rm" }),
      schoolSpell(),
    ]);
    expect(main).toHaveLength(2);
    expect(innate).toHaveLength(1);
  });

  it("files a Spell Runes feat spell as innate, not a spell group", () => {
    // Runescarred's Spell Runes grants its spell once per day as an innate
    // spell — it must not form a (config-less) main group that would trip the
    // unknown-source error.
    const { main, innate } = groupSpells([
      spell("mystic-armor-rm", { parentSpellFeature: "spell-runes-spellcasting", selectionRank: 1 }),
    ]);
    expect(main).toHaveLength(0);
    expect(innate).toHaveLength(1);
  });

  it("derives a summoner's config from its eidolon", () => {
    const eidolon = {
      id: "eid-1",
      name: "tabula/eidolon/beast-rm.eng",
      type: "DemiplaneEngine",
      args: { slug: "beast-rm" },
    } as DemiplaneEngineEntry;
    const { main } = groupSpells([
      eidolon,
      spell("detect-magic-rm", { parentSpellFeature: "summoner-spellcasting-rm" }),
    ]);
    expect(main).toHaveLength(1);
    expect(main[0]!.config).toEqual({ tradition: "primal", preparedType: "spontaneous", ability: "cha" });
  });

  it("leaves a summoner group config-less without a known eidolon", () => {
    // No eidolon, or one outside the table: downstream import surfaces the
    // unknown-source sync error rather than guessing a tradition.
    const noEidolon = groupSpells([spell("detect-magic-rm", { parentSpellFeature: "summoner-spellcasting-rm" })]);
    expect(noEidolon.main).toHaveLength(1);
    expect(noEidolon.main[0]!.config).toBeNull();

    const strange = {
      id: "eid-9",
      name: "tabula/eidolon/something-new.eng",
      type: "DemiplaneEngine",
      args: { slug: "something-new" },
    } as DemiplaneEngineEntry;
    const unknown = groupSpells([
      strange,
      spell("detect-magic-rm", { parentSpellFeature: "summoner-spellcasting-rm" }),
    ]);
    expect(unknown.main).toHaveLength(1);
    expect(unknown.main[0]!.config).toBeNull();
  });
});
