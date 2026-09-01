import { MODULE_ID } from "./import/types.js";
import type { SlugKind } from "./import/types.js";
import { getUnmappedSlugs } from "./sync-issues.js";
import { getAllMappings, setMapping, clearMapping, isMappingResolvable } from "./slug-mapping.js";
import type { SlugMapping } from "./slug-mapping.js";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/demiplane-mapping.hbs`;

interface SlugRow {
  slug: string;
  kind: SlugKind;
  /** Comma-separated names of the characters this slug affects. */
  characters: string;
  mappedName: string | null;
  /** True when a mapping exists but its target is no longer resolvable. */
  mappingMissing: boolean;
  icon: string;
}

interface SlugSection {
  kind: SlugKind;
  label: string;
  rows: SlugRow[];
  /** False when there is no way to open a browser for this kind. */
  canBrowse: boolean;
}

/** PF2e's own placeholder icon, used for a row with no mapping yet. */
const UNKNOWN_ITEM_ICON = "systems/pf2e/icons/actions/craft/unknown-item.webp";

const KIND_LABELS: Record<SlugKind, string> = {
  ancestry: "Ancestry",
  heritage: "Heritage",
  background: "Background",
  class: "Class",
  feat: "Feat",
  equipment: "Equipment",
  spell: "Spell",
};

const KIND_ORDER: readonly SlugKind[] = ["equipment", "feat", "spell", "ancestry", "heritage", "background", "class"];

/** Kinds the PF2e Compendium Browser has a tab for. */
const KIND_TABS: Partial<Record<SlugKind, "equipment" | "feat" | "spell">> = {
  equipment: "equipment",
  feat: "feat",
  spell: "spell",
};

/**
 * Ancestry, heritage, background and class have no Compendium Browser tab, so
 * those sections open the individual compendium pack window instead (see
 * `openCompendiumPack`).
 */
const KIND_PACKS: Partial<Record<SlugKind, string>> = {
  ancestry: "pf2e.ancestries",
  heritage: "pf2e.heritages",
  background: "pf2e.backgrounds",
  class: "pf2e.classes",
};

/** Item types accepted for each kind, used to reject a mismatched drop. */
const EXPECTED_TYPES: Record<SlugKind, string[]> = {
  equipment: ["weapon", "armor", "equipment", "consumable", "treasure", "backpack", "shield"],
  feat: ["feat"],
  spell: ["spell"],
  ancestry: ["ancestry"],
  heritage: ["heritage"],
  background: ["background"],
  class: ["class"],
};

/** Whether an item of `itemType` may be mapped onto a slug of `kind`. */
export function isAcceptedType(kind: SlugKind, itemType: string): boolean {
  return EXPECTED_TYPES[kind].includes(itemType);
}

/**
 * The app class is built on first use rather than at import time: extending a
 * Foundry global requires that global to exist, and this module is imported
 * during setup when it may not yet be available.
 */
type DemiplaneMappingAppConstructor = new () => { render: (options?: { force?: boolean }) => Promise<unknown> };

let AppClass: DemiplaneMappingAppConstructor | undefined;

export function getDemiplaneMappingAppClass(): DemiplaneMappingAppConstructor {
  if (AppClass) return AppClass;
  AppClass = buildDemiplaneMappingAppClass();
  return AppClass;
}

// eslint-disable-next-line max-lines-per-function -- flat class-body declaration: low cognitive load, kept here so the memoizing factory stays single-purpose
function buildDemiplaneMappingAppClass(): DemiplaneMappingAppConstructor {
  const base = foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);

  class DemiplaneMappingApp extends base {
    static override DEFAULT_OPTIONS = {
      id: "demiplane-mapping",
      // `crb-style sheet` picks up PF2e's parchment background; `themed
      // theme-light` matches the actor window, which keeps the parchment look
      // regardless of the Foundry theme.
      classes: ["pf2e", "crb-style", "sheet", "themed", "theme-light"],
      window: {
        title: "Demiplane Mapping",
        contentClasses: ["standard-form"],
        icon: "fa-solid fa-link",
      },
      position: { width: 760, height: 620 },
      actions: {
        browse: DemiplaneMappingApp.#onClickBrowse,
        clear: DemiplaneMappingApp.#onClickClear,
      },
    };

    static override PARTS = {
      list: {
        template: TEMPLATE_PATH,
        scrollable: [".demiplane-mapping"],
      },
    };

    protected override async _prepareContext(_options: unknown): Promise<Record<string, unknown>> {
      const sections = await collectSections();
      return { sections, hasRows: sections.some((s) => s.rows.length > 0) };
    }

    protected override _attachPartListeners(_partId: string, html: HTMLElement, _options: unknown): void {
      for (const row of Array.from(html.querySelectorAll<HTMLElement>(".mapping-row"))) {
        row.addEventListener("dragover", (event: DragEvent) => {
          event.preventDefault();
          row.classList.add("drop-target");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
        row.addEventListener("drop", (event: DragEvent) => void this.#onDrop(event, row));
      }
    }

    static async #onClickBrowse(_event: PointerEvent, button: HTMLElement): Promise<void> {
      const kind = button.dataset.kind as SlugKind | undefined;
      if (!kind) return;
      await openFinder(kind);
    }

    static async #onClickClear(_event: PointerEvent, button: HTMLElement): Promise<void> {
      const { kind, slug } = button.dataset as { kind?: SlugKind; slug?: string };
      if (!kind || !slug) return;
      await clearMapping(kind, slug);
      refresh();
    }

    async #onDrop(event: DragEvent, row: HTMLElement): Promise<void> {
      event.preventDefault();
      row.classList.remove("drop-target");

      const kind = row.dataset.kind as SlugKind | undefined;
      const slug = row.dataset.slug;
      if (!kind || !slug) return;

      const dropped = await getDroppedItem(event);
      if (!dropped) {
        ui.notifications.warn("Drop a compendium item onto the row to map it.");
        return;
      }

      if (!isAcceptedType(kind, dropped.type)) {
        await showMismatchDialog(slug, kind, dropped.name, dropped.type);
        return;
      }

      await setMapping(kind, slug, { uuid: dropped.uuid, name: dropped.name });
      refresh();
    }
  }

  AppClass = DemiplaneMappingApp as unknown as DemiplaneMappingAppConstructor;
  return AppClass;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/**
 * Builds the sections by scanning every linked actor. Deriving the list rather
 * than keeping a world registry means it self-corrects: once a slug resolves it
 * stops being reported, with no pruning.
 */
