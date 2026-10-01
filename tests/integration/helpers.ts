import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  disableSceneCanvas,
  ensureModuleActive as activateModule,
  joinAsGamemaster,
  startCoverage,
  testBaseUrl,
} from "@scooper4711/foundry-test-kit";

// Generic Foundry session, overlay, and coverage helpers come from the kit.
export { stopCoverage } from "@scooper4711/foundry-test-kit";

const MODULE_ID = "demiplane-pf2e";

/**
 * Skips the slow mutation/write round-trip specs when SKIP_MUTATION_TESTS=1,
 * so frequent read-only runs stay fast. These specs (the Kyra mutation files
 * and the reimport spec) each perform multiple full import/push/re-import
 * cycles against the live character; run them unflagged after touching write
 * logic, or select the files explicitly. Call at a spec file's top level.
 */
export function skipMutationTestsIfFlagged(): void {
  test.skip(process.env.SKIP_MUTATION_TESTS === "1", "mutation tests skipped via SKIP_MUTATION_TESTS=1");
}

/**
 * Toggles the PF2e "Free Archetype" variant rule (Settings → Pathfinder
 * Second Edition → Toggle Variant Rules) via the world setting API — the same
 * backing setting the menu flips, without driving the settings UI.
 */
export async function setFreeArchetype(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    // @ts-expect-error Foundry global
    return game.settings.set("pf2e", "freeArchetypeVariant", value);
  }, enabled);
}

/**
 * Toggles the PF2e "Gradual Attribute Boosts" variant rule via the world
 * setting API, mirroring {@link setFreeArchetype}.
 */
export async function setGradualBoosts(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    // @ts-expect-error Foundry global
    return game.settings.set("pf2e", "gradualBoostsVariant", value);
  }, enabled);
}

/**
 * Sets the PF2e "Mythic Rules" variant (`"disabled"`, `"enabled"`, or
 * `"variant-tiers"`) via the world setting API, mirroring
 * {@link setFreeArchetype}.
 */
export async function setMythicRules(page: Page, value: string): Promise<void> {
  await page.evaluate((mode: string) => {
    // @ts-expect-error Foundry global
    return game.settings.set("pf2e", "mythic", mode);
  }, value);
}

/**
 * Logs in as Gamemaster with Foundry's scene canvas disabled. Headless
 * Chromium renders the WebGL scene in software, which keeps the main thread
 * so busy that every action is slow; importing never touches the canvas.
 */
export async function loginAsGamemaster(page: Page): Promise<void> {
  await disableSceneCanvas(page);
  await loginToWorld(page);
}

/**
 * Logs in as Gamemaster with the scene canvas running, for specs that drive
 * PF2e's own UI: parts of it (e.g. actor sheet and directory handlers) read
 * `canvas.tokens` and throw without a canvas.
 */
export async function loginAsGamemasterWithCanvas(page: Page): Promise<void> {
  await loginToWorld(page);
}

/**
 * Joins the seeded world as its Gamemaster (the kit's seeder already enabled
 * the module) and confirms the module is active, enabling it if a world was
 * seeded without it.
 */
