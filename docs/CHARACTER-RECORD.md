# CharacterRecord — import staging format (draft)

Status: planning. Collaborating here before any code.

## Goal

Split the import into two steps so a Demiplane API change touches one place:

- **Phase A — Adapters** (Demiplane-facing, versioned: `api-v1/`, `api-v2/`, …).
  All network I/O happens here, up front. Output is a single versioned,
  plain-data `CharacterRecord`. No Foundry imports, no compendium lookups,
  no mapping decisions.
- **Phase B — Mapping** (Foundry-facing, API-agnostic). The importers consume
  only `CharacterRecord`. They keep the hard logic (slot resolution, grant
  chasing, choice matching) but never see an engine ID, a `sourceRow`, or a
  modifier blob.

Rules:

- Slugs are Demiplane identities verbatim (including `-rm`), normalized nowhere
  except the adapter.
- Optional fields mean "the API didn't say". Phase B must handle absence
  explicitly (table lookup, documented assumption, or the unknown-source
  error) — never read an empty string as data.
- Empty arrays are explicit: a fighter has `"spellcasting": []` so it can
  never trip the unknown-source error.
- Nothing in Phase B may issue its own Demiplane POST. A new fact needed
  downstream goes on the record.

## Schema sketch

```ts
interface CharacterRecord {
  recordVersion: number;
  sourceCharacterId: string;
  identity: { name: string; level: number };
  ancestry: Ancestry;
  background: NamedNode;
  class: ClassNode;
  abilities: { boosts: string[] }; // source order: ancestry, background, key, levels
  skills: TrainedSkill[]; // { slug, source, attribute? }
  feats: Feat[];
  spellcasting: SpellcastingBlock[];
  formulas: string[]; // normalized base slugs
  equipment: OwnedItem[];
  currency: { pp: number; gp: number; sp: number; cp: number };
  languages: string[];
  journals: { title: string; body: string }[];
  unresolved: UnresolvedChoice[];
}

interface Feature {
  id: string;
  slug: string;
  name: string;
  sourceRow: string;
  grantedBy?: string; // usually the class
  grants?: string[];
}

/** Ancestry, heritage, background, class: all granters, so all nodes.
 * The class offers level slots (hence most feats/skills trace to it);
 * heritage offers its choice (Skilled Human → a skill); ancestry offers
 * ancestry-feat slots; backgrounds offer their feat/lore-ish picks. */
interface Ancestry {
  id: string;
  slug: string;
  heritage?: Heritage;
  grants?: string[];
}

interface Heritage {
  id: string;
  slug: string;
  grantedBy?: string; // the ancestry
  grants?: string[];
}

/** Backgrounds and classes share the shape: a named node with grant edges. */
interface NamedNode {
  id: string;
  slug: string;
  grants?: string[];
}

interface ClassNode extends NamedNode {
  keyAttribute: string;
  features: Feature[];
}

interface TrainedSkill {
  id: string;
  slug: string;
  /** Id of the node that offered the slot (class, heritage, a feat like
   * Gnome Obsession). Absent means player-created with no granter
   * (a free custom skill). Replaces the old Demiplane-row `source` — the
   * row's level info now lives in `ranks`, the rest was adapter receipt. */
  grantedBy?: string;
  attribute?: string; // custom/lore skills only
  /** Rank progression in order. The adapter folds the increase sequence
   * (trained → expert → …) so Phase B never counts increases itself.
   * Current rank is the last entry. */
  ranks: { level: number; rank: "trained" | "expert" | "master" | "legendary" }[];
}

interface Feat {
  /** Record-local unique id (`feat-1`, …), assigned by the adapter in stable
   * order. Deliberately not the Demiplane engine UUID — `api-v2/` may have
   * no such thing. Edges reference ids; slug/level/category live here once. */
  id: string;
  slug: string;
  /** Character level the feat was taken at, from its sourceRow
   * (e.g. "fighter-feat-level-2-rm" → 2). An ancestry feat taken with a
   * class slot still records the character level, not the feat's own level —
   * the compendium knows the latter, only the sheet knows the former. */
  level: number;
  category: "ancestry" | "class" | "skill" | "general";
  /** Id of the granter. Enough on its own — name/level are one lookup away,
   * so no need to denormalize them onto the edge. */
  grantedBy?: string;
  /** Ids of grantees (forward edge). Mirrors `grantedBy`; edges are cheap,
   * data is not duplicated. Invariant: every id here has a matching
   * `grantedBy` back, and vice versa. */
  grants?: string[];
}

/** A choice the player hasn't made (or Demiplane didn't export the pick for).
 * The pending grant lives on the granter's side — `grantedBy` alone cannot
 * represent a choice with no grantee yet, which is where the forward edge
 * earns its keep. ChoiceSet resolution walks granter → grantees, not the
 * other way around. */
interface UnresolvedChoice {
  grantedBy: string; // feat/feature id offering the choice
  kind: "feat" | "spell" | "skill" | "lore";
  level: number;
  category?: string; // e.g. which feat list the pick comes from
}

interface SpellcastingBlock {
  kind: "repertoire" | "focus" | "innate" | "font" | "ritual";
  source: string; // stable feature key, e.g. "sorcerer-spellcasting"
  /** Id of the granter when something on the record offered it
   * (a dedication feat, a heritage). Absent for base-class spellcasting. */
  grantedBy?: string;
  tradition?: string; // present only when the API states it
  ability?: string; // present only when the API states it
  preparedType?: "spontaneous" | "prepared"; // from isPrepare / signature signals
  slots: Record<number, number>;
  spells: { slug: string; rank: number; prepared?: boolean; signature?: boolean }[];
}

interface OwnedItem {
  slug: string;
  quantity?: number;
  equipped?: "primary-hand" | "off-hand" | "worn";
  runes?: { potency?: number; striking?: number };
  attachments?: string[]; // e.g. shield boss on its shield
  container?: true;
  /** Only on containers. Top-level entries are carried loose. */
  contents?: OwnedItem[];
}
```

