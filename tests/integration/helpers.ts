import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const PORT = process.env.FOUNDRY_TEST_PORT ?? "30001";
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";
const MODULE_ID = "demiplane-pf2e";
/** Our bundled module script, the only URL coverage is collected for. */
const MODULE_BUNDLE_MARKER = "demiplane-pf2e/dist/module.js";
// Playwright always runs from the repo root.
const COVERAGE_RAW_DIR = resolve("coverage/e2e-raw");

/** Button labels that unambiguously dismiss (never accept) a popup. */
const DISMISS_BUTTON_NAMES = [
  "Close Window",
  "Close",
  "Dismiss",
  "Decline",
  "No",
  "End Tour",
  "Got it",
  "Don't Show Again",
];

/**
 * Clears first-run popups (NUE tours, welcome/what's-new dialogs, usage-data
 * prompts). These appear on a clean data dir but never on the second run,
 * which is the classic clean-checkout flake source. Only ever *dismisses* —
 * never clicks OK/Accept/Join — and is only used during login, never while a
 * test dialog of our own might be open.
 */
export async function dismissOverlays(page: Page): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    await page
      .evaluate(() => {
        document.querySelectorAll(".tour-overlay, .tour-center-step").forEach((el) => el.remove());
        document.querySelectorAll("#notifications li").forEach((el) => el.remove());
      })
      .catch(() => {});

    let clicked = false;
    for (const name of DISMISS_BUTTON_NAMES) {
      const button = page.getByRole("button", { name, exact: true });
      if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
        await button.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) return;
    if (Date.now() > deadline) return;
    await page.waitForTimeout(500);
  }
}

export async function loginAsGamemaster(page: Page): Promise<void> {
  await startCoverage(page);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // The test instance boots straight into the world (--world flag), so the
  // common case is landing on /join with first-run popups on top.
  await dismissOverlays(page);

  for (let attempt = 0; attempt < 8; attempt++) {
    const url = page.url();

    if (url.includes("/game")) {
      await page.waitForFunction(() => (globalThis as unknown as { game: { ready: boolean } }).game?.ready === true, {
        timeout: 90_000,
      });
      await dismissOverlays(page);
      // Enabling needs a reload (handled inside); after one, or when the
      // registry briefly disagrees right after ready, loop back and verify
      // rather than trusting a single read.
      await ensureModuleActive(page);
      if (await isModuleActive(page)) return;
      continue;
    }

    if (url.includes("/auth")) {
      await page.getByRole("textbox", { name: "Administrator Password" }).fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Log In" }).click();
      await page.waitForURL(/\/(setup|join|game)/, { timeout: 30_000 }).catch(() => {});
      continue;
    }

    if (url.includes("/join")) {
      // Select Gamemaster from the autocomplete dropdown. The option is an
      // <li> inside #autocomplete (NOT the wrapping <menu>, whose text also
      // matches) — clicking the wrapper selects nothing and Join silently
      // does nothing.
      const userSelect = page.getByRole("textbox", { name: "Select User" });
      // waitFor (not isVisible): the form renders async after page load, and
      // isVisible() does not wait — gating on it skips user selection entirely.
      await userSelect.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
      if (await userSelect.isVisible().catch(() => false)) {
        await userSelect.click().catch(() => {});
        await userSelect.fill("Gamemaster");
        // click() auto-waits for the suggestion; isVisible() would not.
        const selected = await page
          .locator("#autocomplete li", { hasText: /^Gamemaster$/ })
          .click({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (!selected) {
          // Fallback: keyboard-select the highlighted suggestion.
          await userSelect.press("ArrowDown").catch(() => {});
          await userSelect.press("Enter").catch(() => {});
        }
      }

      // Click Join (waits for the button to actually enable)
      const joinButton = page.getByRole("button", { name: "Join Game Session" });
      await joinButton.waitFor({ state: "visible", timeout: 15_000 });
      await Promise.all([page.waitForURL(/\/game/, { timeout: 90_000, waitUntil: "commit" }), joinButton.click()]);
      await page.waitForFunction(() => (globalThis as unknown as { game: { ready: boolean } }).game?.ready === true, {
        timeout: 90_000,
      });
      await dismissOverlays(page);
      return;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error(`Failed to reach /game. Current URL: ${page.url()}`);
}

/**
 * Activates our module if the world doesn't have it enabled (always the case
 * on a clean data dir). Enabling requires a client reload; the login loop
 * re-joins afterwards. Idempotent — safe to call when already active.
 */
export async function ensureModuleActive(page: Page): Promise<void> {
  const status = await page.evaluate(async (moduleId: string) => {
    const g = globalThis as unknown as {
      game: {
        modules: { get: (id: string) => { active?: boolean } | undefined };
        settings: {
          get: (m: string, k: string) => Record<string, boolean>;
          set: (m: string, k: string, v: unknown) => Promise<unknown>;
        };
      };
    };
    const mod = g.game.modules.get(moduleId);
    if (!mod) return "not_found";
    if (mod.active) return "already_active";
    const config = g.game.settings.get("core", "moduleConfiguration");
    config[moduleId] = true;
    await g.game.settings.set("core", "moduleConfiguration", config);
    return "activated";
  }, MODULE_ID);

  if (status === "not_found") {
    throw new Error(
      `Module ${MODULE_ID} not found. Is it linked into Data/modules? (global-setup does this automatically.)`
    );
  }
  if (status === "activated") {
    await page.reload();
  }
}

/** Reads back whether our module is actually active right now. */
export async function isModuleActive(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const g = globalThis as unknown as {
        game?: { modules?: { get: (id: string) => { active?: boolean } | undefined } };
      };
      return g.game?.modules?.get("demiplane-pf2e")?.active === true;
    })
    .catch(() => false);
}

/**
 * Begins Chromium JS coverage on the page. Must run before navigation so
 * module init is captured; `resetOnNavigation: false` keeps counting across
 * the /join → /game hop. No-op outside Chromium.
 */
export async function startCoverage(page: Page): Promise<void> {
  await page.coverage?.startJSCoverage({ resetOnNavigation: false }).catch(() => {});
}

/**
 * Stops coverage and writes this page's raw V8 ranges for our bundle to
 * `coverage/e2e-raw/<name>.json` for `scripts/e2e-coverage.mjs` to convert.
 * Call once per spec after the import; the cleanup page needs none.
 */
export async function stopCoverage(page: Page, name: string): Promise<void> {
  const entries = await page.coverage?.stopJSCoverage().catch(() => undefined);
  if (!entries) return;
  const ours = entries.filter((entry) => entry.url.includes(MODULE_BUNDLE_MARKER));
  if (ours.length === 0) return;
  mkdirSync(COVERAGE_RAW_DIR, { recursive: true });
  writeFileSync(
    `${COVERAGE_RAW_DIR}/${name}.json`,
    JSON.stringify(ours.map(({ url, functions }) => ({ url, functions })))
  );
}

/** Waits until our module API is callable — it lands after game.ready. */
export async function waitForModuleApi(page: Page): Promise<void> {
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

export interface ImportResult {
  summary: {
    itemsImported: number;
    itemsSkipped: number;
    errors: string[];
    log: string[];
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
    runes: { potency: number; striking: number; property: string[] };
  }>;
  currency: { pp: number; gp: number; sp: number; cp: number };
  hp: { value: number; max: number; temp: number };
  heroPoints: number;
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
