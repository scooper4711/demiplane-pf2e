export const MODULE_ID = "demiplane-pf2e";

export const PACKS = [
  "pf2e.classes",
  "pf2e.ancestries",
  "pf2e.heritages",
  "pf2e.backgrounds",
  "pf2e.feats-srd",
  "pf2e.spells-srd",
  "pf2e.equipment-srd",
  "pf2e.classfeatures",
] as const;

export interface ImportOptions {
  dryRun?: boolean;
  token?: string;
}

export interface ImportSummary {
  itemsImported: number;
  itemsSkipped: number;
  errors: string[];
  log: string[];
  preview: boolean;
}

export interface DemiplaneEngineEntry {
  id: string;
  name: string;
  type: "DemiplaneEngine" | "CustomDemiplaneEngine";
  args: Record<string, unknown>;
  value?: string | number | boolean;
  [key: string]: unknown;
}

export type ItemCategory = "ancestry" | "heritage" | "background" | "class" | "feat" | "equipment";

/** Stamp an item data object with the imported flag before creation. */
export function stampImported(itemData: Record<string, unknown>): Record<string, unknown> {
  const flags = (itemData.flags || {}) as Record<string, Record<string, unknown>>;
  flags["demiplane-pf2e"] = { ...flags["demiplane-pf2e"], imported: true };
  itemData.flags = flags;
  return itemData;
}