async function loginToWorld(page: Page): Promise<void> {
  await startCoverage(page);
  await page.goto(`${testBaseUrl()}/join`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await joinAsGamemaster(page);
  await ensureModuleActive(page);
}

/**
 * Activates our module if the world doesn't have it enabled. Enabling
 * requires a client reload, which the kit handles. Idempotent.
 */
export async function ensureModuleActive(page: Page): Promise<void> {
  if ((await activateModule(page, MODULE_ID)) === "not_found") {
    throw new Error(`Module ${MODULE_ID} not found. Is it linked into Data/modules? (foundry-test does this.)`);
  }
}

/**
 * Retries a Demiplane API call on HTTP 429 (rate limiting) with backoff. The
 * full suite makes many API calls in a few minutes and the server throttles;
 * without this a throttled read/write fails the run instead of waiting out
 * the window. Only 429s retry — auth errors, validation failures, and
 * updateCharacter's success:false (non-rate) results propagate immediately.
 */
export async function withApiRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [10_000, 20_000, 40_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited =
        status === 429 || (status === undefined && /rate.?limit|too many requests|\b429\b/i.test(message));
      if (!rateLimited || attempt >= delays.length) throw error;
      console.log(`[api-retry] ${label}: rate limited; waiting ${delays[attempt]! / 1000}s`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

/**
 * Sets the module write level for mutation tests, returning the previous
 * value for restoration. Enabling any writing tier on a dev build pops the
 * pre-release warning — expected here, so it is accepted. Every mutation spec
 * must restore what it found: the seeded world default is deliberately the
 * safest tier (`read-only`).
 */
export async function setWriteLevel(page: Page, level: string): Promise<{ level: string | undefined }> {
  const result = await page.evaluate(
    async ({ moduleId, level }) => {
      // @ts-expect-error Foundry global
      const prevLevel = game.settings.get(moduleId, "syncWriteLevel") as string | undefined;
      // @ts-expect-error Foundry global
      await game.settings.set(moduleId, "syncWriteLevel", level);
      return { level: prevLevel };
    },
    { moduleId: MODULE_ID, level }
  );
  await page
    .waitForFunction(
      ({ moduleId, level }) => {
        // @ts-expect-error Foundry global
        return (
          (
            globalThis as unknown as { game: { settings: { get: (m: string, k: string) => unknown } } }
          ).game.settings.get(moduleId, "syncWriteLevel") === level
        );
      },
      { moduleId: MODULE_ID, level },
      { timeout: 2000 }
    )
    .catch(() => {});
  await page
    .evaluate(async () => {
      // @ts-expect-error Foundry global
      for (const app of Object.values(ui.windows ?? {})) {
        const title = (app as { options?: { window?: { title?: string } } })?.options?.window?.title ?? "";
        if (title.includes("Pre-Release")) await (app as { close: () => Promise<void> }).close();
      }
    })
    .catch(() => {});
  return result;
}

/**
 * Waits until an import's grace window has released the actor: imports hold
 * the export suspension and sync pause for a few seconds AFTER returning (to
 * swallow late item hooks), and any test mutation inside that window has its
 * hook queues silently dropped. Deletes are unrecoverable (no full-state
 * re-queue rescues them), so every spec must wait here after importing and
 * before mutating. Polls the replicated pause flag rather than sleeping a
 * fixed duration.
 */
export async function waitForSyncRelease(page: Page, characterId: string): Promise<void> {
  await page.waitForFunction(
    ({ characterId, moduleId }) => {
      // @ts-expect-error Foundry global
      const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
      if (!actor) return false;
      // @ts-expect-error Foundry global
      const tokens = actor.getFlag(moduleId, "syncActiveTokens");
      return !Array.isArray(tokens) || tokens.length === 0;
    },
    { characterId, moduleId: MODULE_ID },
    { timeout: 30_000 }
  );
}

/**
 * Restores a write level previously saved by setWriteLevel. Best-effort by
 * design: cleanup must never throw.
 */ export async function restoreWriteLevel(page: Page, saved: { level: string | undefined }): Promise<void> {
  await page
    .evaluate(
      async ({ moduleId, saved }) => {
        // @ts-expect-error Foundry global
        await game.settings.set(moduleId, "syncWriteLevel", saved.level ?? "read-only");
      },
      { moduleId: MODULE_ID, saved }
    )
    .catch(() => {});
}

/**
 * Stores each unresolved record's guessed option as the actor's pick, so
 * later re-imports apply silently instead of re-flagging. Fidelity specs use
 * this to keep the re-import clean: the pick content is irrelevant here, only
 * its stabilizing effect matters (correctness of picks is covered by the
 * choice-override unit tests and the reimport spec, which picks non-first
 * options deliberately).
 */
export async function storeGuessedPicks(
  page: Page,
  characterId: string,
  records: Array<{ key: string; options: Array<{ value: string }> }>
): Promise<void> {
  await page.evaluate(
    async ({ characterId, moduleId, records }) => {
      // @ts-expect-error Foundry global
      const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
      // @ts-expect-error Foundry global
      const current = (actor.getFlag(moduleId, "choiceOverrides") ?? {}) as Record<string, string>;
      const picks: Record<string, string> = { ...current };
      for (const record of records) {
        if (record.options.length > 0) picks[record.key] = String(record.options[0].value);
      }
      // @ts-expect-error Foundry global
      await actor.setFlag(moduleId, "choiceOverrides", picks);
    },
    { characterId, moduleId: MODULE_ID, records }
  );
}

/** Waits until our module API is callable — it lands after game.ready. */ export async function waitForModuleApi(
  page: Page
): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (
        globalThis as unknown as {
          game: { modules: { get: (id: string) => { api?: { importCharacter?: unknown } } | undefined } };
        }
      ).game?.modules?.get("demiplane-pf2e")?.api?.importCharacter === "function",
    { timeout: 90_000 }
  );
}

export async function deleteActorByName(page: Page, name: string): Promise<void> {
  await page.evaluate(async (actorName: string) => {
    // @ts-expect-error Foundry global
    const actor = game.actors.getName(actorName);
    if (actor) await actor.delete();
  }, name);
}

/**
 * Deletes every actor for a test character: the named test actor (if it still
 * has that name) AND any actor holding its characterId link. Name-only
 * cleanup leaks, because a successful import renames the actor — and a stale
 * link-holder makes the duplicate guard unlink every new import, poisoning
 * subsequent runs. Call in beforeAll AND afterAll.
 */
export async function deleteActorsForCharacter(page: Page, characterId: string, actorName: string): Promise<void> {
  await deleteActorByName(page, actorName);
  await page.evaluate(
    async ({ characterId, moduleId }) => {
      // @ts-expect-error Foundry global
      const holders = game.actors.contents.filter(
        // @ts-expect-error Foundry global
        (actor) => actor.getFlag(moduleId, "characterId") === characterId
      );
      for (const actor of holders) await actor.delete();
    },
    { characterId, moduleId: MODULE_ID }
  );
}

/**
 * Deletes EVERY actor in the test world. Call at the start of each spec's
 * setup: the world is disposable (reseedable via `foundry.sh test run
 * --clean`), and any leftover — a renamed import, a stale link-holder the
 * targeted cleanup missed — poisons subsequent runs through the
 * duplicate-link guard. Targeted per-character cleanup stays in afterAll.
 */
export async function deleteAllActors(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // @ts-expect-error Foundry global
    const ids = game.actors.contents.map((actor) => actor.id);
    for (const id of ids) {
      // @ts-expect-error Foundry global
      await game.actors.get(id)?.delete();
    }
  });
}