## Sample: Valeros (`a5884413-…`, level 5 human fighter)

```json
{
  "recordVersion": 1,
  "sourceCharacterId": "a5884413-857f-444c-a5d6-24d819632c8a",
  "identity": { "name": "FVTT Valeros", "level": 5 },
  "ancestry": {
    "id": "anc-1",
    "slug": "human-rm",
    "heritage": { "id": "her-1", "slug": "skilled-human-rm", "grantedBy": "anc-1", "grants": ["skill-6"] },
    "grants": ["feat-1", "feat-9"]
  },
  "background": { "id": "bg-1", "slug": "farmhand-rm", "grants": ["skill-8"] },
  "class": {
    "id": "cls-1",
    "slug": "fighter-rm",
    "keyAttribute": "strength",
    "features": [
      {
        "id": "ffeat-1",
        "slug": "weapon-master-sword",
        "name": "Sword",
        "sourceRow": "fighter-weapon-mastery-rm",
        "grantedBy": "cls-1"
      }
    ],
    "grants": [
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
      "skill-7",
      "feat-3",
      "feat-4",
      "feat-5",
      "feat-6",
      "feat-7",
      "feat-8",
      "ffeat-1"
    ]
  },
  "abilities": {
    "boosts": [
      "strength",
      "dexterity",
      "strength",
      "constitution",
      "strength",
      "strength",
      "dexterity",
      "constitution",
      "intelligence",
      "constitution",
      "wisdom",
      "charisma",
      "strength"
    ]
  },
  "skills": [
    { "id": "skill-1", "slug": "crafting", "grantedBy": "cls-1", "ranks": [{ "level": 1, "rank": "trained" }] },
    { "id": "skill-2", "slug": "diplomacy", "grantedBy": "cls-1", "ranks": [{ "level": 1, "rank": "trained" }] },
    {
      "id": "skill-3",
      "slug": "intimidation",
      "grantedBy": "cls-1",
      "ranks": [
        { "level": 1, "rank": "trained" },
        { "level": 5, "rank": "expert" }
      ]
    },
    { "id": "skill-4", "slug": "occultism", "grantedBy": "cls-1", "ranks": [{ "level": 1, "rank": "trained" }] },
    { "id": "skill-5", "slug": "survival", "grantedBy": "cls-1", "ranks": [{ "level": 1, "rank": "trained" }] },
    { "id": "skill-6", "slug": "acrobatics", "grantedBy": "her-1", "ranks": [{ "level": 1, "rank": "trained" }] },
    { "id": "skill-7", "slug": "athletics", "grantedBy": "cls-1", "ranks": [{ "level": 3, "rank": "trained" }] },
    {
      "id": "skill-8",
      "slug": "warfare-lore",
      "grantedBy": "bg-1",
      "attribute": "intelligence",
      "ranks": [{ "level": 1, "rank": "trained" }]
    }
  ],
  "feats": [
    {
      "id": "feat-1",
      "slug": "natural-ambition-rm",
      "level": 1,
      "category": "ancestry",
      "grantedBy": "anc-1",
      "grants": ["feat-2"]
    },
    { "id": "feat-2", "slug": "reactive-shield-rm", "level": 1, "category": "class", "grantedBy": "feat-1" },
    { "id": "feat-3", "slug": "double-slice-rm", "level": 1, "category": "class", "grantedBy": "cls-1" },
    { "id": "feat-4", "slug": "aggressive-block-rm", "level": 2, "category": "class", "grantedBy": "cls-1" },
    { "id": "feat-5", "slug": "combat-climber-rm", "level": 2, "category": "skill", "grantedBy": "cls-1" },
    { "id": "feat-6", "slug": "toughness-rm", "level": 3, "category": "general", "grantedBy": "cls-1" },
    { "id": "feat-7", "slug": "powerful-leap-rm", "level": 4, "category": "skill", "grantedBy": "cls-1" },
    { "id": "feat-8", "slug": "powerful-shove-rm", "level": 4, "category": "class", "grantedBy": "cls-1" },
    { "id": "feat-9", "slug": "haughty-obstinacy-rm", "level": 5, "category": "ancestry", "grantedBy": "anc-1" }
  ],
  "spellcasting": [],
  "formulas": [],
  "equipment": [
    {
      "slug": "backpack-rm",
      "container": true,
      "contents": [
        { "slug": "bedroll-rm" },
        { "slug": "chalk-rm" },
        { "slug": "flint-and-steel-rm" },
        { "slug": "rations-1-week-rm", "quantity": 2 },
        { "slug": "rope-50-feet-rm" },
        { "slug": "soap-rm" },
        { "slug": "torch-rm", "quantity": 5 },
        { "slug": "waterskin-rm" },
        { "slug": "grappling-hook-rm" },
        { "slug": "repair-toolkit-basic-rm" }
      ]
    },
    { "slug": "longsword-rm", "equipped": "primary-hand", "runes": { "potency": 1, "striking": 1 } },
    { "slug": "shortbow-rm" },
    { "slug": "arrow-rm", "quantity": 20 },
    { "slug": "steel-shield-rm", "equipped": "off-hand", "attachments": ["shield-boss-rm"] },
    { "slug": "half-plate-rm", "equipped": "worn" },
    { "slug": "healing-potion-lesser-rm" },
    { "slug": "doubling-rings-basic-rm", "equipped": "worn" },
    { "slug": "pendant-of-the-occult-basic-rm", "equipped": "worn" },
    { "slug": "mug-rm" }
  ],
  "currency": { "pp": 1, "gp": 32, "sp": 2, "cp": 3 },
  "languages": ["goblin", "kelish"],
  "journals": [],
  "unresolved": []
}
```