async function collectSections(): Promise<SlugSection[]> {
  const rowsByKind = new Map<SlugKind, Map<string, SlugRow>>();

  for (const kind of KIND_ORDER) rowsByKind.set(kind, new Map());
  const ensure = (kind: SlugKind, slug: string): SlugRow => {
    const bySlug = rowsByKind.get(kind)!;
    let row = bySlug.get(slug);
    if (!row) {
      row = { slug, kind, characters: "", mappedName: null, mappingMissing: false, icon: UNKNOWN_ITEM_ICON };
      bySlug.set(slug, row);
    }
    return row;
  };

  for (const actor of game.actors.contents) {
    if (!actor.getFlag(MODULE_ID, "characterId")) continue;

    for (const record of getUnmappedSlugs(actor)) {
      const row = ensure(record.kind, record.slug);
      row.characters = appendCharacter(row.characters, actor.name ?? "Unknown");
    }
  }

  // Include existing mappings so a GM can see and fix them, including ones whose
  // target has since disappeared.
  for (const kind of KIND_ORDER) {
    for (const [slug, mapping] of Object.entries(getAllMappings(kind))) {
      const row = ensure(kind, slug);
      row.mappedName = mapping.name;
      row.mappingMissing = !(await isMappingResolvable(mapping));
      row.icon = await iconFor(mapping);
    }
  }

  return KIND_ORDER.map((kind) => {
    const rows = [...rowsByKind.get(kind)!.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      kind,
      label: KIND_LABELS[kind],
      rows,
      canBrowse: kind in KIND_TABS || (KIND_PACKS[kind] !== undefined && game.packs.get(KIND_PACKS[kind]!) != null),
    };
  }).filter((section) => section.rows.length > 0);
}

function appendCharacter(existing: string, name: string): string {
  if (!existing) return name;
  const names = new Set(existing.split(", "));
  names.add(name);
  return [...names].join(", ");
}