interface SnapshotEntry {
  name: string;
  prepared: string;
  tradition: string;
  spells: string[];
  slots: Record<string, { max: number; value: number; prepared: Array<{ spell: string; expended: boolean }> }>;
}

export interface ImportResult {
  summary: {
    itemsImported: number;
    itemsSkipped: number;
    errors: string[];
    log: string[];
    unmapped: Array<{ slug: string; kind: string }>;
    unresolvedChoices: Array<{ key: string; options: Array<{ value: string; label: string }> }>;
  };
  name: string;
  level: number;
  ancestry: string | null;
  heritage: string | null;
  background: string | null;
  class: string | null;
  feats: Array<{
    name: string;
    category: string;
    location: string | null;
    taken: number | null;
  }>;
  abilities: Record<string, number>;
  languages: string[];
  skills: Record<string, number>;
  totalItems: number;
  pfs: { playerNumber: number | null; characterNumber: number | null };
  equipment: Array<{
    name: string;
    type: string;
    quantity: number;
    carryType: string;
    handsHeld: number;
    containerId: string | null;
    invested: boolean | null;
    size: string;
    runes: { potency: number; striking: number; property: string[] };
  }>;
  currency: { pp: number; gp: number; sp: number; cp: number };
  hp: { value: number; max: number; temp: number };
  heroPoints: number;
  focus: { value: number; max: number };
  /**
   * Spellcasting entries and the slugs of the spells filed under each, keyed by
   * entry name. Lets spell-focused specs (e.g. the witch's hexes) assert both
   * the entry (name / prepared type / tradition / ability / proficiency) and
   * its contents. `slots` covers slot maximums, current values, and prepared
   * placements (spell slug plus expended state) per `slotN` key, so specs can
   * assert slot counts and which spell sits in which slot.
   *
   * Ability is "" when the importer leaves it unset (feature-granted focus
   * entries); proficiency is the raw rank (1 = trained — the importer never
   * writes higher, progression rides the class item).
   */
  spellcasting: Array<{
    name: string;
    prepared: string;
    tradition: string;
    ability: string;
    proficiency: number;
    flexible: boolean;
    /** "spell-attack" normally; "class-dc" when the entry's proficiency slug points at class DC. */
    dcMechanic: "spell-attack" | "class-dc";
    spells: string[];
    slots: Record<string, { max: number; value: number; prepared: Array<{ spell: string; expended: boolean }> }>;
  }>;
  /**
   * Spell items filed under no spellcasting entry (e.g. rituals, which PF2e
   * gathers ephemerally from ritual-trait spells). Lets specs assert a known
   * ritual imported as a standalone item rather than vanishing.
   */
  standaloneSpells: string[];
  /**
   * Slugs of spells flagged as signature spells (`system.location.signature`),
   * e.g. a sorcerer's signature repertoire spells. Lets specs assert the
   * signature marking survived the import.
   */
  signatureSpells: string[];
  /**
   * Names of known crafting formulas (`system.crafting.formulas`), resolved
   * from their item UUIDs. Lets specs assert a formula book (e.g. an
   * alchemist's) arrived as formulas rather than inventory items.
   */
  formulas: string[];
}

