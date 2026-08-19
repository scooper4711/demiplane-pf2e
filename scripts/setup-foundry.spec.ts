/**
 * Playwright script for first-time Foundry VTT setup.
 *
 * Handles:
 * 1. License key entry (if on /license page)
 * 2. EULA agreement
 * 3. Admin login
 * 4. Dismiss tour/dialogs
 * 5. PF2e system installation
 * 6. Test world creation
 *
 * Run via the setup shell script, or standalone:
 *   FOUNDRY_LICENSE_KEY=... FOUNDRY_PORT=30000 npx playwright test scripts/setup-foundry.spec.ts --config=scripts/playwright-setup.config.ts
 */
import { test, expect } from "@playwright/test";

const PORT = process.env.FOUNDRY_PORT ?? "30000";
const BASE_URL = `http://localhost:${PORT}`;
const LICENSE_KEY = process.env.FOUNDRY_LICENSE_KEY ?? "";
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";

test("complete Foundry VTT setup with PF2e system and test world", async ({ page }) => {
  test.setTimeout(600_000); // 10 minutes for PF2e download

  if (!LICENSE_KEY) {
    throw new Error(
      "FOUNDRY_LICENSE_KEY env var is required (format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX)"
    );
  }

  // --- Navigate to Foundry ---
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

  // Wait to reach /setup
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 });
  console.log("→ On setup page.");

  // --- Dismiss overlays ---
  await page.evaluate(() => {
    document.querySelectorAll(".tour-overlay, .tour-center-step").forEach(el => el.remove());
  });

  // Dismiss usage data dialog
  const closeWindowBtn = page.getByRole("button", { name: "Close Window" });
  if (await closeWindowBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await closeWindowBtn.click();
  }

  // --- Install PF2e System ---
  console.log("→ Checking for PF2e system...");
  await page.getByRole("heading", { name: "Game Systems" }).click();
  await page.waitForTimeout(1000);

  // Check if PF2e is already installed
  const pf2eInstalled = await page.locator("article", { hasText: "Pathfinder Second Edition" }).isVisible({ timeout: 2000 }).catch(() => false);

  if (!pf2eInstalled) {
    console.log("→ Installing PF2e system...");
    await page.getByRole("button", { name: "Install System" }).click();
    await page.waitForTimeout(2000);

    // Search for Pathfinder in the install dialog
    await page.getByRole("searchbox", { name: "Filter" }).fill("pathfinder");
    await page.waitForTimeout(3000);

    // Find PF2e in results and install
    const pf2eArticle = page.locator("[data-package-id='pf2e']");
    const installBtn = pf2eArticle.getByRole("button", { name: "Install" });

    if (await installBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await installBtn.click();
      console.log("→ PF2e download started (this may take a few minutes)...");

      // Wait for install to complete — PF2e is ~200MB
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

  // --- Create Test World ---
  console.log("→ Creating test world...");
  await page.getByRole("heading", { name: "Game Worlds" }).click();
  await page.waitForTimeout(1000);

  const worldExists = await page
    .locator("article", { hasText: "Demiplane Test" })
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (!worldExists) {
    await page.getByRole("button", { name: "Create World" }).click();
    await page.waitForTimeout(2000);

    // Fill in world details
    await page.getByLabel("World Title").fill("Demiplane Test");

    // Select PF2e as the game system
    const systemSelect = page.getByLabel("Game System");
    await systemSelect.selectOption("pf2e");

    // Submit
    await page.locator("form.create-world button[type='submit'], form.create-world button[data-action='submit']").click();
    await page.waitForTimeout(3000);
    console.log("→ Test world created.");
  } else {
    console.log("→ Test world already exists.");
  }

  console.log("✓ Setup complete!");
});
