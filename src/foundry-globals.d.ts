import type CompendiumCollection from "@client/documents/collections/compendium-collection.mjs";

/**
 * Runtime globals provided by Foundry VTT that @dfreds/foundry-types does not
 * declare (it only declares document classes, `foundry`, `Hooks`, `CONST`, …).
 * The PF2e system declares these itself in its own `src/global.ts`; modules
 * must declare the subset they use.
 *
 * These are intentionally structural and minimal: they cover what this module
 * touches (actors, packs, settings, modules, user, notifications) while taking
 * the real document/collection types where they matter so compendium and
 * embedded-document operations type-check without casts.
 *
 * Note on `settings.get`: @dfreds/foundry-types resolves the two-argument
 * overload to the `Setting` document. This module only ever reads values, so
 * `get` is declared here to return the value (`unknown`) directly.
 */
declare global {
  const game: {
    actors: {
      contents: Actor[];
      get(id: string, options?: { strict?: boolean }): Actor | undefined;
    };
    packs: {
      get(key: string): CompendiumCollection | undefined;
    };
    settings: {
      get(module: string, key: string): unknown;
      set(module: string, key: string, value: unknown): Promise<unknown>;
      register(
        module: string,
        key: string,
        data: {
          name: string;
          hint?: string;
          scope: "world" | "client" | "user";
          config?: boolean;
          type:
            | NumberConstructor
            | StringConstructor
            | BooleanConstructor
            | ObjectConstructor
            | ArrayConstructor
            | ConstructorOf<unknown>;
          default?: unknown;
          onChange?: (value: unknown) => void | Promise<void>;
        }
      ): void;
      registerMenu(
        module: string,
        key: string,
        data: {
          name: string;
          label: string;
          hint: string;
          icon: string;
          type: new (...args: never[]) => unknown;
          restricted: boolean;
        }
      ): void;
    };
    modules: {
      get(id: string): { active?: boolean; api?: unknown } | undefined;
    };
    user: User | undefined;
    users:
      | {
          filter(fn: (user: User) => boolean): User[];
        }
      | undefined;
    /** PF2e system extensions (RuleElements for ChoiceSet detection). */
    pf2e?: {
      RuleElements?: {
        builtin?: Record<string, unknown>;
      };
    };
  };

  const ui: {
    notifications: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    };
    windows: Record<string, unknown>;
    actors?: unknown;
  };

  const CONFIG: {
    PF2E?: {
      languages?: Record<string, string>;
    };
  } & Record<string, unknown>;

  /**
   * Actor sheets in this module are only used for their linked actor and root
   * element. This structural shape covers those uses without pulling in the
   * full ApplicationV1 hierarchy.
   */
  interface ActorSheet {
    actor: Actor;
    element: unknown;
  }

  namespace Application {
    interface HeaderButton {
      label: string;
      class: string;
      icon: string;
      /** Tooltip shown on hover (supported by the header-button template). */
      tooltip?: string;
      onclick: () => void;
    }
  }
}

export {};
