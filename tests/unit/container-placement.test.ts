import { describe, it, expect, vi } from "vitest";
import { createContainersFirst, type PlaceablePendingItem } from "../../src/import/container-placement.js";

/** A minimal actor whose createEmbeddedDocuments assigns sequential ids. */
function mockActor() {
  let counter = 0;
  return {
    createEmbeddedDocuments: vi.fn(async (_type: string, data: Array<Record<string, unknown>>) =>
      data.map((d) => ({ ...d, id: `foundry-${counter++}` }))
    ),
  };
}

function pendingItem(type: string, demiplaneId: string): PlaceablePendingItem {
  return { data: { type, system: {} }, demiplaneId };
}

describe("createContainersFirst", () => {
  it("returns 0 and creates nothing when there are no containers", async () => {
    const actor = mockActor();
    const items = [pendingItem("weapon", "sword")];

    const count = await createContainersFirst(actor as never, items, new Map());

    expect(count).toBe(0);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(items).toHaveLength(1); // nothing spliced out
  });

  it("creates containers first and places stowed items into the correct one", async () => {
    const actor = mockActor();
    const leftPouch = pendingItem("backpack", "eng-left");
    const rightPouch = pendingItem("backpack", "eng-right");
    const sword = pendingItem("weapon", "eng-sword");
    const items = [sword, leftPouch, rightPouch];
    // sword is stowed in the right pouch.
    const containerMap = new Map([["eng-sword", "eng-right"]]);

    const count = await createContainersFirst(actor as never, items, containerMap);

    expect(count).toBe(2);
    // Containers spliced out; only the sword remains for the caller to create.
    expect(items).toEqual([sword]);
    // The right pouch was created second → foundry-1.
    expect((sword.data.system as { containerId?: string }).containerId).toBe("foundry-1");
  });

  it("leaves a top-level item (no container mapping) unplaced", async () => {
    const actor = mockActor();
    const pouch = pendingItem("backpack", "eng-pouch");
    const looseItem = pendingItem("weapon", "eng-loose");
    const items = [looseItem, pouch];

    await createContainersFirst(actor as never, items, new Map());

    expect((looseItem.data.system as { containerId?: string }).containerId).toBeUndefined();
  });

  it("skips placement when the mapped container was not among the created containers", async () => {
    const actor = mockActor();
    const pouch = pendingItem("backpack", "eng-pouch");
    const sword = pendingItem("weapon", "eng-sword");
    const items = [sword, pouch];
    // sword maps to a container engine id that isn't one of the created containers.
    const containerMap = new Map([["eng-sword", "eng-missing"]]);

    await createContainersFirst(actor as never, items, containerMap);

    expect((sword.data.system as { containerId?: string }).containerId).toBeUndefined();
  });
});
