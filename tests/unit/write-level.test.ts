import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getWriteLevel,
  canWriteText,
  canWriteQuantity,
  canWriteDeletes,
  isSoftDeleteEnabled,
  DEFAULT_WRITE_LEVEL,
} from "../../src/write-level.js";

let settingValue: unknown;
let softDeleteValue: unknown;

vi.stubGlobal("game", {
  settings: {
    get: (_module: string, key: string) => {
      if (key === "syncWriteLevel") return settingValue;
      if (key === "syncSoftDelete") return softDeleteValue;
      return undefined;
    },
  },
});

describe("write-level", () => {
  beforeEach(() => {
    settingValue = undefined;
    softDeleteValue = undefined;
  });

  describe("getWriteLevel", () => {
    it("returns the stored level", () => {
      settingValue = "text-quantity";
      expect(getWriteLevel()).toBe("text-quantity");
    });

    it("falls back to the safe default for an unset or unknown value", () => {
      settingValue = undefined;
      expect(getWriteLevel()).toBe(DEFAULT_WRITE_LEVEL);
      settingValue = "garbage";
      expect(getWriteLevel()).toBe(DEFAULT_WRITE_LEVEL);
      expect(DEFAULT_WRITE_LEVEL).toBe("none");
    });
  });

  describe("cumulative predicates", () => {
    it.each([
      ["none", false, false, false],
      ["text", true, false, false],
      ["text-quantity", true, true, false],
      ["text-quantity-delete", true, true, true],
    ])("permits the right tiers at level %s", (level, text, quantity, deletes) => {
      settingValue = level;
      expect(canWriteText()).toBe(text);
      expect(canWriteQuantity()).toBe(quantity);
      expect(canWriteDeletes()).toBe(deletes);
    });

    it("treats an unknown value as the safe default (no writing)", () => {
      settingValue = "garbage";
      expect(canWriteText()).toBe(false);
    });
  });

  describe("isSoftDeleteEnabled", () => {
    it("is on only when the flag is set AND deletions are permitted", () => {
      settingValue = "text-quantity-delete";
      softDeleteValue = true;
      expect(isSoftDeleteEnabled()).toBe(true);
    });

    it("is off when the flag is set but the write level is below deletions", () => {
      settingValue = "text-quantity";
      softDeleteValue = true;
      expect(isSoftDeleteEnabled()).toBe(false);
    });

    it("is off when deletions are permitted but the flag is not set", () => {
      settingValue = "text-quantity-delete";
      softDeleteValue = undefined;
      expect(isSoftDeleteEnabled()).toBe(false);
    });
  });
});
