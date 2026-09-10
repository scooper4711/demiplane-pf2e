/** A single option offered by a PF2e ChoiceSet rule element. */
export interface Choice {
  value: unknown;
  label: string;
}

/** A weapon a ChoiceSet's owning actor holds, as the ikon resolver reads it. */
export interface OwnedWeapon {
  id: string;
  category?: string;
  getRollOptions: (prefix: string) => string[];
}

/** An item being created in the same batch (a `tempItems` entry). */
export interface TempItem {
  slug: string | null;
  system: { rules: Array<Record<string, unknown>> };
}

/** The `this` context PF2e binds when invoking a ChoiceSet's `preCreate`. */
export interface ChoiceSetContext {
  choices: Choice[];
  selection: unknown;
  item: {
    flags: Record<string, unknown>;
    getRollOptions: (s: string) => string[];
    rules: Array<{ ignored: boolean }>;
    name: string;
    /** The owning item's slug (an ikon's slug identifies its weapon assignment). */
    slug?: string | null;
  };
  actor: {
    getRollOptions: () => string[];
    /** Owned items by type; the ikon resolver reads `weapon`. */
    itemTypes?: { weapon?: OwnedWeapon[] };
  };
  resolveInjectedProperties: (p: unknown) => {
    test: (r: Set<string>) => boolean;
  };
  predicate: unknown;
  prompt?: unknown;
  inflateChoices: (r: Set<string>, t: unknown) => Promise<Choice[]>;
  flag: string;
  /** PF2e leaves this null for ChoiceSets that declare no `rollOption`. */
  rollOption: string | null;
}

/** The parameters PF2e passes to a ChoiceSet's `preCreate`. */
export interface PreCreateParams {
  ruleSource: Record<string, unknown>;
  itemSource: { name: string } & Record<string, unknown>;
  /** Every item being created in this batch, including sibling granted ikons. */
  tempItems: unknown;
}