export async function createAndImportCharacter(
  page: Page,
  actorName: string,
  characterId: string,
  token: string
): Promise<ImportResult> {
  // Our module initializes after game.ready; importing earlier throws.
  await waitForModuleApi(page);
  return await page.evaluate(
    async ({ actorName, characterId, token, moduleId }) => {
      // @ts-expect-error Foundry global
      const actor = await Actor.create({ name: actorName, type: "character" });
      // @ts-expect-error Foundry global
      await actor.setFlag(moduleId, "characterId", characterId);

      // @ts-expect-error Foundry global
      const mod = game.modules.get(moduleId);
      const summary = await mod.api.importCharacter(actor, { token });

      return {
        summary,
        name: actor.name,
        level: actor.system.details.level.value,
        ancestry: actor.items.find((i: { type: string }) => i.type === "ancestry")?.name ?? null,
        heritage: actor.items.find((i: { type: string }) => i.type === "heritage")?.name ?? null,
        background: actor.items.find((i: { type: string }) => i.type === "background")?.name ?? null,
        class: actor.items.find((i: { type: string }) => i.type === "class")?.name ?? null,
        feats: actor.items
          .filter((i: { type: string }) => i.type === "feat")
          .map(
            (f: {
              name: string;
              system: {
                category: string;
                location: string | null;
                level: { taken: number | null };
              };
            }) => ({
              name: f.name,
              category: f.system.category,
              location: f.system.location,
              taken: f.system.level?.taken ?? null,
            })
          ),
        languages: actor.system.details.languages.value as string[],
        gender: (actor.system.details.gender?.value as string) || "",
        ethnicity: (actor.system.details.ethnicity?.value as string) || "",
        nationality: (actor.system.details.nationality?.value as string) || "",
        deity:
          actor.items.find((i: { type: string }) => i.type === "deity")?.name ||
          (actor.system.details.deity?.value as string) ||
          "",
        loreSkills: actor.items.filter((i: { type: string }) => i.type === "lore").map((i: { name: string }) => i.name),
        skills: Object.fromEntries(
          Object.entries(actor.system.skills)
            .filter(([_, d]) => (d as { rank: number }).rank > 0)
            .map(([k, d]) => [k, (d as { rank: number }).rank])
        ),
        abilities: Object.fromEntries(
          Object.entries(actor.system.abilities).map(([k, d]) => [k, (d as { mod: number }).mod])
        ),
        totalItems: actor.items.size,
        pfs: {
          playerNumber: actor.system.pfs?.playerNumber ?? null,
          characterNumber: actor.system.pfs?.characterNumber ?? null,
        },
        hp: {
          value: actor.system.attributes.hp.value,
          max: actor.system.attributes.hp.max,
          temp: actor.system.attributes.hp.temp,
        },
        heroPoints: actor.system.resources?.heroPoints?.value ?? 0,
        focus: {
          value: actor.system.resources?.focus?.value ?? 0,
          max: actor.system.resources?.focus?.max ?? 0,
        },
        spellcasting: actor.items
          .filter((i: { type: string }) => i.type === "spellcastingEntry")
          .map(
            (entry: {
              id: string;
              name: string;
              system: {
                prepared?: { value?: string; flexible?: boolean };
                tradition?: { value?: string };
                ability?: { value?: string };
                proficiency?: { value?: number; slug?: string };
                slots?: Record<
                  string,
                  { max?: number; value?: number; prepared?: Array<{ id?: string; expended?: boolean }> }
                >;
              };
            }) => ({
              name: entry.name,
              prepared: entry.system.prepared?.value ?? "",
              tradition: entry.system.tradition?.value ?? "",
              ability: entry.system.ability?.value ?? "",
              proficiency: entry.system.proficiency?.value ?? 0,
              flexible: entry.system.prepared?.flexible ?? false,
              // Entries whose proficiency slug points at class DC roll those;
              // everything else rolls spell attacks and spell DCs. Runs inline
              // because page.evaluate cannot see module scope.
              dcMechanic: /class-?dc/i.test(entry.system.proficiency?.slug ?? "")
                ? ("class-dc" as const)
                : ("spell-attack" as const),
              spells: actor.items
                .filter(
                  (i: { type: string; system: { location?: { value?: string } } }) =>
                    i.type === "spell" && i.system.location?.value === entry.id
                )
                .map((i: { system: { slug?: string } }) => i.system.slug ?? "")
                .sort(),
              slots: Object.fromEntries(
                Object.entries(entry.system.slots ?? {})
                  .filter(([key]) => /^slot\d+$/.test(key))
                  .map(([key, slot]) => [
                    key,
                    {
                      max: slot.max ?? 0,
                      value: slot.value ?? 0,
                      prepared: (slot.prepared ?? []).map((p) => ({
                        spell:
                          actor.items.find((s: { id: string; system: { slug?: string } }) => s.id === p.id)?.system
                            ?.slug ?? "?",
                        expended: p.expended ?? false,
                      })),
                    },
                  ])
              ),
            })
          ),
        standaloneSpells: (() => {
          const entryIds = new Set(
            actor.items.filter((i: { type: string }) => i.type === "spellcastingEntry").map((e: { id: string }) => e.id)
          );
          return actor.items
            .filter(
              (i: { type: string; system: { location?: { value?: string } } }) =>
                i.type === "spell" && !entryIds.has(i.system.location?.value ?? "")
            )
            .map((i: { system: { slug?: string } }) => i.system.slug ?? "")
            .sort();
        })(),
        signatureSpells: actor.items
          .filter(
            (i: { type: string; system: { location?: { signature?: boolean } } }) =>
              i.type === "spell" && i.system.location?.signature === true
          )
          .map((i: { system: { slug?: string } }) => i.system.slug ?? "")
          .sort(),
        formulas: (
          await Promise.all(
            ((actor.system.crafting?.formulas ?? []) as Array<{ uuid?: string }>).map(async (f) => {
              try {
                // @ts-expect-error Foundry global
                const item = await fromUuid(f.uuid ?? "");
                return item?.name ?? "";
              } catch {
                return "";
              }
            })
          )
        ).sort(),
        equipment: actor.items
          .filter((i: { type: string }) =>
            ["weapon", "armor", "shield", "equipment", "consumable", "backpack", "ammo"].includes(i.type)
          )
          .map(
            (i: {
              name: string;
              type: string;
              system: {
                quantity: number;
                size: string;
                equipped: {
                  carryType: string;
                  handsHeld: number;
                  invested?: boolean | null;
                };
                containerId: string | null;
                runes?: { potency?: number; striking?: number; property?: string[] };
              };
            }) => ({
              name: i.name,
              type: i.type,
              quantity: i.system.quantity,
              carryType: i.system.equipped.carryType,
              handsHeld: i.system.equipped.handsHeld,
              containerId: i.system.containerId,
              invested: i.system.equipped.invested ?? null,
              size: i.system.size ?? "",
              runes: {
                potency: i.system.runes?.potency ?? 0,
                striking: i.system.runes?.striking ?? 0,
                property: i.system.runes?.property ?? [],
              },
            })
          ),
        currency: (() => {
          const t = actor.items.filter((i: { type: string }) => i.type === "treasure");
          const find = (s: string) => t.find((i: { system: { slug: string } }) => i.system.slug === s);
          return {
            pp: find("platinum-pieces")?.system.quantity ?? 0,
            gp: find("gold-pieces")?.system.quantity ?? 0,
            sp: find("silver-pieces")?.system.quantity ?? 0,
            cp: find("copper-pieces")?.system.quantity ?? 0,
          };
        })(),
      };
    },
    { actorName, characterId, token, moduleId: MODULE_ID },
    { timeout: 120_000 }
  );
}

