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
import { test, expect } from "@playwright/test";

const PORT = process.env.FOUNDRY_PORT ?? "30000";
const BASE_URL = `http://localhost:${PORT}`;
const LICENSE_KEY = process.env.FOUNDRY_LICENSE_KEY ?? "";
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";
const WORLD_TITLE = "Demiplane Test";
const MODULE_ID = "foundry-demiplane-pf2e";
const PLAYER_NAME = "TestPlayer";

test("complete Foundry VTT setup with PF2e system, world, and users", async ({ page }) => {
  test.setTimeout(600_000); // 10 minutes for PF2e download

  if (!LICENSE_KEY) {
    throw new Error(
      "FOUNDRY_LICENSE_KEY env var is required (format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX)"
    );
  }

  // ========== PHASE 1: License & Admin Setup ==========

  await page.goto(BASE_URL);

  // --- License Key ---
  if (page.url().includes("/license")) {
    console.log("→ Entering license key...");
    const keyInput = page.getByPlaceholder("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX");

    if (await keyInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await keyInput.fill(LICENSE_KEY);
      await page.getByRole("button", { name: "Submit Key" }).click();
    }

    // --- EULA ---
    const eulaHeading = page.getByRole("heading", { name: "End User License Agreement" });
    if (await eulaHeading.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log("→ Accepting EULA...");
      await page.getByRole("checkbox", { name: "I agree to these terms" }).click();
      await page.getByRole("button", { name: "Agree" }).click();
    }
  }

  // --- Admin Login ---
  if (page.url().includes("/auth")) {
    console.log("→ Logging in as admin...");
    await page.getByRole("textbox", { name: "Administrator Password" }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Log In" }).click();
  }

  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 });
  console.log("→ On setup page.");

  // --- Dismiss overlays ---
  await dismissOverlays(page);

  // ========== PHASE 2: Install PF2e System ==========

  console.log("→ Checking for PF2e system...");
  await page.getByRole("heading", { name: "Game Systems" }).click();
  await page.waitForTimeout(1000);

  const pf2eInstalled = await page
    .locator("article", { hasText: "Pathfinder Second Edition" })
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (!pf2eInstalled) {
    console.log("→ Installing PF2e system...");
    await page.getByRole("button", { name: "Install System" }).click();
    await page.waitForTimeout(2000);

    await page.getByRole("searchbox", { name: "Filter" }).fill("pathfinder");
    await page.waitForTimeout(3000);

    const pf2eArticle = page.locator("[data-package-id='pf2e']");
    const installBtn = pf2eArticle.getByRole("button", { name: "Install" });

    if (await installBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await installBtn.click();
      console.log("→ PF2e download started (this may take a few minutes)...");

      await pf2eArticle
        .getByRole("button", { name: "Installed" })
        .waitFor({ timeout: 300_000 });

      console.log("→ PF2e installed.");
    } else {
      console.log("→ PF2e already installed (in dialog).");
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
    console.log("→ PF2e already installed.");
  }

  // ========== PHASE 3: Create Test World ==========

  console.log("→ Creating test world...");
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

    // Submit the create world form
    await page
      .locator("form.create-world button[type='submit'], form.create-world button[data-action='submit']")
      .click();
    await page.waitForTimeout(3000);
    console.log("→ Test world created.");
  } else {
    console.log("→ Test world already exists.");
  }

  // ========== PHASE 4: Launch World ==========

  console.log("→ Launching test world...");

  // Click the Launch button on the world
  const worldArticle = page.locator("article", { hasText: WORLD_TITLE });
  const launchBtn = worldArticle.getByRole("button", { name: "Launch" });

  if (await launchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await launchBtn.click();
  } else {
    // Try the play/launch icon button
    await worldArticle.locator("[data-action='worldLaunch'], [data-action='launch']").click();
  }

  // Wait for the world to load — redirects to /join
  await page.waitForURL(/\/(join|game)/, { timeout: 60_000 });
  console.log("→ World launched.");

  // ========== PHASE 5: Log in as Gamemaster ==========

  if (page.url().includes("/join")) {
    console.log("→ Joining as Gamemaster...");

    // Select the Gamemaster user
    const gmOption = page.locator("[data-user-id]", { hasText: "Gamemaster" });
    if (await gmOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await gmOption.click();
    } else {
      // Try selecting from a dropdown
      await page.getByLabel("Select Player").selectOption({ label: "Gamemaster" });
    }

    // No password for GM by default — just click Join
    await page.getByRole("button", { name: "Join Game Session" }).click();
  }

  // Wait for the game canvas to load
  await page.waitForURL(/\/game/, { timeout: 60_000 });
  await page.waitForTimeout(5000); // Let PF2e finish initializing
  console.log("→ Logged in as Gamemaster.");

  // Dismiss any post-login dialogs/tours
  await dismissOverlays(page);

  // ========== PHASE 6: Enable Module ==========

  console.log("→ Enabling module...");

  // Open Module Management via settings
  await page.evaluate(async (moduleId) => {
    // @ts-expect-error Foundry global
    const module = game.modules.get(moduleId);
    if (module && !module.active) {
      // @ts-expect-error Foundry global
      await game.settings.set("core", "moduleConfiguration", {
        // @ts-expect-error Foundry global
        ...game.settings.get("core", "moduleConfiguration"),
        [moduleId]: true,
      });
      // Reload to activate
      window.location.reload();
    }
  }, MODULE_ID);

  // Wait for reload if it happened
  await page.waitForTimeout(5000);
  if (page.url().includes("/join")) {
    // Re-join after reload
    const gmOption = page.locator("[data-user-id]", { hasText: "Gamemaster" });
    if (await gmOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await gmOption.click();
    }
    await page.getByRole("button", { name: "Join Game Session" }).click();
    await page.waitForURL(/\/game/, { timeout: 30_000 });
    await page.waitForTimeout(5000);
  }

  console.log("→ Module enabled.");

  // ========== PHASE 7: Create Player User ==========

  console.log("→ Creating player user...");

  const playerCreated = await page.evaluate(async (playerName) => {
    // @ts-expect-error Foundry global
    const existingUser = game.users.find((u: { name: string }) => u.name === playerName);
    if (existingUser) return "exists";

    // @ts-expect-error Foundry global
    await User.create({
      name: playerName,
      role: 1, // PLAYER role
      password: "",
    });
    return "created";
  }, PLAYER_NAME);

  if (playerCreated === "created") {
    console.log(`→ Player user "${PLAYER_NAME}" created.`);
  } else {
    console.log(`→ Player user "${PLAYER_NAME}" already exists.`);
  }

  // ========== Done ==========

  console.log("");
  console.log("✓ Setup complete!");
  console.log(`  World: "${WORLD_TITLE}" (PF2e)`);
  console.log(`  Module: ${MODULE_ID} enabled`);
  console.log(`  Users: Gamemaster (no password), ${PLAYER_NAME} (no password)`);
  console.log(`  URL: ${BASE_URL}`);
});

/** Dismiss tour overlays, notification toasts, and popup dialogs */
async function dismissOverlays(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll(".tour-overlay, .tour-center-step").forEach(el => el.remove());
    document.querySelectorAll("#notifications li").forEach(el => el.remove());
  });

  // Close any open dialog windows
  const closeBtn = page.getByRole("button", { name: "Close Window" });
  if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBtn.click();
  }
}
