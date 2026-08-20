# Demiplane <-> Foundry VTT Two-Way Sync: Technical Research

## Project Concept

A Foundry VTT module that provides two-way sync with Demiplane's Nexus character tools:
- **Demiplane -> Foundry (Source of Truth):** Character building (class, ancestry, feats, spells, skills, attributes, etc.)
- **Foundry -> Demiplane (Session State):** Consumables, inventory counts, currency, HP, spell slots used, hero points — things that change during play

## System Investigated: Pathfinder 2e

Character UUID example: `200a5cf1-3fe9-4302-94a0-6988d2a73e99`

---

## Demiplane API Architecture

### Authentication Flow

1. `GET https://app.demiplane.com/api/auth/token` — returns a session token
2. `POST https://app.demiplane.com/api/generate-graphql-token` — exchanges session token for a GraphQL bearer token
3. All subsequent GraphQL requests go to `https://apiv4.demiplane.com/v1/graphql` with the bearer token

### GraphQL Endpoint

**URL:** `POST https://apiv4.demiplane.com/v1/graphql`

Key operations discovered:

- `query character_version($id: uuid!)` — fetches character UUID and version number
- `mutation updateCharacterV2($id, $data, $name, $level, ...)` — **the big one**: sends/receives the full character state
- `query getCharacterAttributeMapping($nexusId: Int!)` — returns the mapping between display attributes and internal store names

### Character Engine Stream

**URL:** `POST https://character.demiplane.com/stream-engines`

Request payload includes:
```json
{
  "isSheet": true,
  "nexusSlug": "pathfinder2e",
  "sourceNexuses": ["common", "shared", "pathfinder2e-v2", "pathfinder2e"],
  "versionMap": {
    "common": "0.8230.2",
    "shared": "0.38413.2",
    "pathfinder2e-v2": "0.2333434.1",
    "pathfinder2e": "0.617.0"
  }
}
```

This appears to be a versioned engine system that streams the character calculation rules.

---

## Character Data Structure

The character is stored as a JSON blob with an `engines` array. Each entry represents a single character choice or value:

### Engine Entry Types

1. **DemiplaneEngine** — References a game rule engine file (ancestry, class, feat, spell, item, etc.)
2. **CustomDemiplaneEngine** — User-set values (name, level, HP, currency, prepared spells, etc.)

### Engine Entry Format

```json
{
  "id": "unique-id",
  "demiplaneEngineId": "uuid-of-the-engine-definition",
  "name": "tabula/spell/fireball-rm.eng",
  "type": "DemiplaneEngine",
  "saveType": "CharacterSheet",
  "args": {
    "builderSection": "spells",
    "id": "selection-uuid",
    "name": "Fireball",
    "parentEngine": "parent-uuid",
    "parentSpellFeature": "wizard-spellcasting-rm",
    "selectionRank": 3,
    "slug": "fireball-rm",
    "sourceRow": "builder-spell-section--wizard-spellcasting-rm--3",
    "spellSlot": "rank-3-wizard-school-spellbook-slot"
  }
}
```

### CustomDemiplaneEngine Format (Writable Values)

```json
{
  "id": "custom_character_hit-points_current",
  "name": "character_hit-points_current",
  "value": 53,
  "type": "CustomDemiplaneEngine",
  "saveType": "CharacterSheet",
  "storeType": "override",
  "demiplaneEngineId": "uuid",
  "args": { "id": null }
}
```

---

## Data Available for Sync

### Demiplane -> Foundry (Character Build — Read)

