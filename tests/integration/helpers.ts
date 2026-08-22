import type { Page } from "@playwright/test";

const PORT = process.env.FOUNDRY_TEST_PORT ?? "30001";
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";
const MODULE_ID = "demiplane-pf2e";

export async function loginAsGamemaster(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Dismiss any blocking dialogs (usage data sharing, tours, etc.)
  await page
    .evaluate(() => {
      document
        .querySelectorAll("dialog")
        .forEach((el: HTMLDialogElement) => el.close());
      document
        .querySelectorAll(".tour-overlay, .tour-center-step, #notifications li")
        .forEach((el) => el.remove());
    })
    .catch(() => {});

  for (let attempt = 0; attempt < 5; attempt++) {
    const url = page.url();

    if (url.includes("/game")) {
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { game: { ready: boolean } }).game
            ?.ready === true,
        { timeout: 60_000 },
      );
      return;
    }

    if (url.includes("/auth")) {
      await page
        .getByRole("textbox", { name: "Administrator Password" })
        .fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Log In" }).click();
      await page.waitForTimeout(2000);
      continue;
    }

    if (url.includes("/join")) {
      // Select Gamemaster from the user dropdown/combobox
      const userSelect = page.getByRole("textbox", { name: "Select User" });
      if (await userSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
        await userSelect.fill("Gamemaster");
        // Click the Gamemaster option in the dropdown
        await page.locator("text=Gamemaster").first().click();
        await page.waitForTimeout(500);
      }

      // Click Join
      await Promise.all([
        page.waitForURL(/\/game/, { timeout: 60_000, waitUntil: "commit" }),
        page.getByRole("button", { name: "Join Game Session" }).click(),
      ]);
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { game: { ready: boolean } }).game
            ?.ready === true,
        { timeout: 60_000 },
      );
      return;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error(`Failed to reach /game. Current URL: ${page.url()}`);
}

export async function deleteActorByName(
  page: Page,
  name: string,
): Promise<void> {
  await page.evaluate(async (actorName: string) => {
    // @ts-expect-error Foundry global
    const actor = game.actors.getName(actorName);
    if (actor) await actor.delete();
  }, name);
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
  }>;
  currency: { pp: number; gp: number; sp: number; cp: number };
  hp: { value: number; max: number; temp: number };
  heroPoints: number;
}

export async function createAndImportCharacter(
  page: Page,
  actorName: string,
  characterId: string,
  token: string,
): Promise<ImportResult> {
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
        ancestry:
          actor.items.find((i: { type: string }) => i.type === "ancestry")
            ?.name ?? null,
        heritage:
          actor.items.find((i: { type: string }) => i.type === "heritage")
            ?.name ?? null,
        background:
          actor.items.find((i: { type: string }) => i.type === "background")
            ?.name ?? null,
        class:
          actor.items.find((i: { type: string }) => i.type === "class")?.name ??
          null,
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
            }),
          ),
        languages: actor.system.details.languages.value as string[],
        gender: (actor.system.details.gender?.value as string) || "",
        ethnicity: (actor.system.details.ethnicity?.value as string) || "",
        nationality: (actor.system.details.nationality?.value as string) || "",
        deity:
          actor.items.find((i: { type: string }) => i.type === "deity")?.name ||
          (actor.system.details.deity?.value as string) ||
          "",
        loreSkills: actor.items
          .filter((i: { type: string }) => i.type === "lore")
          .map((i: { name: string }) => i.name),
        skills: Object.fromEntries(
          Object.entries(actor.system.skills)
            .filter(([_, d]) => (d as { rank: number }).rank > 0)
            .map(([k, d]) => [k, (d as { rank: number }).rank]),
        ),
        abilities: Object.fromEntries(
          Object.entries(actor.system.abilities).map(([k, d]) => [
            k,
            (d as { mod: number }).mod,
          ]),
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
            [
              "weapon",
              "armor",
              "shield",
              "equipment",
              "consumable",
              "backpack",
              "ammo",
            ].includes(i.type),
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
              };
            }) => ({
              name: i.name,
              type: i.type,
              quantity: i.system.quantity,
              carryType: i.system.equipped.carryType,
              handsHeld: i.system.equipped.handsHeld,
              containerId: i.system.containerId,
              invested: i.system.equipped.invested ?? null,
            }),
          ),
        currency: (() => {
          const t = actor.items.filter(
            (i: { type: string }) => i.type === "treasure",
          );
          const find = (s: string) =>
            t.find((i: { system: { slug: string } }) => i.system.slug === s);
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
  );
}
