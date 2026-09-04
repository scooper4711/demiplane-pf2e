import { MODULE_ID } from "./import/types.js";
import type { SlugKind } from "./import/types.js";
import { getUnmappedSlugs } from "./sync-issues.js";
import { getAllMappings, setMapping, clearMapping } from "./slug-mapping.js";

const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/demiplane-mapping.hbs`;

interface SlugRow {
  slug: string;
  kind: SlugKind;
  /** Comma-separated names of the characters this slug affects. */
  characters: string;
  mappedName: string | null;
  /** True when the slug has no mapping yet — the filter keys off this. */
  unmapped: boolean;
  /** True when a mapping exists but its target is no longer resolvable. */
  mappingMissing: boolean;
  icon: string;
}

interface SlugSection {
  kind: SlugKind;
  label: string;
  rows: SlugRow[];
  /** True when the section has at least one unmapped row; hidden by the filter otherwise. */
  hasUnmapped: boolean;
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
 *
 * Typed as an ApplicationV2 constructor so it plugs directly into
 * `game.settings.registerMenu` without casts.
 */
type DemiplaneMappingAppConstructor = ConstructorOf<foundry.applications.api.ApplicationV2>;

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
    static override readonly DEFAULT_OPTIONS = {
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

    static override readonly PARTS = {
      list: {
        template: TEMPLATE_PATH,
        scrollable: [".mapping-scroll"],
      },
    };

    /**
     * The filter state persists for the life of the open window. It is
     * `undefined` until the first render, when it defaults to "on" if anything
     * is unmapped (else "off"); after that the user's toggle is preserved across
     * the re-renders that follow each drop or clear.
     */
    #onlyUnmapped: boolean | undefined = undefined;

    protected override async _prepareContext(_options: unknown): Promise<Record<string, unknown>> {
      const sections = await collectSections();
      const anyUnmapped = sections.some((section) => section.hasUnmapped);
      this.#onlyUnmapped ??= anyUnmapped;
      return {
        sections,
        hasRows: sections.some((section) => section.rows.length > 0),
        anyUnmapped,
        onlyUnmapped: this.#onlyUnmapped,
      };
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

      this.#attachFilterToggle(html);
    }

    /**
     * The filter is a pure show/hide, so it toggles a class on the list rather
     * than re-rendering — that keeps scroll position and avoids rebuilding every
     * row on each click. `_prepareContext` sets the initial checked state.
     */
    #attachFilterToggle(html: HTMLElement): void {
      const checkbox = html.querySelector<HTMLInputElement>(".only-unmapped-toggle");
      const list = html.querySelector<HTMLElement>(".mapping-scroll");
      if (!checkbox || !list) return;

      list.classList.toggle("only-unmapped", checkbox.checked);
      checkbox.addEventListener("change", () => {
        this.#onlyUnmapped = checkbox.checked;
        list.classList.toggle("only-unmapped", checkbox.checked);
      });
    }

    static async #onClickBrowse(_event: PointerEvent, button: HTMLElement): Promise<void> {
      await browseAction(button.dataset);
    }

    static async #onClickClear(_event: PointerEvent, button: HTMLElement): Promise<void> {
      await clearAction(button.dataset);
    }

    async #onDrop(event: DragEvent, row: HTMLElement): Promise<void> {
      event.preventDefault();
      row.classList.remove("drop-target");

      const kind = row.dataset.kind as SlugKind | undefined;
      const slug = row.dataset.slug;
      await dropOntoRow(kind, slug, event.dataTransfer);
    }
  }

  // eslint-disable-next-line no-restricted-syntax -- coercing the ApplicationV2 subclass to its settings-menu constructor shape; single site
  AppClass = DemiplaneMappingApp as unknown as DemiplaneMappingAppConstructor;
  return AppClass;
}

/**
 * Section-header "browse" action. Exported for tests (like `isAcceptedType`);
 * the ApplicationV2 action dispatcher holds the private wrapper above.
 */
export async function browseAction(dataset: { kind?: unknown }): Promise<void> {
  const kind = dataset.kind as SlugKind | undefined;
  if (!kind) return;
  await openFinder(kind);
}

/**
 * Row "clear mapping" action. Exported for tests; the dispatcher holds the
 * private wrapper above.
 */
export async function clearAction(dataset: { kind?: unknown; slug?: unknown }): Promise<void> {
  const kind = dataset.kind as SlugKind | undefined;
  const slug = typeof dataset.slug === "string" ? dataset.slug : undefined;
  if (!kind || !slug) return;
  await clearMapping(kind, slug);
  refresh();
}

/**
 * Drops a compendium item onto a mapping row. Exported for tests; the
 * dragover/drop listeners installed by `_attachPartListeners` delegate here.
 */
export async function dropOntoRow(
  kind: SlugKind | undefined,
  slug: string | undefined,
  dataTransfer: DataTransfer | null | undefined
): Promise<void> {
  if (!kind || !slug) return;

  const dropped = await getDroppedItem(dataTransfer);
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
      row = {
        slug,
        kind,
        characters: "",
        mappedName: null,
        unmapped: true,
        mappingMissing: false,
        icon: UNKNOWN_ITEM_ICON,
      };
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
  // target has since disappeared. Collect the rows first, then resolve their
  // targets in one batched pass (see `applyMappingTargets`) rather than a
  // `fromUuid` per mapping — that keeps a large store fast to open.
  const mappedRows: Array<{ row: SlugRow; uuid: string }> = [];
  for (const kind of KIND_ORDER) {
    for (const [slug, mapping] of Object.entries(getAllMappings(kind))) {
      const row = ensure(kind, slug);
      row.mappedName = mapping.name;
      row.unmapped = false;
      mappedRows.push({ row, uuid: mapping.uuid });
    }
  }
  await applyMappingTargets(mappedRows);

  return KIND_ORDER.map((kind) => {
    const rows = [...rowsByKind.get(kind)!.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      kind,
      label: KIND_LABELS[kind],
      rows,
      hasUnmapped: rows.some((row) => row.unmapped),
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

interface MappedRowTarget {
  row: SlugRow;
  uuid: string;
}

/**
 * Resolves every mapped row's icon and existence in one batched pass. Mappings
 * point at compendium items, so instead of loading each item in full via
 * `fromUuid` (hundreds of document deserializations on open), the targets are
 * grouped by pack and each pack's cached index is read once. The index carries
 * `img` and tells us whether the id still exists — the only two fields a row
 * needs. Non-compendium UUIDs (rare) fall back to a direct `fromUuid`.
 */
async function applyMappingTargets(targets: MappedRowTarget[]): Promise<void> {
  const byPack = new Map<string, MappedRowTarget[]>();
  const fallback: MappedRowTarget[] = [];

  for (const target of targets) {
    const parsed = parseCompendiumUuid(target.uuid);
    if (parsed) {
      const group = byPack.get(parsed.packKey) ?? [];
      group.push(target);
      byPack.set(parsed.packKey, group);
    } else {
      fallback.push(target);
    }
  }

  await Promise.all([
    ...[...byPack.entries()].map(([packKey, group]) => applyPackTargets(packKey, group)),
    ...fallback.map((target) => applyTargetViaDocument(target)),
  ]);
}

/** Parses a compendium item UUID into its pack key and document id, or null. */
function parseCompendiumUuid(uuid: string): { packKey: string; id: string } | null {
  const parts = uuid.split(".");
  // Compendium.<scope>.<pack>.<DocType>.<id>
  if (parts.length < 5 || parts[0] !== "Compendium") return null;
  const scope = parts[1];
  const pack = parts[2];
  const id = parts[4];
  if (!scope || !pack || !id) return null;
  return { packKey: `${scope}.${pack}`, id };
}

/** Resolves a whole pack's worth of rows from that pack's index in one read. */
async function applyPackTargets(packKey: string, group: MappedRowTarget[]): Promise<void> {
  const pack = game.packs.get(packKey);
  if (!pack) {
    for (const { row } of group) markTargetMissing(row);
    return;
  }

  // `getIndex` returns a Collection of index entries; `img` is requested
  // explicitly above so every entry carries it.
  const index = await pack.getIndex({ fields: ["img"] });
  const byId = new Map(index.map((entry) => [entry._id, entry] as const));

  for (const { row, uuid } of group) {
    const id = parseCompendiumUuid(uuid)!.id;
    const entry = byId.get(id);
    if (entry) applyTargetIcon(row, entry.img);
    else markTargetMissing(row);
  }
}

/** Fallback for a non-compendium UUID: one direct document load. */
async function applyTargetViaDocument(target: MappedRowTarget): Promise<void> {
  const doc = await fromUuid(target.uuid);
  if (!doc) {
    markTargetMissing(target.row);
    return;
  }
  const img = "img" in doc && typeof doc.img === "string" ? doc.img : undefined;
  applyTargetIcon(target.row, img);
}

function applyTargetIcon(row: SlugRow, img: string | undefined): void {
  row.mappingMissing = false;
  row.icon = typeof img === "string" && img ? img : UNKNOWN_ITEM_ICON;
}

function markTargetMissing(row: SlugRow): void {
  row.mappingMissing = true;
  row.icon = UNKNOWN_ITEM_ICON;
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
    // eslint-disable-next-line no-restricted-syntax -- PF2e Compendium Browser has a rich, UI-specific shape used only here
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

  ui.notifications.warn(`No compendium source found for ${KIND_LABELS[kind]} items.`);
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

async function getDroppedItem(dataTransfer: DataTransfer | null | undefined): Promise<DroppedItem | null> {
  const raw = dataTransfer?.getData("text/plain");
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
    content: `<p>“${slug}” is a <strong>${KIND_LABELS[kind]}</strong>, but you dropped
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

/** Prefix shared by every per-kind mapping setting key (`slugMappingsFeat`, …). */
const MAPPING_SETTING_PREFIX = `${MODULE_ID}.slugMappings`;

/**
 * Keeps an open mapping editor current when the mappings change on *another*
 * client. `setMapping`/`clearMapping` write a world setting, which Foundry
 * replicates and announces via `updateSetting` on every client; the local
 * client already refreshes inline, but a second GM's editor would otherwise
 * show stale data until reopened.
 */
export function registerMappingSyncHook(): void {
  Hooks.on("updateSetting", ((setting: { key?: string }) => {
    if (setting.key?.startsWith(MAPPING_SETTING_PREFIX)) refresh();
  }) as (...args: unknown[]) => void);
}

export function registerDemiplaneMappingTemplates(): void {
  foundry.applications.handlebars.loadTemplates([TEMPLATE_PATH]);
}

export type { SlugRow, SlugSection };
export { collectSections, EXPECTED_TYPES, KIND_LABELS, openFinder };
