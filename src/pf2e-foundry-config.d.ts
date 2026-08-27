import type {} from "fvtt-types/configuration";

/**
 * fvtt-types configuration for the Pathfinder 2e system and this module.
 *
 * WHY THIS FILE EXISTS
 * fvtt-types ships base Foundry document types only. With no system registered,
 * `Actor#type` resolves to `"base" | ModuleSubType` and `Actor#system` to
 * `EmptyObject | UnknownSystem`. Every PF2e field access, every
 * `type === "character"` comparison, and every module-scoped flag or setting
 * therefore fails to compile.
 *
 * WHY IT MUST STAY A MODULE
 * The `import type {}` above is load-bearing. In a script file (one with no
 * top-level import or export) `declare module "x"` declares a *new ambient
 * module* rather than augmenting the existing one, so the interfaces below would
 * silently fail to merge and nothing would change.
 *
 * Subtype names mirror the PF2e system's own ACTOR_TYPES and ITEM_TYPES
 * (pf2e/src/module/actor/values.ts, pf2e/src/module/item/values.ts).
 */

/** Keep in sync with `MODULE_ID` in ./import/types.ts. */
type ModuleId = "demiplane-pf2e";

type Pf2eActorSubType = "army" | "character" | "familiar" | "hazard" | "loot" | "npc" | "party" | "vehicle";

type Pf2eItemSubType =
  | "action"
  | "affliction"
  | "ammo"
  | "ancestry"
  | "armor"
  | "background"
  | "backpack"
  | "book"
  | "campaignFeature"
  | "class"
  | "condition"
  | "consumable"
  | "deity"
  | "effect"
  | "equipment"
  | "feat"
  | "heritage"
  | "kit"
  | "lore"
  | "melee"
  | "shield"
  | "spell"
  | "spellcastingEntry"
  | "treasure"
  | "weapon";

/** PF2e stores many scalar details under a `value` wrapper. */
interface ValueOf<TValue> {
  value: TValue;
}

interface Pf2eHitPoints {
  value: number;
  max: number;
  temp: number;
}

interface Pf2eCurrency {
  pp: number;
  gp: number;
  sp: number;
  cp: number;
}

/** Mirrors CharacterBiography in pf2e/src/module/actor/character/data.ts. */
interface Pf2eBiography {
  appearance: string;
  backstory: string;
  birthPlace: string;
  attitude: string;
  beliefs: string;
  edicts: string[];
  anathema: string[];
  likes: string;
  dislikes: string;
  catchphrases: string;
  campaignNotes: string;
  allies: string;
  enemies: string;
  organizations: string;
}

interface Pf2eCharacterDetails {
  age: ValueOf<string>;
  biography: Pf2eBiography;
  deity: ValueOf<string>;
  ethnicity: ValueOf<string>;
  gender: ValueOf<string>;
  height: ValueOf<string>;
  languages: ValueOf<string[]>;
  level: ValueOf<number>;
  nationality: ValueOf<string>;
  weight: ValueOf<string>;
}

/** Mirrors PathfinderSocietyData in pf2e/src/module/actor/character/data.ts. */
interface Pf2ePathfinderSocietyData {
  playerNumber: number | null;
  characterNumber: number | null;
}

interface Pf2eCharacterSystemData {
  attributes: { hp: Pf2eHitPoints };
  /** Attribute boosts keyed by the level at which they were taken. */
  build: { attributes: { boosts: Record<string, string[]> } };
  currency: Pf2eCurrency;
  details: Pf2eCharacterDetails;
  pfs: Pf2ePathfinderSocietyData;
  resources: {
    focus: { value: number; max: number };
    heroPoints: { value: number; max: number };
  };
  skills: Record<string, { rank: number }>;
  slug: string | null;
}

/** Fields shared by every PF2e actor subtype this module reads. */
interface Pf2eActorSystemData {
  attributes: { hp: Pf2eHitPoints };
  details: { level: ValueOf<number> };
  slug: string | null;
}

/**
 * Fields shared by every PF2e item subtype. Physical-item and feat-specific
 * fields are optional so a single shape serves all subtypes without forcing
 * callers to narrow first.
 */
interface Pf2eItemSystemData {
  slug: string | null;
  rules: Record<string, unknown>[];
  description?: ValueOf<string>;
  quantity?: number;
  equipped?: { carryType: string; handsHeld?: number; inSlot?: boolean };
  level?: ValueOf<number> & { taken?: number };
  location?: string | null;
  boosts?: Record<string, { value: string[]; selected: string | null }>;
}

interface DemiplaneActorFlags {
  characterId?: string;
  lastImportTimestamp?: number;
  lastExportTimestamp?: number;
  importIssues?: string[];
  exportIssues?: string[];
}

interface DemiplaneItemFlags {
  imported?: boolean;
}

/** PF2e writes ChoiceSet results here; GrantItem rules resolve against them. */
interface Pf2eItemFlags {
  rulesSelections?: Record<string, unknown>;
}

declare module "fvtt-types/configuration" {
  /**
   * Registers the subtype names. Only the keys matter here: fvtt-types collapses
   * non-constructor values to `never` and takes the actual shapes from
   * `DataConfig` below.
   */
  interface DataModelConfig {
    Actor: Record<Pf2eActorSubType, object>;
    Item: Record<Pf2eItemSubType, object>;
  }

  /** Supplies the prepared-data shape behind `Actor#system` / `Item#system`. */
  interface DataConfig {
    Actor: Record<Exclude<Pf2eActorSubType, "character">, Pf2eActorSystemData> & {
      character: Pf2eCharacterSystemData;
    };
    Item: Record<Pf2eItemSubType, Pf2eItemSystemData>;
  }

  /**
   * `base` and the arbitrary module subtypes are ignored because this module only
   * ever runs against the PF2e system, and `discriminate: "all"` types each
   * `system` property as `T | undefined` so the existing optional-chaining reads
   * compile without narrowing the actor subtype first.
   *
   * Both `moduleSubType` and `moduleSubtype` are set: fvtt-types spells the key
   * inconsistently between its own internal checks.
   */
  interface SystemConfig {
    Actor: {
      discriminate: "all";
      base: "ignore";
      moduleSubType: "ignore";
      moduleSubtype: "ignore";
    };
    Item: {
      discriminate: "all";
      base: "ignore";
      moduleSubType: "ignore";
      moduleSubtype: "ignore";
    };
  }

  interface FlagConfig {
    Actor: {
      [K in ModuleId]: DemiplaneActorFlags;
    } & { pf2e?: Record<string, unknown> };
    Item: {
      [K in ModuleId]: DemiplaneItemFlags;
    } & { pf2e?: Pf2eItemFlags };
  }

  interface SettingConfig {
    "demiplane-pf2e.autoSync": boolean;
    "demiplane-pf2e.demiplaneToken": string;
    "demiplane-pf2e.debugImport": boolean;
  }

  /**
   * Every entry point in this module runs at `init` or later, and all UI calls
   * (`ui.notifications`) happen in user-triggered flows well after `ready`.
   * Declaring `ready` drops the `undefined` from `game.*` and from the `ui.*`
   * application collection.
   */
  interface AssumeHookRan {
    ready: never;
  }

  /**
   * Registers the module's custom hook so `Hooks.on`/`Hooks.callAll` accept it.
   * `Hooks.on` is typed against `keyof HookConfig` (which extends `AllHooks`),
   * so merging the key onto `HookConfig` makes the event name type-check.
   */
  namespace Hooks {
    interface HookConfig {
      demiplaneSyncIssuesChanged: (actor: Actor) => void;
    }
  }
}
