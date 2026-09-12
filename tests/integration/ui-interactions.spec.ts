import { test, expect, type Page } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  waitForSyncRelease,
} from "./helpers.js";

/**
 * UI-interaction coverage for the module's Foundry-facing surfaces that a
 * headless import never touches: the linked-sheet header button and its info
 * dialog (demiplane-info-button.ts), the actor-directory context menu
 * (actor-context-menu.ts), the sidebar import button and its prompt
 * (directory-import.ts), and the settings token-validation button
 * (settings.ts). Every case drives the real DOM element the module registers
 * and asserts on the markup that appears — no direct calls into the module's
 * internal functions.
 *
 * A single Valeros import is shared across the suite so the linked-actor
 * surfaces (header button, context option) have a real actor to attach to.
 * All flows are deliberately non-destructive: dialogs are opened and then
 * dismissed/cancelled, and the token validation uses the empty-token branch so
 * no live API call is made.
 */
const VALEROS_UUID = process.env.VALEROS_L5_UUID ?? "a5884413-857f-444c-a5d6-24d819632c8a";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "UI Interactions Test";
const MODULE_ID = "demiplane-pf2e";

test.describe("Module UI interactions", () => {
  test.skip(!DEMIPLANE_TOKEN, "DEMIPLANE_TOKEN env var required");

  // Every interaction here is a local DOM action against an already-loaded
  // world, so a click or an element appearing should take a moment, not the
  // Playwright default of 30s. A short cap surfaces a genuinely-missing
  // element quickly instead of stalling. (The one exception — the live token
  // validation round-trip — passes its own longer timeout.)
  test.use({ actionTimeout: 5_000 });

  let page: Page;
  let actorId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, VALEROS_UUID, ACTOR_NAME);
    await createAndImportCharacter(page, ACTOR_NAME, VALEROS_UUID, DEMIPLANE_TOKEN);
    // The import holds the sync pause for a grace window after returning so
    // late hooks stay suppressed; wait for it to clear so the UI (header button
    // + context menu) is not greyed when the tests start.
    await waitForSyncRelease(page, VALEROS_UUID);
    // The import renames the actor to the Demiplane name, so re-resolve by the
    // characterId flag rather than the created name.
    actorId = await page.evaluate(
      ({ characterId, moduleId }) => {
        // @ts-expect-error Foundry global
        const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
        return actor.id as string;
      },
      { characterId: VALEROS_UUID, moduleId: MODULE_ID }
    );
  });

  test.afterAll(async () => {
    if (!page) return;
    await stopCoverage(page, "ui-interactions");
    await deleteActorsForCharacter(page, VALEROS_UUID, ACTOR_NAME);
    await page.close();
  });

  test.beforeEach(async () => {
    // Each test opens its own dialogs; start from a clean slate so a leftover
    // window or notification from a prior case can't satisfy an assertion here.
    await closeAllWindows(page);
    await clearNotifications(page);
  });

  test("header button opens the Demiplane info dialog", async () => {
    await openActorSheet(page, actorId);

    const headerButton = page.locator(".demiplane-info-btn").first();
    await expect(headerButton).toBeVisible();
    await headerButton.click();

    const dialog = page.locator(".demiplane-sync-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".window-title")).toContainText("Demiplane");
    await expect(dialog.locator(".demiplane-info-dialog")).toBeVisible();
    // Import happened in setup, so the dialog reports a real last-import time.
    await expect(dialog).toContainText("Last import from Demiplane:");
    // The sync actions render as DialogV2 footer buttons.
    await expect(dialog.locator("button[data-action='update']")).toBeVisible();
    await expect(dialog.locator("button[data-action='push']")).toBeVisible();
    await expect(dialog.locator("button[data-action='dismiss']")).toBeVisible();

    // Auto-sync defaults off, so the push button is disabled with a hint.
    await expect(dialog.locator("button[data-action='push']")).toBeDisabled();

    await dialog.locator("button[data-action='dismiss']").click();
    await expect(dialog).toHaveCount(0);
  });

  test("actor directory context menu offers Update from Demiplane", async () => {
    await openActorsSidebar(page);

    const entry = page.locator(`[data-entry-id="${actorId}"]`).first();
    await expect(entry).toBeVisible();
    await entry.click({ button: "right" });

    const option = page.locator("#context-menu li", { hasText: "Update from Demiplane" });
    await expect(option).toBeVisible();
    await option.click();

    // Clicking the option opens the wipe-and-reimport confirmation.
    const confirm = page.locator(".application.dialog", { hasText: "This will delete all imported items" });
    await expect(confirm).toBeVisible();
    await expect(confirm.locator(".window-title")).toContainText("Update from Demiplane");
    // Cancel — a "Yes" would kick off a real re-import.
    await confirm.locator("button[data-action='no']").click();
    await expect(confirm).toHaveCount(0);
  });

  test("sidebar import button prompts and rejects invalid input", async () => {
    await openActorsSidebar(page);

    const importButton = page.locator(".demiplane-import-btn");
    await expect(importButton).toBeVisible();
    await expect(importButton).toContainText("Import Demiplane Character");
    await importButton.click();

    const prompt = page.locator(".application.dialog", { has: page.locator('input[name="characterRef"]') });
    await expect(prompt).toBeVisible();
    await expect(prompt.locator(".window-title")).toContainText("Import Demiplane Character");

    await prompt.locator('input[name="characterRef"]').fill("not-a-valid-uuid");
    await prompt.locator("button[data-action='ok']").click();

    // The invalid reference is reported and no actor is created.
    await expect(page.locator("#notifications li.error")).toContainText("Invalid Demiplane character");
  });

  test("settings token validation button validates the configured token", async () => {
    await openModuleSettings(page);

    const validateButton = page.locator(".demiplane-token-validation");
    await expect(validateButton).toBeVisible();
    await expect(validateButton).toContainText("Validate token");

    // The seeded world stores the real Demiplane token (see
    // scripts/setup-foundry.spec.ts), so validating hits the live API and
    // exercises the success path plus the result dialog.
    await validateButton.click();

    // The result dialog waits on a live API round-trip, so it gets a longer
    // cap than the other pure-DOM assertions in this suite.
    const dialog = page.locator(".application.dialog", { hasText: "Demiplane authorization token" });
    await expect(dialog.locator(".window-title")).toContainText("Token validated", { timeout: 30_000 });
    await dialog.locator("button[data-action='ok']").click();
    await expect(dialog).toHaveCount(0);
  });
});