| Data | Engine Name Pattern | Notes |
|------|-------------------|-------|
| Name | `custom_character_name` | value: "Ezren" |
| Level | `custom_character_level` | value: 5 |
| Class | `tabula/class/{slug}.eng` | slug: "wizard-rm" |
| Ancestry | `tabula/ancestry/{slug}.eng` | slug: "human-rm" |
| Heritage | `tabula/heritage/{slug}.eng` | slug: "skilled-human-rm" |
| Background | `tabula/background/{slug}.eng` | slug: "scholar-rm" |
| Attribute Boosts | `core/selection/attribute/boost.eng` | args.slug = "dexterity", etc. |
| Skill Training | `core/selection/skill/increase/index.eng` | args.slug = skill name |
| Feats | `tabula/feat/{slug}.eng` | slug: "familiar-rm", etc. |
| Class Features | `tabula/class-feature/{slug}.eng` | slug: "school-of-battle-magic-rm" |
| Spells (known/book) | `tabula/spell/{slug}.eng` | with `addSpellData.baseSpellbookSpell: true` |
| Spells (prepared) | `tabula/spell/{slug}.eng` | with `isPrepare: true` |
| Items | `tabula/item/{slug}.eng` | slug: "staff-of-air-basic-rm" |
| Familiar | `tabula/familiar/{slug}.eng` | slug: "cat-rm" |
| Familiar Abilities | `tabula/familiar-ability/{slug}.eng` | slug: "darkvision-rm" |

### Foundry -> Demiplane (Session State — Write)

These are all `CustomDemiplaneEngine` entries that can be updated:

| Data | Store Name | Type |
|------|-----------|------|
| Current HP | `character_hit-points_current` | number |
| Temp HP | `character_hit-points_temp` | number |
| Hero Points | `character_hero-points` | number |
| Focus Points | `character_focus_current` | number |
| Gold | `character_currency_gold` | number |
| Silver | `character_currency_silver` | number |
| Copper | `character_currency_copper` | number |
| Platinum | `character_currency_platinum` | number |
| Equipped Primary | `character_hand_primary_equipped-id` | engine UUID |
| Equipped Both | `character_hand_both_equipped-id` | engine UUID |
| Staff Charges | `character_spell-feature_{id}_charges_current` | number |
| Initiative Skill | `character_initiative` | string (skill slug) |
| View Permission | `view-permission` | number |

---

## Attribute Mapping API

The `getCharacterAttributeMapping` query (for nexusId: 1 = Pathfinder 2e) returns a complete map of display names to internal store names:

```
character_strength_mod, character_dexterity_mod, character_constitution_mod,
character_intelligence_mod, character_wisdom_mod, character_charisma_mod,
character_fortitude_mod, character_reflex_mod, character_will_mod,
character_armor_ac, character_hit-points_max, character_hit-points_current,
character_perception_mod, character_speed_land_value,
character_acrobatics_mod, character_arcana_mod, character_athletics_mod, ...
```

Each entry includes:
- `store_name` — internal key
- `description` — human-readable label
- `data_type` — "number" or string
- `token_bar_enabled` — whether it appears on VTT token bars
- `set` — whether the value is user-settable (true = writable from outside)
- `max_store_name` — for values with a maximum (like HP)

**Important:** Only entries with `"set": true` can be written back. These include:
- `hit_points` (current)
- `hit_points_temp`
- `hero_points`
- `focus_points`

Currency, while stored as CustomDemiplaneEngine values, is also writable.

---

## updateCharacterV2 Mutation (The Write Endpoint)

This is how you push changes back to Demiplane:

```graphql
mutation updateCharacterV2(
  $id: String!,
  $data: json!,
  $name: String,
  $level: Int,
  $classSlug: String,
  $avatarUrl: String,
  $viewPermission: Int,
  $editPermission: Int,
  $formatedData: json,
  $adminView: Boolean,
  $characterBrowserInstanceUuid: String
) {
  updateCharacterV2(...) {
    message
    result
    success
    __typename
  }
}
```

The `$data` parameter contains the full `engines` array plus `engineCacheIdsBySource`. To push session state changes, you'd need to:

1. Fetch the current character state
2. Modify the relevant `CustomDemiplaneEngine` entries (HP, currency, etc.)
3. Send the complete `engines` array back via `updateCharacterV2`

**Caution:** This sends the ENTIRE engine state. You'd want to be careful not to overwrite character build changes that happened on Demiplane since you last synced. A version check (`character_version` query) could help detect conflicts.

---

## Slug Mapping Challenge

Demiplane uses slugs like `fireball-rm`, `wizard-rm`, `staff-of-air-basic-rm`. Foundry PF2e uses compendium IDs and its own slug system. The mapping between these two systems is the main engineering challenge.