async function iconFor(mapping: SlugMapping): Promise<string> {
  const doc = await fromUuid(mapping.uuid);
  const img = (doc as { img?: string } | null)?.img;
  return typeof img === "string" && img ? img : UNKNOWN_ITEM_ICON;
}

// ─── Compendium browser ─────────────────────────────────────────────────────

/**
 * Opens a place to find items of the given kind. Deliberately one call per
 * section: the GM leaves it open and drags from it repeatedly.
 */
async function openFinder(kind: SlugKind): Promise<void> {
  const tabName = KIND_TABS[kind];
  if (tabName) {
    // game.pf2e is only assigned on ready, and only exists with the PF2e system.
    const browser = (game as unknown as { pf2e?: { compendiumBrowser?: BrowserLike } }).pf2e?.compendiumBrowser;
    const tab = browser?.tabs?.[tabName];
    if (!tab) {
      ui.notifications.warn("The PF2e Compendium Browser is not available.");
      return;
    }
    // getFilterData initializes the tab and returns pristine defaults to mutate.
    const filter = await tab.getFilterData();
    await tab.open({ filter });
    return;
  }

  const packKey = KIND_PACKS[kind];
  const pack = packKey ? game.packs.get(packKey) : undefined;
  if (pack) {
    openCompendiumPack(pack);
    return;
  }

  ui.notifications.warn(`No compendium source found for ${KIND_LABELS[kind]} slugs.`);
}

/**
 * Opens a single compendium pack's own window. Mirrors what the sidebar does on
 * click: instantiate the pack's `applicationClass` and render it. `pack.render`
 * only re-renders windows already in `pack.apps`, so it silently does nothing
 * when the pack has never been opened — hence the explicit instantiation.
 *
 * Typed through a minimal local shape because the pack's `applicationClass` is a
 * v1/v2 union with abstract constructors that isn't directly newable.
 */
function openCompendiumPack(pack: unknown): void {
  const { applicationClass } = pack as CompendiumPack;
  new applicationClass({ collection: pack }).render({ force: true });
}

interface CompendiumPack {
  applicationClass: new (options: { collection: unknown }) => {
    render: (options: { force: boolean }) => unknown;
  };
}

interface BrowserLike {
  tabs: Record<
    string,
    { getFilterData: () => Promise<unknown>; open: (options: { filter: unknown }) => Promise<void> }
  >;
}

// ─── Drop handling ──────────────────────────────────────────────────────────

interface DroppedItem {
  name: string;
  uuid: string;
  type: string;
}

async function getDroppedItem(event: DragEvent): Promise<DroppedItem | null> {
  const raw = event.dataTransfer?.getData("text/plain");
  if (!raw) return null;

  let parsed: { type?: unknown; uuid?: unknown };
  try {
    parsed = JSON.parse(raw) as { type?: unknown; uuid?: unknown };
  } catch {
    return null;
  }

  if (parsed.type !== "Item" || typeof parsed.uuid !== "string") return null;

  const doc = await fromUuid(parsed.uuid);
  if (!doc) return null;

  return {
    name: (doc as { name?: string }).name ?? "Unknown",
    uuid: parsed.uuid,
    type: (doc as { type?: string }).type ?? "",
  };
}

async function showMismatchDialog(
  slug: string,
  kind: SlugKind,
  droppedName: string,
  droppedType: string
): Promise<void> {
  await foundry.applications.api.DialogV2.prompt({
    window: { title: "That item doesn't match" },
    content: `<p>“${slug}” is a <strong>${KIND_LABELS[kind]}</strong> slug, but you dropped
      <strong>${droppedName}</strong>, which is a <strong>${droppedType}</strong>.</p>
      <p>Map it in the ${KIND_LABELS[kind]} section instead, or pick a different item.</p>`,
    ok: { label: "Close" },
  });
}

/** Re-render any open instance so a change is visible immediately. */
function refresh(): void {
  const app = foundry.applications.instances.get("demiplane-mapping") as
    { render: (options?: { force?: boolean }) => Promise<unknown> } | undefined;
  void app?.render({ force: true });
}

export function registerDemiplaneMappingTemplates(): void {
  foundry.applications.handlebars.loadTemplates([TEMPLATE_PATH]);
}

export type { SlugRow, SlugSection };
export { collectSections, EXPECTED_TYPES, KIND_LABELS, openFinder };
