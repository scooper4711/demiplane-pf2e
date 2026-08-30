import { describe, it, expect } from "vitest";
import { parseDomainLine, parseEngineLine } from "../../src/import/stream-engines.js";

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
