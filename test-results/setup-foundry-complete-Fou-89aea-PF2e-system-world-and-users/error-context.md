# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: setup-foundry.spec.ts >> complete Foundry VTT setup with PF2e system, world, and users
- Location: scripts/setup-foundry.spec.ts:28:1

# Error details

```
Test timeout of 600000ms exceeded.
```

```
Error: locator.click: Test timeout of 600000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Install System' })
    - locator resolved to <button type="button" data-action="installPackage">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="tour-overlay"></div> intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="tour-overlay"></div> intercepts pointer events
    - retrying click action
      - waiting 100ms
    362 × waiting for element to be visible, enabled and stable
        - element is visible, enabled and stable
        - scrolling into view if needed
        - done scrolling
        - <div class="tour-overlay"></div> intercepts pointer events
      - retrying click action
        - waiting 500ms
  - element was detached from the DOM, retrying

```

# Test source

```ts
  10  |  * 6. Test world creation
  11  |  * 7. Launch world and log in as Gamemaster
  12  |  * 8. Enable module
  13  |  * 9. Create a Player user for testing
  14  |  *
  15  |  * Run via the setup shell script, or standalone:
  16  |  *   FOUNDRY_LICENSE_KEY=... npx playwright test scripts/setup-foundry.spec.ts --config=scripts/playwright-setup.config.ts
  17  |  */
  18  | import { test, expect, type Page } from "@playwright/test";
  19  | 
  20  | const PORT = process.env.FOUNDRY_PORT ?? "30000";
  21  | const BASE_URL = `http://localhost:${PORT}`;
  22  | const LICENSE_KEY = process.env.FOUNDRY_LICENSE_KEY ?? "";
  23  | const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";
  24  | const WORLD_TITLE = "Demiplane Test";
  25  | const MODULE_ID = "foundry-demiplane-pf2e";
  26  | const PLAYER_NAME = "TestPlayer";
  27  | 
  28  | test("complete Foundry VTT setup with PF2e system, world, and users", async ({ page }) => {
  29  |   test.setTimeout(600_000);
  30  | 
  31  |   if (!LICENSE_KEY) {
  32  |     throw new Error(
  33  |       "FOUNDRY_LICENSE_KEY env var is required (format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX)"
  34  |     );
  35  |   }
  36  | 
  37  |   // ========== PHASE 1: License & Admin Setup ==========
  38  | 
  39  |   await page.goto(BASE_URL);
  40  |   await page.waitForTimeout(2000);
  41  | 
  42  |   // Keep trying until we reach /setup — handle license, EULA, and auth pages in a loop
  43  |   for (let attempt = 0; attempt < 5; attempt++) {
  44  |     const url = page.url();
  45  | 
  46  |     if (url.includes("/setup") || url.includes("/game") || url.includes("/join")) {
  47  |       break;
  48  |     }
  49  | 
  50  |     if (url.includes("/license")) {
  51  |       // Check if there's a license key input
  52  |       const keyInput = page.getByPlaceholder("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX");
  53  |       if (await keyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
  54  |         console.log("-> Entering license key...");
  55  |         await keyInput.fill(LICENSE_KEY);
  56  |         await page.getByRole("button", { name: "Submit Key" }).click();
  57  |         await page.waitForTimeout(3000);
  58  |         continue;
  59  |       }
  60  | 
  61  |       // Check if EULA is showing
  62  |       const eulaCheckbox = page.getByRole("checkbox", { name: "I agree to these terms" });
  63  |       if (await eulaCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
  64  |         console.log("-> Accepting EULA...");
  65  |         await eulaCheckbox.click();
  66  |         await page.getByRole("button", { name: "Agree" }).click();
  67  |         await page.waitForTimeout(3000);
  68  |         continue;
  69  |       }
  70  | 
  71  |       // Neither key input nor EULA visible on /license — wait and retry
  72  |       console.log("-> On /license but no actionable element found, waiting...");
  73  |       await page.waitForTimeout(5000);
  74  |       await page.reload();
  75  |       await page.waitForTimeout(3000);
  76  |       continue;
  77  |     }
  78  | 
  79  |     if (url.includes("/auth")) {
  80  |       console.log("-> Logging in as admin...");
  81  |       await page.getByRole("textbox", { name: "Administrator Password" }).fill(ADMIN_PASSWORD);
  82  |       await page.getByRole("button", { name: "Log In" }).click();
  83  |       await page.waitForTimeout(3000);
  84  |       continue;
  85  |     }
  86  | 
  87  |     // Unknown page — wait and reload
  88  |     await page.waitForTimeout(3000);
  89  |   }
  90  | 
  91  |   await expect(page).toHaveURL(/\/(setup|game|join)/, { timeout: 30_000 });
  92  |   console.log("-> Reached: " + page.url());
  93  | 
  94  |   // If we ended up at /setup, proceed. If /game or /join, world already launched.
  95  |   if (page.url().includes("/setup")) {
  96  |     await dismissOverlays(page);
  97  | 
  98  |     // ========== PHASE 2: Install PF2e System ==========
  99  |     console.log("-> Checking for PF2e system...");
  100 |     await page.getByRole("heading", { name: "Game Systems" }).click();
  101 |     await page.waitForTimeout(1000);
  102 | 
  103 |     const pf2eInstalled = await page
  104 |       .locator("article", { hasText: "Pathfinder Second Edition" })
  105 |       .isVisible({ timeout: 2000 })
  106 |       .catch(() => false);
  107 | 
  108 |     if (!pf2eInstalled) {
  109 |       console.log("-> Installing PF2e system...");
> 110 |       await page.getByRole("button", { name: "Install System" }).click();
      |                                                                  ^ Error: locator.click: Test timeout of 600000ms exceeded.
  111 |       await page.waitForTimeout(2000);
  112 |       await dismissOverlays(page);
  113 | 
  114 |       await page.getByRole("searchbox", { name: "Filter" }).fill("pathfinder");
  115 |       await page.waitForTimeout(3000);
  116 | 
  117 |       const pf2eArticle = page.locator("[data-package-id='pf2e']");
  118 |       const installBtn = pf2eArticle.getByRole("button", { name: "Install" });
  119 | 
  120 |       if (await installBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
  121 |         await installBtn.click();
  122 |         console.log("-> PF2e download started (this may take a few minutes)...");
  123 | 
  124 |         await pf2eArticle
  125 |           .getByRole("button", { name: "Installed" })
  126 |           .waitFor({ timeout: 300_000 });
  127 | 
  128 |         console.log("-> PF2e installed.");
  129 |       } else {
  130 |         console.log("-> PF2e already installed (in dialog).");
  131 |       }
  132 | 
  133 |       // Close install dialog
  134 |       await page.evaluate(() => {
  135 |         document.querySelectorAll("#notifications li").forEach(el => el.remove());
  136 |       });
  137 |       const closeBtn = page.locator(".window-app .header-control.fa-xmark");
  138 |       if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
  139 |         await closeBtn.click();
  140 |       }
  141 |     } else {
  142 |       console.log("-> PF2e already installed.");
  143 |     }
  144 | 
  145 |     // ========== PHASE 3: Create Test World ==========
  146 |     console.log("-> Creating test world...");
  147 |     await page.getByRole("heading", { name: "Game Worlds" }).click();
  148 |     await page.waitForTimeout(1000);
  149 | 
  150 |     const worldExists = await page
  151 |       .locator("article", { hasText: WORLD_TITLE })
  152 |       .isVisible({ timeout: 2000 })
  153 |       .catch(() => false);
  154 | 
  155 |     if (!worldExists) {
  156 |       await page.getByRole("button", { name: "Create World" }).click();
  157 |       await page.waitForTimeout(2000);
  158 | 
  159 |       await page.getByLabel("World Title").fill(WORLD_TITLE);
  160 |       await page.getByLabel("Game System").selectOption("pf2e");
  161 | 
  162 |       await page
  163 |         .locator("form.create-world button[type='submit'], form.create-world button[data-action='submit']")
  164 |         .click();
  165 |       await page.waitForTimeout(3000);
  166 |       console.log("-> Test world created.");
  167 |     } else {
  168 |       console.log("-> Test world already exists.");
  169 |     }
  170 | 
  171 |     // ========== PHASE 4: Launch World ==========
  172 |     console.log("-> Launching test world...");
  173 |     const worldArticle = page.locator("article", { hasText: WORLD_TITLE });
  174 |     const launchBtn = worldArticle.locator("[data-action='worldLaunch'], button:has-text('Launch')");
  175 |     await launchBtn.first().click();
  176 | 
  177 |     await page.waitForURL(/\/(join|game)/, { timeout: 60_000 });
  178 |     console.log("-> World launched.");
  179 |   }
  180 | 
  181 |   // ========== PHASE 5: Log in as Gamemaster ==========
  182 |   if (page.url().includes("/join")) {
  183 |     console.log("-> Joining as Gamemaster...");
  184 |     const gmOption = page.locator("[data-user-id]", { hasText: "Gamemaster" });
  185 |     if (await gmOption.isVisible({ timeout: 5000 }).catch(() => false)) {
  186 |       await gmOption.click();
  187 |     }
  188 |     await page.getByRole("button", { name: "Join Game Session" }).click();
  189 |     await page.waitForURL(/\/game/, { timeout: 60_000 });
  190 |   }
  191 | 
  192 |   await page.waitForTimeout(8000); // Let PF2e finish initializing
  193 |   console.log("-> Logged in as Gamemaster.");
  194 |   await dismissOverlays(page);
  195 | 
  196 |   // ========== PHASE 6: Enable Module ==========
  197 |   console.log("-> Enabling module...");
  198 |   const moduleEnabled = await page.evaluate(async (moduleId) => {
  199 |     // @ts-expect-error Foundry global
  200 |     const mod = game.modules.get(moduleId);
  201 |     if (!mod) return "not_found";
  202 |     if (mod.active) return "already_active";
  203 |     // @ts-expect-error Foundry global
  204 |     const config = game.settings.get("core", "moduleConfiguration") as Record<string, boolean>;
  205 |     config[moduleId] = true;
  206 |     // @ts-expect-error Foundry global
  207 |     await game.settings.set("core", "moduleConfiguration", config);
  208 |     return "activated";
  209 |   }, MODULE_ID);
  210 | 
```