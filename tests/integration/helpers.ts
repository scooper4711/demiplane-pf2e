import type { Page } from "@playwright/test";

const PORT = process.env.FOUNDRY_PORT ?? "30000";
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Navigates to Foundry and handles initial setup/login if needed.
 */
export async function loginToFoundry(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  // Handle any initial setup screens or admin login
  // This will vary based on Foundry state
}

/**
 * Resets the test world to a clean state by deleting all actors.
 * Call between tests to prevent state leakage.
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
 */
export async function createTestActor(
  page: Page,
  name: string,
): Promise<string> {
  const actorId = await page.evaluate(async (actorName: string) => {
    // @ts-expect-error Foundry global
    const actor = await Actor.create({
      name: actorName,
      type: "character",
    });
    return actor?.id ?? "";
  }, name);

  if (!actorId) {
    throw new Error(`Failed to create test actor: ${name}`);
  }

  return actorId;
}
