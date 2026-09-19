import { describe, it, expect } from "vitest";
import { parseLanguageRenames } from "../../src/import/remaster-renames.js";

const PAGE_EXCERPT = `
Removal of Spell Schools
Seven of the eight spell schools have been removed.
Domains
Some domains have been renamed.
Delirium is now Disorientation.
Void is now Nothingness.
Languages
Several languages have been renamed.
Abyssal is now Chthonian.
Aquan is now Thalassic.
Undercommon is now Sakvroth.
`;

describe("parseLanguageRenames", () => {
  it("maps pre-remaster language names to current slugs", () => {
    const renames = parseLanguageRenames(PAGE_EXCERPT);
    expect(renames.get("undercommon")).toBe("sakvroth");
    expect(renames.get("abyssal")).toBe("chthonian");
    expect(renames.get("aquan")).toBe("thalassic");
  });

  it("ignores domain renames in the same page", () => {
    const renames = parseLanguageRenames(PAGE_EXCERPT);
    expect(renames.has("delirium")).toBe(false);
    expect(renames.has("void")).toBe(false);
  });

  it("returns empty without a Languages section", () => {
    expect(parseLanguageRenames("Nothing to see here.")).toEqual(new Map());
  });
});