/** Renders a linked actor's sheet and waits for its header controls to paint. */
async function openActorSheet(page: Page, actorId: string): Promise<void> {
  await page.evaluate((id) => {
    // @ts-expect-error Foundry global
    const actor = game.actors.get(id);
    return actor.sheet.render(true);
  }, actorId);
  await page.locator(".demiplane-info-btn").first().waitFor({ state: "visible", timeout: 5_000 });
}

/**
 * Expands the sidebar and switches it to the Actors tab. The expand is
 * essential: headless Foundry boots with the sidebar collapsed, which pins
 * the actor list and import button off the right edge of the viewport, so
 * they render but can't be clicked.
 */
async function openActorsSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    // @ts-expect-error Foundry global
    ui.sidebar.expand();
    // @ts-expect-error Foundry global
    ui.sidebar.changeTab("actors", "primary");
  });
  await page.locator(".demiplane-import-btn").waitFor({ state: "visible", timeout: 5_000 });
}

/**
 * Opens Foundry's settings-config app and switches to the module's own
 * category. The token-validation button (injected by settings.ts on
 * `renderSettingsConfig`) lives inside that tab's panel, so it stays hidden
 * until the tab is active — the default open tab is Core.
 */
async function openModuleSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    // @ts-expect-error Foundry global
    return new foundry.applications.settings.SettingsConfig().render(true);
  });
  await page.locator(`[data-tab="${MODULE_ID}"]`).first().click();
  await page.locator(".demiplane-token-validation").waitFor({ state: "visible", timeout: 5_000 });
}

/**
 * Closes every open window before a case starts. Covers both the
 * ApplicationV1 windows tracked in `ui.windows` (sheets, settings) and the
 * native `<dialog>` elements DialogV2 uses (info/confirm/prompt dialogs),
 * which are not tracked there and would otherwise linger and intercept.
 */
async function closeAllWindows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // @ts-expect-error Foundry global
    for (const app of Object.values(ui.windows ?? {})) {
      // @ts-expect-error untyped window entry
      try {
        await app.close();
      } catch {
        /* already closing */
      }
    }
    document.querySelectorAll("dialog.application").forEach((dialog) => {
      try {
        (dialog as HTMLDialogElement).close();
      } catch {
        /* not open */
      }
      dialog.remove();
    });
    document.querySelectorAll("#context-menu").forEach((menu) => menu.remove());
  });
}

/** Removes any lingering toast notifications from a prior case. */
async function clearNotifications(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("#notifications li").forEach((el) => el.remove());
  });
}
