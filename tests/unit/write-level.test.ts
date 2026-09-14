import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getWriteLevel,
  canWrite,
  canWriteBiography,
  canWriteLanguages,
  canWriteOrganizedPlayId,
  canWriteCampaignNotes,
  canWriteHitPoints,
  canWriteHeroPoints,
  canWriteFocusPoints,
  canWriteCurrency,
  canWriteSpellSlots,
  canWriteInventoryQuantity,
  canWriteInventoryEquipped,
  canWriteInventoryContainer,
  canSoftDeleteInventory,
  canDeleteInventory,
  isWritingEnabled,
  canWriteSessionState,
  shouldSkipZeroQuantityItems,
  DEFAULT_WRITE_LEVEL,
  CAPABILITY_MIN_LEVEL,
} from "../../src/write-level.js";

let settingValue: unknown;

vi.stubGlobal("game", {
  settings: {
    get: (_module: string, key: string) => {
      if (key === "syncWriteLevel") return settingValue;
      return undefined;
    },
  },
});

describe("write-level", () => {
  beforeEach(() => {
    settingValue = undefined;
  });

  describe("getWriteLevel", () => {
    it("returns the stored level", () => {
      settingValue = "session";
      expect(getWriteLevel()).toBe("session");
    });

    it("falls back to the safe default for an unset or unknown value", () => {
      settingValue = undefined;
      expect(getWriteLevel()).toBe(DEFAULT_WRITE_LEVEL);
      settingValue = "garbage";
      expect(getWriteLevel()).toBe(DEFAULT_WRITE_LEVEL);
      // Legacy tier names are unknown now and fall back too (no migration).
      settingValue = "text-quantity-delete";
      expect(getWriteLevel()).toBe(DEFAULT_WRITE_LEVEL);
      expect(DEFAULT_WRITE_LEVEL).toBe("read-only");
    });
  });

  describe("capability predicates", () => {
    it.each([
      ["read-only", false, false, false],
      ["story", true, false, false],
      ["session", true, true, false],
      ["full", true, true, true],
    ])("maps story/session/delete capabilities at level %s", (level, story, session, deletes) => {
      settingValue = level;
      // Story capabilities share one level …
      expect(canWriteBiography()).toBe(story);
      expect(canWriteLanguages()).toBe(story);
      expect(canWriteOrganizedPlayId()).toBe(story);
      expect(canWriteCampaignNotes()).toBe(story);
      // … session capabilities share the next …
      expect(canWriteHitPoints()).toBe(session);
      expect(canWriteHeroPoints()).toBe(session);
      expect(canWriteFocusPoints()).toBe(session);
      expect(canWriteCurrency()).toBe(session);
      expect(canWriteSpellSlots()).toBe(session);
      expect(canWriteInventoryQuantity()).toBe(session);
      expect(canWriteInventoryEquipped()).toBe(session);
      expect(canWriteInventoryContainer()).toBe(session);
      expect(canSoftDeleteInventory()).toBe(session);
      // … and hard deletes sit at the top.
      expect(canDeleteInventory()).toBe(deletes);
    });

    it("exposes the generic canWrite(capability) behind every predicate", () => {
      settingValue = "session";
      expect(canWrite("biography")).toBe(canWriteBiography());
      expect(canWrite("hit-points")).toBe(canWriteHitPoints());
      expect(canWrite("inventory-quantity")).toBe(canWriteInventoryQuantity());
      expect(canWrite("inventory-delete")).toBe(canDeleteInventory());
    });

    it("treats an unknown value as the safe default (no writing)", () => {
      settingValue = "garbage";
      expect(canWriteBiography()).toBe(false);
      expect(canWriteHitPoints()).toBe(false);
      expect(canDeleteInventory()).toBe(false);
      expect(isWritingEnabled()).toBe(false);
      expect(canWriteSessionState()).toBe(false);
    });

    it("isWritingEnabled is true at any level above read-only", () => {
      for (const level of ["story", "session", "full"] as const) {
        settingValue = level;
        expect(isWritingEnabled()).toBe(true);
      }
      settingValue = "read-only";
      expect(isWritingEnabled()).toBe(false);
    });

    it("canWriteSessionState is true when any session-state capability is permitted", () => {
      settingValue = "read-only";
      expect(canWriteSessionState()).toBe(false);
      settingValue = "story";
      expect(canWriteSessionState()).toBe(false);
      settingValue = "session";
      expect(canWriteSessionState()).toBe(true);
      settingValue = "full";
      expect(canWriteSessionState()).toBe(true);
    });

    it("keeps every capability mapped so a move is a one-line change", () => {
      expect(Object.keys(CAPABILITY_MIN_LEVEL).sort()).toEqual(
        [
          "biography",
          "languages",
          "organized-play",
          "campaign-notes",
          "hit-points",
          "hero-points",
          "focus-points",
          "currency",
          "spell-slots",
          "inventory-quantity",
          "inventory-equipped",
          "inventory-container",
          "inventory-soft-delete",
          "inventory-delete",
        ].sort()
      );
    });
  });

  describe("shouldSkipZeroQuantityItems", () => {
    it("is true only at exactly the session tier", () => {
      settingValue = "session";
      expect(shouldSkipZeroQuantityItems()).toBe(true);
    });

    it.each(["read-only", "story", "full"])("is false at %s", (level) => {
      settingValue = level;
      expect(shouldSkipZeroQuantityItems()).toBe(false);
    });
  });
});
