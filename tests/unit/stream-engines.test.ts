import { describe, it, expect, afterEach, vi } from "vitest";
import { parseDomainLine, parseEngineLine, resolveFeatEngineIdsBySlug } from "../../src/import/stream-engines.js";

/** Builds an NDJSON engine line with a top-level engineName and modifier payload. */
function engineLine(id: string, engineName: string, modifiers: unknown[]): string {
  return JSON.stringify({
    id,
    engineName,
    data: {
      nodes: {
        "1": { name: "StringObject", data: { string: JSON.stringify({ engineModifiers: modifiers }) } },
      },
    },
  });
}

function domainLine(data: Record<string, unknown>): string {
  return JSON.stringify({
    id: "dom-1",
    data: {
      nodes: {
        "1": { name: "StringObject", data: { string: JSON.stringify(data) } },
      },
    },
  });
}

describe("parseDomainLine", () => {
  it("extracts domain and advanced spell slugs from a domain engine", () => {
    expect(
      parseDomainLine(domainLine({ name: "Fire", domainSpell: "fire-ray-rm", advancedSpell: "flame-barrier-rm" }))
    ).toEqual({ name: "Fire", domainSpell: "fire-ray-rm", advancedSpell: "flame-barrier-rm" });
  });

  it("returns only the fields present", () => {
    expect(parseDomainLine(domainLine({ name: "Fire", domainSpell: "fire-ray-rm" }))).toEqual({
      name: "Fire",
      domainSpell: "fire-ray-rm",
    });
  });

  it("returns an empty record for non-domain lines", () => {
    expect(parseDomainLine(domainLine({ name: "Cleric", engineModifiers: [] }))).toEqual({});
  });

  it("does not confuse a spell module line for a domain", () => {
    const spellLine = JSON.stringify({
      id: "spell-1",
      data: {
        nodes: {
          "1": {
            name: "StringObject",
            data: { string: JSON.stringify({ name: "Fire Ray", isFocus: true, level: 1 }) },
          },
        },
      },
    });
    expect(parseDomainLine(spellLine)).toEqual({});
    // sanity: a real spell line still parses as an engine line without modifiers
    expect(parseEngineLine(spellLine).modifiers).toEqual([]);
  });
});

describe("parseEngineLine", () => {
  it("parses an add-feat modifier granted by a heritage", () => {
    const line = engineLine("her-1", "tabula/heritage/empty-sky-kitsune.eng", [
      { type: "add-feat", addFeat: "kitsune-spell-familiarity" },
    ]);
    const parsed = parseEngineLine(line);
    expect(parsed.id).toBe("her-1");
    expect(parsed.name).toBe("tabula/heritage/empty-sky-kitsune.eng");
    expect(parsed.modifiers).toEqual([{ type: "add-feat", addFeat: "kitsune-spell-familiarity" }]);
  });

  it("captures the engine name even when the line carries no modifiers", () => {
    const line = engineLine("spell-1", "tabula/spell/daze-rm.eng", []);
    const parsed = parseEngineLine(line);
    expect(parsed.name).toBe("tabula/spell/daze-rm.eng");
    expect(parsed.modifiers).toEqual([]);
  });
});

describe("parseEngineLine modifier types", () => {
  it("parses staff, special-item, and spell-slot modifiers, ignoring unknown types", () => {
    const line = engineLine("mixed-1", "tabula/item/staff-rm.eng", [
      { type: "add-staff-spells", spells: [{ rank: 1, spell: "shield-rm" }] },
      { type: "add-special-item-spell", rank: 1, itemType: "wand" },
      { type: "v2-add-spell-slots", slug: "wizard", slots: [{ rank: 1, count: 2, levelPrereq: 1, slug: "w1" }] },
      { type: "some-unhandled-modifier", foo: "bar" },
    ]);
    const parsed = parseEngineLine(line);
    expect(parsed.modifiers.map((m) => m.type)).toEqual([
      "add-staff-spells",
      "add-special-item-spell",
      "v2-add-spell-slots",
    ]);
  });
});

describe("resolveFeatEngineIdsBySlug", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps feat slugs to engine ids and ignores non-feat engines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          [
            engineLine("c50dedbd", "tabula/feat/kitsune-spell-familiarity.eng", [
              { type: "add-spell", level: 1, addSpell: "daze", tradition: "divine", isInnate: true },
            ]),
            engineLine("her-1", "tabula/heritage/empty-sky-kitsune.eng", [
              { type: "add-feat", addFeat: "kitsune-spell-familiarity" },
            ]),
            engineLine("spell-1", "tabula/spell/daze-rm.eng", []),
          ].join("\n"),
      })
    );

    const map = await resolveFeatEngineIdsBySlug(["c50dedbd", "her-1", "spell-1"]);

    expect(map.get("kitsune-spell-familiarity")).toBe("c50dedbd");
    expect(map.has("empty-sky-kitsune")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns an empty map when given no ids", async () => {
    const map = await resolveFeatEngineIdsBySlug([]);
    expect(map.size).toBe(0);
  });
});