/**
 * The expected shape of one spellcasting entry: identity (name, prepared
 * type, tradition, key ability, proficiency rank) plus contents (spell slugs
 * and, optionally, slot maximums/remaining counts).
 *
 * Ability is "" where the importer leaves it unset (feature-granted focus
 * entries); proficiency is the raw rank (1 = trained — the importer never
 * writes higher, progression rides the class item).
 */
export interface ExpectedSpellcastingEntry {
  name: string;
  prepared: string;
  tradition: string;
  ability: string;
  proficiency: number;
  flexible: boolean;
  dcMechanic: "spell-attack" | "class-dc";
  spells: string[];
  slots?: Record<string, { max: number; value: number }>;
}

/**
 * Asserts every expected spellcasting entry by name: type, tradition, key
 * ability, proficiency rank, flexible flag, DC mechanic, contents, and (when
 * given) slot maximums and remaining counts. Replaces the per-spec find/assert
 * blocks so entry identity is validated uniformly — including ability and
 * proficiency, which drive every spell attack and DC from the entry.
 */
export function expectSpellcastingEntries(result: ImportResult, expected: ExpectedSpellcastingEntry[]): void {
  for (const want of expected) {
    const entry = result.spellcasting.find((e) => e.name === want.name);
    expect(entry, `spellcasting entry "${want.name}"`).toBeDefined();
    expect(entry!.prepared).toBe(want.prepared);
    expect(entry!.tradition).toBe(want.tradition);
    expect(entry!.ability).toBe(want.ability);
    expect(entry!.proficiency).toBe(want.proficiency);
    expect(entry!.flexible).toBe(want.flexible);
    expect(entry!.dcMechanic).toBe(want.dcMechanic);
    expect(entry!.spells).toEqual(want.spells);
    for (const [slot, range] of Object.entries(want.slots ?? {})) {
      expect(entry!.slots[slot]).toMatchObject(range);
    }
  }
}