Possible approaches:
1. **Direct slug matching** — strip the `-rm` suffix and match against Foundry compendium slugs
2. **Name matching** — use the `name` field in engine args to fuzzy-match Foundry compendium entries
3. **Mapping table** — build/maintain a lookup table between systems
4. **Hybrid** — try slug match first, fall back to name match

---

## Architecture Recommendations

### Module Type
A Foundry VTT module (not a browser extension) makes more sense here since:
- Foundry modules can make HTTP requests to external APIs
- The module needs access to Foundry's Actor data for the Foundry -> Demiplane direction
- It can hook into Foundry's update lifecycle to trigger syncs

### Sync Flow

**Import (Demiplane -> Foundry):**
1. User provides character UUID (from Demiplane URL) and auth token
2. Module fetches character via GraphQL API
3. Parse engines array into structured character data
4. Map Demiplane slugs to Foundry PF2e compendium items
5. Create/update Foundry Actor

**Export (Foundry -> Demiplane):**
1. Hook into Foundry Actor update events (HP change, item use, currency change)
2. Map changed values to Demiplane CustomDemiplaneEngine entries
3. Fetch current character version from Demiplane (conflict check)
4. Push updated engines array via updateCharacterV2 mutation

### Auth Considerations
- Demiplane auth tokens appear to be session-based (cookie/JWT from their auth system)
- The module will need a way to authenticate — options:
  - User pastes a token from Demiplane (simplest)
  - OAuth flow if Demiplane supports it (unlikely for third-party)
  - Browser extension companion that shares auth cookies (more complex)

---

## Technical Notes

- Demiplane is a Next.js app (React Server Components with `__next_f` flight data)
- The GraphQL API uses Hasura-style naming (`demiplane_user_character`, `where` clauses)
- Character sheet URL pattern: `https://app.demiplane.com/nexus/pathfinder2e/character-sheet/{uuid}`
- The `characterBrowserInstanceUuid` field suggests Demiplane tracks which browser tab is editing — important for conflict resolution
- The `engineCacheIdsBySource` field contains version references for all loaded game content — this may need to be kept in sync

---

## Foundry VTT Actor Creation Strategy

### System Details (Tested)
- Foundry VTT v14.366
- PF2e System v8.4.0

### The Right Way: Compendium-Based Item Addition

The PF2e system uses a **GrantItem rule engine** — when you add a class, ancestry, or feat to a character, `GrantItem` rules on that item automatically cascade and add related features. This is why directly writing actor data breaks things.

**Core Pattern:**
```js
// 1. Resolve Demiplane slug -> Foundry compendium UUID
const foundrySlug = demiplaneSlug.replace(/-rm$/, '');
const index = await pack.getIndex({ fields: ["system.slug"] });
const entry = Array.from(index.values()).find(i => i.system?.slug === foundrySlug);
const item = await fromUuid(entry.uuid);

// 2. Add to actor (this triggers the grant cascade)
await actor.createEmbeddedDocuments("Item", [item.toObject()]);
```

### Slug Mapping (Confirmed Working)

Demiplane uses slugs with a `-rm` suffix for Remastered content. Stripping this suffix maps directly to Foundry PF2e compendium slugs:

| Demiplane Slug | Foundry Slug | Match? |
|---|---|---|
| fireball-rm | fireball | Yes |
| force-barrage-rm | force-barrage | Yes |
| haste-rm | haste | Yes |
| familiar-rm | familiar | Yes |
| incredible-initiative-rm | incredible-initiative | Yes |
| wizard-rm | wizard | Yes |
| human-rm | human | Yes |
| crossbow-rm | crossbow | Yes |
| glass-shield | glass-shield | Yes (no -rm suffix) |
| staff-of-air-basic-rm | staff-of-air | **Partial** (tier naming differs) |

Slugs without `-rm` (newer content) map directly with no transformation needed.

### Compendium Packs for Character Building