Adapter notes (mechanical, no judgment):

- Feat `level` is the character level from `sourceRow`; `category` likewise.
- Every node has an id; every slot traces to its granter. The class offers
  level slots (most feats/skills → `cls-1`), the ancestry offers ancestry
  slots (`feat-1`, `feat-9` → `anc-1`), the heritage offers its choice
  (`skill-6` → `her-1`), the background its lore (`skill-8` → `bg-1`), and
  Natural Ambition its class feat (`feat-2` → `feat-1`, mirrored in
  `grants`). Skill `source` rows are gone — their level info lives in
  `ranks`, the rest was adapter receipt.
- Equipment assembly collapses `--quantity`, `--container`, hand/`is-equipped`,
  `-potency-rune`/`-striking-rune`, and `isAttachment` + `parentItemID`
  overrides. The declined scale-mail kit option (`--is-selected: 0`) is dropped.
- Left out deliberately: avatar URL, biography, gender, catchphrases —
  presentation facts nothing computes from.

## Open questions

1. Should the adapter confirm compendium identity (e.g. `acid-flask-lesser`
   exists), or stay purely Demiplane-side? (Lean: pure.)
2. `recordVersion` on the record so golden fixtures don't silently rot?
3. Can the v1 adapter keep today's ~12-trip shape initially (behavior first,
   batching later)?
4. Where do manual sheet overrides (e.g. a hand-set proficiency) live on the
   record?
