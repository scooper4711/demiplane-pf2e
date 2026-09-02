/** A single option offered by a PF2e ChoiceSet rule element. */
export interface Choice {
  value: unknown;
  label: string;
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
  };
  actor: { getRollOptions: () => string[] };
  resolveInjectedProperties: (p: unknown) => {
    test: (r: Set<string>) => boolean;
  };
  predicate: unknown;
  prompt?: unknown;
  inflateChoices: (r: Set<string>, t: unknown) => Promise<Choice[]>;
  flag: string;
  rollOption: string;
}

/** The parameters PF2e passes to a ChoiceSet's `preCreate`. */
export interface PreCreateParams {
  ruleSource: Record<string, unknown>;
  itemSource: { name: string } & Record<string, unknown>;
  tempItems: unknown;
}