| Pack Key | Label | Items |
|---|---|---|
| pf2e.classes | Classes | 29 |
| pf2e.ancestries | Ancestries | 50 |
| pf2e.heritages | Heritages | 328 |
| pf2e.backgrounds | Backgrounds | 514 |
| pf2e.feats-srd | Feats | 6,283 |
| pf2e.spells-srd | Spells | 1,993 |
| pf2e.equipment-srd | Equipment | 5,856 |
| pf2e.classfeatures | Class Features | 880 |

### Item Addition Methods (By Type)

**Ancestry/Class/Heritage/Background:**
```js
// Use createEmbeddedDocuments — the grant system handles cascading features
const classItem = await fromUuid("Compendium.pf2e.classes.Item.RwjIZzIxzPpUglnK");
await actor.createEmbeddedDocuments("Item", [classItem.toObject()]);
// This auto-grants class features via GrantItem rules
```

**Feats:**
```js
// Same pattern — feats with GrantItem rules auto-add sub-features
const feat = await fromUuid(featUuid);
await actor.createEmbeddedDocuments("Item", [feat.toObject()]);
```

**Spells (via spellcasting entry):**
```js
const spellcasting = actor.spellcasting.find(e => e.name === "Arcane Prepared Spells");
const spell = await fromUuid(spellUuid);
await spellcasting.addSpell(spell, { groupId: rankGroupId });
```

**Equipment/Inventory:**
```js
const item = await fromUuid(equipmentUuid);
await actor.addToInventory(item); // Handles stacking automatically
```

### The Grant Chain System

When items are added to an actor, the PF2e system's rule engine processes `GrantItem` rules:
- Adding "Wizard" class → grants "Arcane School", "Arcane Thesis", "Arcane Bond", etc.
- Adding "Familiar" feat → grants the familiar action item
- Adding "Scholar" background → grants "Assurance (Arcana)"

Items track their relationships:
- `flags.pf2e.itemGrants` — what this item has granted to the actor
- `flags.pf2e.grantedBy` — which item caused this item to be added
- `onDelete: "cascade"` — if the parent is removed, the granted item is too

### Handling User Choices (ChoiceSet Rules)

Some grants require user selection (e.g., "Choose a skill for Skilled Human"). In the Demiplane data, these choices are already resolved in the engine `args`:
```json
{ "slug": "athletics", "sourceRow": "select-skill-skilled-human-rm..." }
```

The module would need to either:
1. Programmatically satisfy ChoiceSet prompts using Demiplane's resolved selections
2. Or add the resulting granted item directly (bypassing the choice UI)

### What NOT To Do

- Don't write to `actor.system` directly for calculated values (saves, skills, HP max)
- Don't reconstruct item data from scratch — always start from compendium items
- Don't bypass the grant chain for class/ancestry/heritage additions
- Don't duplicate items that the grant system would have added automatically

### Foundry → Demiplane Sync Hooks

```js
// Listen for changes to push back to Demiplane
Hooks.on("updateActor", (actor, changes) => {
  // Hero Points, HP, etc.
});
Hooks.on("updateItem", (item, changes) => {
  // Consumable uses, currency, etc.
});
Hooks.on("createItem", (item) => {
  // New inventory items
});
Hooks.on("deleteItem", (item) => {
  // Consumed/sold items
});
```

---

## Discovered During Research (Playwright MCP)

All of this was discovered by navigating to a live Demiplane character sheet and intercepting network traffic using Playwright MCP. The Playwright MCP server can be used in development to:
- Test authentication flows
- Inspect live API responses
- Verify sync operations
- Debug mapping issues by comparing Demiplane's rendered sheet with the raw data

Playwright MCP config:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--viewport-size=1920x1080"]
    }
  }
}
```

---

## Session: 2026-08-19 — Full Import Working

### Authentication Flow (UPDATED)

The old `/api/auth/login` endpoint **no longer exists** (returns 404 HTML). The actual auth flow is:

1. `POST https://auth.demiplane.com/userstore/authorize` — form-encoded: `action=authenticate`, `redirect_uri`, `email_or_username`, `password`. Returns 302 with tokens in URL fragment.
2. `GET https://app.demiplane.com/auth/callback-tokens?returnTo=...` — callback after auth
3. `POST https://app.demiplane.com/api/callback-tokens` — body: `{ accessToken, refreshToken, returnTo }`. Sets session cookies.
4. `GET https://app.demiplane.com/api/auth/token` — returns `{ accessToken, refreshToken }`
5. `POST https://app.demiplane.com/api/generate-graphql-token` — uses session cookies, returns `{ success: true, data: { token: "eyJ..." } }`

