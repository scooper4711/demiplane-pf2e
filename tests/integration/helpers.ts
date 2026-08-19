import type { Page } from "@playwright/test";

const PORT = process.env.FOUNDRY_PORT ?? "30000";
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";

export type UserRole = "Gamemaster" | "TestPlayer";

/**
 * Navigates to Foundry and logs in as the specified user.
 * Handles the /join page user selection and session join.
 */
export async function loginAs(page: Page, user: UserRole): Promise<void> {
  await page.goto(BASE_URL);

  // If redirected to /auth (admin gate), authenticate first
  if (page.url().includes("/auth")) {
    await page.getByRole("textbox", { name: "Administrator Password" }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Log In" }).click();
  }

  // Should be on /join now
  await page.waitForURL(/\/(join|game)/, { timeout: 15_000 });

  if (page.url().includes("/join")) {
    // Select the user
    const userOption = page.locator("[data-user-id]", { hasText: user });
    if (await userOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await userOption.click();
    }

    // Join the game (no password for either user)
    await page.getByRole("button", { name: "Join Game Session" }).click();
    await page.waitForURL(/\/game/, { timeout: 60_000 });
  }

  // Wait for PF2e to finish loading
  await page.waitForTimeout(5000);

  // Dismiss any post-login dialogs
  await page.evaluate(() => {
    document.querySelectorAll(".tour-overlay, .tour-center-step").forEach(el => el.remove());
    document.querySelectorAll("#notifications li").forEach(el => el.remove());
  });
}

/**
 * Logs in as Gamemaster. Convenience wrapper.
 */
export async function loginToFoundry(page: Page): Promise<void> {
  await loginAs(page, "Gamemaster");
}

/**
 * Resets the test world to a clean state by deleting all actors.
 * Must be called as Gamemaster (players can't delete others' actors).
 */
export async function resetTestWorld(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // @ts-expect-error Foundry global
    const actors = game.actors?.contents ?? [];
    for (const actor of actors) {
      await actor.delete();
    }
  });
}

/**
 * Creates a fresh PF2e character actor for testing.
 * Optionally assigns ownership to a specific user.
 */
export async function createTestActor(
  page: Page,
  name: string,
  ownerUserId?: string,
): Promise<string> {
  const actorId = await page.evaluate(
    async ({ actorName, ownerId }) => {
      const createData: Record<string, unknown> = {
        name: actorName,
        type: "character",
      };

      // If an owner is specified, grant them ownership
      if (ownerId) {
        createData.ownership = {
          default: 0,
          [ownerId]: 3, // OWNER permission
        };
      }

      // @ts-expect-error Foundry global
      const actor = await Actor.create(createData);
      return actor?.id ?? "";
    },
    { actorName: name, ownerId: ownerUserId },
  );

  if (!actorId) {
    throw new Error(`Failed to create test actor: ${name}`);
  }

  return actorId;
}

/**
 * Gets the user ID for a given user name.
 */
export async function getUserId(page: Page, userName: string): Promise<string> {
  const userId = await page.evaluate((name: string) => {
    // @ts-expect-error Foundry global
    const user = game.users.find((u: { name: string }) => u.name === name);
    return user?.id ?? "";
  }, userName);

  if (!userId) {
    throw new Error(`User not found: ${userName}`);
  }

  return userId;
}
