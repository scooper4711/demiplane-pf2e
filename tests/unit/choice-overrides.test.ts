import { describe, it, expect } from "vitest";
import { choiceKeyFor, resolveUserOverride, unresolvedChoiceRecord } from "../../src/import/choice-overrides.js";
import type { ChoiceSetContext } from "../../src/import/choice-set-types.js";

function context(overrides: Partial<ChoiceSetContext> = {}): ChoiceSetContext {
  return {
    choices: [
      { value: "acrobatics", label: "Acrobatics" },
      { value: "crafting", label: "Crafting" },
    ],
    selection: null,
    item: { flags: {}, getRollOptions: () => [], rules: [], name: "Test Feat" },
    actor: { getRollOptions: () => [] },
    resolveInjectedProperties: () => ({ test: () => true }),
    predicate: {},
    prompt: undefined,
    inflateChoices: async () => [],
    flag: "choice",
    rollOption: null,
    ...overrides,
  } as ChoiceSetContext;
}

describe("choiceKeyFor", () => {
  it("combines item slug and rule flag", () => {
    expect(choiceKeyFor("domain-initiate", "Domain Initiate", "choice")).toBe("domain-initiate::choice");
  });

  it("falls back to a slugified item name when the item has no slug", () => {
    expect(choiceKeyFor(null, "Test Feat", "choice")).toBe("test-feat::choice");
    expect(choiceKeyFor(undefined, "Test Feat", "choice")).toBe("test-feat::choice");
    expect(choiceKeyFor("", "Test Feat", "choice")).toBe("test-feat::choice");
  });

  it("defaults empty flags and names instead of producing empty segments", () => {
    expect(choiceKeyFor("feat", "Feat", "")).toBe("feat::choice");
    expect(choiceKeyFor(null, "", "choice")).toBe("item::choice");
  });
});

describe("resolveUserOverride", () => {
  it("returns the stored pick as a live choice", () => {
    const choice = resolveUserOverride(context(), { "test-feat::choice": "crafting" });
    expect(choice).toEqual({ value: "crafting", label: "Crafting" });
  });

  it("returns null with no override", () => {
    expect(resolveUserOverride(context(), {})).toBeNull();
  });

  it("returns null for a stale pick that names no current option", () => {
    expect(resolveUserOverride(context(), { "test-feat::choice": "survival" })).toBeNull();
  });

  it("returns null for a different ChoiceSet key", () => {
    expect(resolveUserOverride(context(), { "other::choice": "crafting" })).toBeNull();
  });
});

describe("unresolvedChoiceRecord", () => {
  it("captures key, source, prompt fallback, options, and guess", () => {
    expect(unresolvedChoiceRecord(context(), { value: "acrobatics", label: "Acrobatics" }, "guess")).toEqual({
      key: "test-feat::choice",
      source: "guess",
      prompt: "Test Feat",
      options: [
        { value: "acrobatics", label: "Acrobatics" },
        { value: "crafting", label: "Crafting" },
      ],
      guessedValue: "acrobatics",
    });
  });

  it("prefers the ChoiceSet prompt text when present", () => {
    const record = unresolvedChoiceRecord(
      context({ prompt: "Choose a skill" }),
      {
        value: "acrobatics",
        label: "Acrobatics",
      },
      "guess"
    );
    expect(record.prompt).toBe("Choose a skill");
  });

  it("marks override-applied records with their source", () => {
    const record = unresolvedChoiceRecord(context(), { value: "acrobatics", label: "Acrobatics" }, "override");
    expect(record.source).toBe("override");
    expect(record.key).toBe("test-feat::choice");
  });
});