**CORS issue**: `auth.demiplane.com` and `app.demiplane.com/api/*` endpoints block CORS from browser origins. The GraphQL endpoint (`apiv4.demiplane.com/v1/graphql`) **does** allow CORS.

**Solution**: Authenticate server-side (Node.js or Playwright), get the GraphQL token, then inject it into the Foundry module via `DemiplaneClient.setToken(token)`.

### Verified: Valeros Level 5 (UUID: a5884413-857f-444c-a5d6-24d819632c8a)

- 99 engines total
- Version: 2
- Ancestry: human-rm, Heritage: skilled-human-rm, Background: farmhand-rm, Class: fighter-rm

### ChoiceSet Auto-Resolution (Approach #3 — Monkey-Patch)

The PF2e system's `ChoiceSetRuleElement.preCreate` opens a `PickAThingPrompt` dialog when items with choices are added. During import, this blocks the automation.

**Solution**: Monkey-patch `ChoiceSetRuleElement.prototype.preCreate` to auto-resolve selections from Demiplane data instead of showing the prompt.

```javascript
// Enable before import, disable after
window.__IMPORT_MODE__ = true;

const ChoiceSetRE = game.pf2e.RuleElements.builtin.ChoiceSet;
const originalPreCreate = ChoiceSetRE.prototype.preCreate;

ChoiceSetRE.prototype.preCreate = async function(params) {
  if (!window.__IMPORT_MODE__) return originalPreCreate.call(this, params);
  
  // Inflate choices, match against Demiplane data, set selection
  this.choices = await this.inflateChoices(rollOptions, params.tempItems);
  const matched = /* find matching choice from Demiplane selections */;
  if (matched) {
    this.selection = params.ruleSource.selection = matched.value;
    this.item.flags.pf2e.rulesSelections[this.flag] = matched.value;
  }
};
```

