import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getWriteLevel,
  canWriteText,
  canWriteQuantity,
  canWriteDeletes,
  DEFAULT_WRITE_LEVEL,
} from "../../src/write-level.js";

let settingValue: unknown;

vi.stubGlobal("game", {
  settings: { get: (_module: string, key: string) => (key === "syncWriteLevel" ? settingValue : undefined) },
});

describe("write-level", () => {
  beforeEach(() => {
    settingValue = undefined;
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
    it("permits nothing at level none", () => {
      settingValue = "none";
      expect(canWriteText()).toBe(false);
      expect(canWriteQuantity()).toBe(false);
      expect(canWriteDeletes()).toBe(false);
    });

    it("permits only text at level text", () => {
      settingValue = "text";
      expect(canWriteText()).toBe(true);
      expect(canWriteQuantity()).toBe(false);
      expect(canWriteDeletes()).toBe(false);
    });

    it("permits text and quantity at level text-quantity", () => {
      settingValue = "text-quantity";
      expect(canWriteText()).toBe(true);
      expect(canWriteQuantity()).toBe(true);
      expect(canWriteDeletes()).toBe(false);
    });

    it("permits everything at level text-quantity-delete", () => {
      settingValue = "text-quantity-delete";
      expect(canWriteText()).toBe(true);
      expect(canWriteQuantity()).toBe(true);
      expect(canWriteDeletes()).toBe(true);
    });

    it("treats an unknown value as the safe default (no writing)", () => {
      settingValue = "garbage";
      expect(canWriteText()).toBe(false);
    });
  });
});
