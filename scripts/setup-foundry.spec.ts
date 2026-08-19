/**
 * Playwright script for first-time Foundry VTT setup.
 *
 * Handles:
 * 1. License key entry (if on /license page)
 * 2. EULA agreement
 * 3. Admin login to setup page
 * 4. Dismiss tour/dialogs
 * 5. PF2e system installation
 * 6. Test world creation
 * 7. Launch world and log in as Gamemaster
 * 8. Enable module
 * 9. Create a Player user for testing
 *
 * Run via the setup shell script, or standalone:
 *   FOUNDRY_LICENSE_KEY=... npx playwright test scripts/setup-foundry.spec.ts --config=scripts/playwright-setup.config.ts
 */
import { test, expect, type Page } from "@playwright/test";

const PORT = process.env.FOUNDRY_PORT ?? "30000";
const BASE_URL = `http://localhost:${PORT}`;
const LICENSE_KEY = process.env.FOUNDRY_LICENSE_KEY ?? "";
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";
const WORLD_TITLE = "Demiplane Test";
const MODULE_ID = "foundry-demiplane-pf2e";
const PLAYER_NAME = "TestPlayer";

test("complete Foundry VTT setup with PF2e system, world, and users", async ({ page }) => {
  test.setTimeout(600_000);

  if (!LICENSE_KEY) {
    throw new Error(
      "FOUNDRY_LICENSE_KEY env var is required (format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX)"
    );
  }

  // ========== PHASE 1: License & Admin Setup ==========

  await page.goto(BASE_URL);
  await page.waitForTimeout(2000);

  // Keep trying until we reach /setup — handle license, EULA, and auth pages in a loop
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = page.url();

    if (url.includes("/setup") || url.includes("/game") || url.includes("/join")) {
      break;
    }

    if (url.includes("/license")) {
      // Check if there's a license key input
      const keyInput = page.getByPlaceholder("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX");
      if (await keyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("-> Entering license key...");
        await keyInput.fill(LICENSE_KEY);
        await page.getByRole("button", { name: "Submit Key" }).click();
        await page.waitForTimeout(3000);
        continue;
      }

      // Check if EULA is showing
      const eulaCheckbox = page.getByRole("checkbox", { name: "I agree to these terms" });
      if (await eulaCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("-> Accepting EULA...");
        await eulaCheckbox.click();
        await page.getByRole("button", { name: "Agree" }).click();
        await page.waitForTimeout(3000);
        continue;
      }

      // Neither key input nor EULA visible on /license — wait and retry
      console.log("-> On /license but no actionable element found, waiting...");
      await page.waitForTimeout(5000);
      await page.reload();
      await page.waitForTimeout(3000);
      continue;
    }

    if (url.includes("/auth")) {
      console.log("-> Logging in as admin...");
      await page.getByRole("textbox", { name: "Administrator Password" }).fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Log In" }).click();
      await page.waitForTimeout(3000);
      continue;
    }

    // Unknown page — wait and reload
    await page.waitForTimeout(3000);
  }

  await expect(page).toHaveURL(/\/(setup|game|join)/, { timeout: 30_000 });
  console.log("-> Reached: " + page.url());

  // If we ended up at /setup, proceed. If /game or /join, world already launched.
  if (page.url().includes("/setup")) {
    await dismissOverlays(page);

    // ========== PHASE 2: Install PF2e System ==========
    console.log("-> Checking for PF2e system...");
    await page.getByRole("heading", { name: "Game Systems" }).click();
    await page.waitForTimeout(1000);

    const pf2eInstalled = await page
      .locator("article", { hasText: "Pathfinder Second Edition" })
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (!pf2eInstalled) {
      console.log("-> Installing PF2e system...");
      await page.getByRole("button", { name: "Install System" }).click();
      await page.waitForTimeout(2000);
      await dismissOverlays(page);

      await page.getByRole("searchbox", { name: "Filter" }).fill("pathfinder");
      await page.waitForTimeout(3000);

      const pf2eArticle = page.locator("[data-package-id='pf2e']");
      const installBtn = pf2eArticle.getByRole("button", { name: "Install" });

      if (await installBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await installBtn.click();
        console.log("-> PF2e download started (this may take a few minutes)...");

        await pf2eArticle
          .getByRole("button", { name: "Installed" })
          .waitFor({ timeout: 300_000 });

        console.log("-> PF2e installed.");
      } else {
        console.log("-> PF2e already installed (in dialog).");
      }

      // Close install dialog
      await page.evaluate(() => {
        document.querySelectorAll("#notifications li").forEach(el => el.remove());
      });
      const closeBtn = page.locator(".window-app .header-control.fa-xmark");
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
      }
    } else {
      console.log("-> PF2e already installed.");
    }

    // ========== PHASE 3: Create Test World ==========
    console.log("-> Creating test world...");
    await page.getByRole("heading", { name: "Game Worlds" }).click();
    await page.waitForTimeout(1000);

    const worldExists = await page
      .locator("article", { hasText: WORLD_TITLE })
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (!worldExists) {
      await page.getByRole("button", { name: "Create World" }).click();
      await page.waitForTimeout(2000);

      await page.getByLabel("World Title").fill(WORLD_TITLE);
      await page.getByLabel("Game System").selectOption("pf2e");

      await page
        .locator("form.create-world button[type='submit'], form.create-world button[data-action='submit']")
        .click();
      await page.waitForTimeout(3000);
      console.log("-> Test world created.");
    } else {
      console.log("-> Test world already exists.");
    }

    // ========== PHASE 4: Launch World ==========
    console.log("-> Launching test world...");
    const worldArticle = page.locator("article", { hasText: WORLD_TITLE });
    const launchBtn = worldArticle.locator("[data-action='worldLaunch'], button:has-text('Launch')");
    await launchBtn.first().click();

    await page.waitForURL(/\/(join|game)/, { timeout: 60_000 });
    console.log("-> World launched.");
  }

  // ========== PHASE 5: Log in as Gamemaster ==========
  if (page.url().includes("/join")) {
    console.log("-> Joining as Gamemaster...");
    const gmOption = page.locator("[data-user-id]", { hasText: "Gamemaster" });
    if (await gmOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await gmOption.click();
    }
    await page.getByRole("button", { name: "Join Game Session" }).click();
    await page.waitForURL(/\/game/, { timeout: 60_000 });
  }

  await page.waitForTimeout(8000); // Let PF2e finish initializing
  console.log("-> Logged in as Gamemaster.");
  await dismissOverlays(page);

  // ========== PHASE 6: Enable Module ==========
  console.log("-> Enabling module...");
  const moduleEnabled = await page.evaluate(async (moduleId) => {
    // @ts-expect-error Foundry global
    const mod = game.modules.get(moduleId);
    if (!mod) return "not_found";
    if (mod.active) return "already_active";
    // @ts-expect-error Foundry global
    const config = game.settings.get("core", "moduleConfiguration") as Record<string, boolean>;
    config[moduleId] = true;
    // @ts-expect-error Foundry global
    await game.settings.set("core", "moduleConfiguration", config);
    return "activated";
  }, MODULE_ID);

  console.log("-> Module status: " + moduleEnabled);

  if (moduleEnabled === "activated") {
    // Need to reload for module to take effect
    await page.reload();
    await page.waitForTimeout(3000);

    // May need to re-join
    if (page.url().includes("/join")) {
      const gmOption = page.locator("[data-user-id]", { hasText: "Gamemaster" });
      if (await gmOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await gmOption.click();
      }
      await page.getByRole("button", { name: "Join Game Session" }).click();
      await page.waitForURL(/\/game/, { timeout: 60_000 });
      await page.waitForTimeout(8000);
    }
  }

  if (moduleEnabled === "not_found") {
    console.log("   WARNING: Module not found. Is it symlinked into Data/modules?");
  }

  // ========== PHASE 7: Create Player User ==========
  console.log("-> Creating player user...");
  const playerResult = await page.evaluate(async (playerName) => {
    // @ts-expect-error Foundry global
    const existing = game.users.find((u: { name: string }) => u.name === playerName);
    if (existing) return "exists";
    // @ts-expect-error Foundry global
    await User.create({ name: playerName, role: 1, password: "" });
    return "created";
  }, PLAYER_NAME);

  console.log("-> Player user: " + playerResult);

  // ========== Done ==========
  console.log("");
  console.log("=== Setup Complete ===");
  console.log("  World: " + WORLD_TITLE + " (PF2e)");
  console.log("  Module: " + MODULE_ID + " (" + moduleEnabled + ")");
  console.log("  Users: Gamemaster (no password), " + PLAYER_NAME + " (no password)");
  console.log("  URL: " + BASE_URL);
});

async function dismissOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll(".tour-overlay, .tour-center-step").forEach(el => el.remove());
    document.querySelectorAll("#notifications li").forEach(el => el.remove());
  });

  // Dismiss "Allow Sharing Usage Data" dialog specifically
  const usageDataDialog = page.locator("text=Allow Sharing Usage Data");
  if (await usageDataDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log("   (dismissing usage data dialog)");
    // Try "Decline" first, then "No", then generic close
    const declineBtn = page.getByRole("button", { name: "Decline" });
    const noBtn = page.getByRole("button", { name: "No" });
    if (await declineBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await declineBtn.click();
    } else if (await noBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await noBtn.click();
    } else {
      // Close any dialog window that's open
      const closeBtn = page.locator(".window-app .header-control.fa-xmark").first();
      if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await closeBtn.click();
      }
    }
    await page.waitForTimeout(500);
  }

  // Close any remaining dialog windows
  const closeBtn = page.getByRole("button", { name: "Close Window" });
  if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeBtn.click();
  }
}