**Alternative (Approach #1)**: Pre-set `rule.selection` on item data before calling `createEmbeddedDocuments`. Works for simple cases (skills) but fails for item-UUID-based choices (feats) because you need the inflated choices list to match.

### ChoiceSet Selection Types

| ChoiceSet type | `selection` value format | Example |
|---|---|---|
| Skill choice | Plain slug string | `"acrobatics"` |
| Attribute choice | Plain slug string | `"strength"` |
| Feat/item choice (filter-based) | Compendium UUID | `"Compendium.pf2e.feats-srd.Item.w8Ycgeq2zfyshtoS"` |

### Demiplane sourceRow → Foundry Feat Slot Mapping

Feats need `system.location` and `system.level.taken` set correctly:

| Demiplane sourceRow pattern | Foundry location | level.taken |
|---|---|---|
| `fighter-feat-level-1-rm` | `class-1` | 1 |
| `fighter-feat-level-2-rm` | `class-2` | 2 |
| `fighter-feat-level-4-rm` | `class-4` | 4 |
| `ancestry-feats` | `ancestry-1` | 1 |
| `ancestry-feat-level-5-rm` | `ancestry-5` | 5 |
| `skill-feat-level-2-rm` | `skill-2` | 2 |
| `skill-feat-level-4-rm` | `skill-4` | 4 |
| `general-feat-level-3-rm` | `general-3` | 3 |

**Regex**: `sourceRow.match(/^(?:fighter|class|ancestry|skill|general)-feat(?:s)?-level-(\d+)/)` → type + level

Without setting these, feats appear in "Bonus Feats" section.

### Slug Extraction from Engine Name

Some engines (ancestry, class, background) have no `args.slug`. Extract from name:
```javascript
function getSlug(eng) {
  if (eng.args?.slug) return eng.args.slug;
  const match = eng.name.match(/\/([^/]+)\.eng$/);
  return match ? match[1] : null;  // "tabula/ancestry/human-rm.eng" → "human-rm"
}
```

### Feats Granted by ChoiceSets (Deduplication)

Feats whose `sourceRow` contains `select-feat-{parent-slug}` are granted automatically by the parent feat's ChoiceSet GrantItem. Do NOT add them directly — they'd duplicate.

```javascript
const grantedFeatSlugs = new Set();
for (const eng of engines) {
  if ((eng.args?.sourceRow || "").includes("select-feat-") && eng.args?.slug && eng.name.includes("/feat/")) {
    grantedFeatSlugs.add(toFoundrySlug(eng.args.slug));
  }
}
// Skip these in the batch feat import
```

### Import Order (Critical)

1. **Ancestry** (sequential, await)
2. **Heritage** (sequential, await) — may trigger ChoiceSet (e.g., Skilled Human)
3. **Background** (sequential, await)
4. **Class** (sequential, await) — triggers massive Grant Chain (class features, proficiencies)
5. **Feats** (batch) — with `system.location` and `system.level.taken` set
6. **Equipment** (batch) — not yet implemented for Valeros
7. **Set name/level** via `actor.update()`

### Foundry Setup (for development/testing)

- Foundry v14.367 requires **Node 24**
- Data directory structure: `Data/Config/`, `Data/Data/modules/`, `Data/Data/systems/`, `Data/Logs/`
- Module symlink: `Data/Data/modules/foundry-demiplane-pf2e -> /path/to/dist/`
- Module must have `dist/module.json` with correct `id` and `esmodules`
- Rollup needs `@rollup/plugin-commonjs` to bundle the CJS demiplane-api library

### Remaining Work

- [ ] Formalize import logic into `import-orchestrator.ts` (currently proven in browser evaluate)
- [ ] Handle auth flow properly (Playwright-based token acquisition or direct token paste)
- [ ] Attribute boosts need to be applied (from `core/selection/attribute/boost.eng` engines)
- [ ] Skill proficiencies need to be applied (from `core/selection/skill/increase/index.eng`)
- [ ] Equipment import
- [ ] Session state sync (HP, currency, hero points, focus → write back to Demiplane)
- [ ] Natural Ambition's granted feat (Reactive Shield) needs its own `system.location` set
- [ ] Handle "Assurance" feat granted by Background (already works via Grant Chain)
- [ ] Duplicate Shield Block issue (one from class features, one general — check if this is correct)
- [ ] Foundry setup script needs to handle "Allow Sharing Usage Data" dialog reliably

---

## Session: 2026-08-20 — ChoiceSet Resolution Breakthrough

### The ChoiceSet Problem (Resolved)

PF2e's `ChoiceSetRuleElement.preCreate` opens an interactive `PickAThingPrompt` when items with choices are added to an actor. This blocks automated import.

### Solution: Hybrid Pre-Selection + Monkey-Patch Fallback

**Two-layer approach:**

1. **Pre-selection (primary)**: Before calling `createEmbeddedDocuments`, set `rule.selection` on ChoiceSet rule elements in the item data. When the selection matches a valid choice, the original `preCreate` skips the prompt and runs all downstream logic (name adjustment, GrantItem processing).

2. **Monkey-patch fallback (secondary)**: Patch `ChoiceSetRuleElement.prototype.preCreate` during import. If pre-selection wasn't set (or doesn't match), the patch inflates choices, finds the best match from Demiplane data, and sets the selection. This handles cases where we can't know the exact value format ahead of time.

**Why this works better than replacing preCreate entirely:**
- The original preCreate handles name adjustment (e.g., "Skilled Human" → "Skilled Human (Acrobatics)")
- The original preCreate processes GrantItem rules that follow the ChoiceSet (e.g., Natural Ambition grants Reactive Shield)
- The original preCreate sets `flags.pf2e.rulesSelections` correctly

### How preCreate Checks for Pre-Selection (PF2e Source)

```typescript
// In ChoiceSetRuleElement.preCreate:
const selection =
    this.#getPreselection(this.choices) ??  // ← Checks if this.selection matches an inflated choice
    (await new PickAThingPrompt(...).resolveSelection());  // ← Only if no pre-selection found
```

`#getPreselection` does: `choices.find(c => R.isDeepEqual(this.selection, c.value))`

So the pre-set selection must EXACTLY match a choice's `value` field. For skills, the value is a plain string (`"acrobatics"`). For feat grants, it's a compendium UUID (`"Compendium.pf2e.feats-srd.Item.w8Ycgeq2zfyshtoS"`).

### findMatchInChoices Strategy (Fallback)

When the monkey-patch fires, it tries to match available choices against Demiplane data using four strategies in order:

1. **Direct skill match**: choice value is in the list of Demiplane skill selections
2. **Direct slug match**: choice value matches any DemiplaneEngine slug
3. **Partial slug match**: choice value is contained in (or contains) a Demiplane slug (e.g., `"sword"` matches `"weapon-master-sword"`)
4. **Feat UUID label match**: for Compendium UUIDs, compare choice label against Demiplane feat slugs

### presetChoiceSelections (Pre-Selection)

Before adding an item, this method:
1. Finds ChoiceSet rules on the item data
2. Looks for Demiplane engines whose `sourceRow` contains `select-{type}-{itemSlug}`
3. For filter-based ChoiceSets (feat grants), resolves the child slug to a compendium UUID
4. For simple ChoiceSets (skills), uses the slug directly
5. Sets `rule.selection = value`

### Results Achieved

- Heritage: "Skilled Human (Acrobatics)" — name adjusted, skill applied ✓
- Natural Ambition: ChoiceSet selects Reactive Shield UUID, GrantItem creates it on actor ✓
- Fighter Weapon Mastery: Partial match "sword" in "weapon-master-sword" ✓
- Zero interactive prompts during full import ✓

### What Is NOT Class-Specific

The entire ChoiceSet resolution is generic:
- Slug matching works for any class/ancestry/heritage
- `parseFeatSlot` regex handles `{classname}-feat-level-N-rm` for any class
- Attribute boost logic maps `ancestry-boosts`, `background-boosts`, `attribute-boosts-level-N-rm` generically
- Language parsing is class-independent

**Recommendation**: Don't introduce strategy pattern per class until a non-Fighter import reveals class-specific behavior. The most likely candidate for class-specific logic is **spellcasters** (spell slot management, prepared vs spontaneous, focus spells).

### Attribute Boosts (Working)

Applied via:
- Ancestry item: `system.boosts.{n}.selected = "str"` (on the ancestry embedded item)
- Background item: `system.boosts.{n}.selected = "con"` (on the background embedded item)
- Level boosts: `system.build.attributes.boosts.{level} = ["str", "dex", "con", "int"]` (on the actor)
- Class key ability: handled automatically by Grant Chain (skip)

Attribute names mapped: `strength → str`, `dexterity → dex`, etc.

### Languages (Working)

- Parsed from `character-languages-user` engine (comma-separated free text)
- Slugified and validated against `CONFIG.PF2E.languages`
- Applied to `system.details.languages.value` array
- Unrecognized languages logged in summary (not created)
- Applied AFTER attribute boosts (language count depends on INT)

### Skill Proficiencies (Partially Working)

**What works via Grant Chain:**
- Saves (fortitude, reflex, will) — from class
- Perception — from class
- Attack/defense proficiencies — from class
- Heritage skill (acrobatics from Skilled Human) — via ChoiceSet resolution
- Background skill (farming-lore from Farmhand) — via Grant Chain

**What still needs work:**
- Fighter's initial proficiency skills (crafting + 3+INT others) — class ChoiceSet is multi-select, not matching correctly
- Skill increases at levels 3, 5 — not being applied
- The skill rank values may need direct setting on `system.skills.{skill}.rank`

### Integration Tests (9 passing, 1 skipped, ~27s)

Run: `npx playwright test tests/integration/valeros-import.spec.ts`

Requires:
- Foundry on port 30001 (FOUNDRY_TEST_PORT) with PF2e + module
- DEMIPLANE_TOKEN in .env

Validates: identity, core items, feat slots (class/ancestry/skill/general), Grant Chain auto-grants, attribute modifiers, languages.
