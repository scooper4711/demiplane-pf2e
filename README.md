![GitHub Release](https://img.shields.io/github/v/release/scooper4711/demiplane-pf2e)
![GitHub Downloads](https://img.shields.io/github/downloads/scooper4711/demiplane-pf2e/total)
![Foundry v14+](https://img.shields.io/badge/Foundry-v14-informational)
![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Fdemiplane-pf2e&colorB=4aa94a)

![CI](https://img.shields.io/github/actions/workflow/status/scooper4711/demiplane-pf2e/ci.yml?label=CI)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=scooper4711_demiplane-pf2e&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=scooper4711_demiplane-pf2e)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=scooper4711_demiplane-pf2e&metric=coverage)](https://sonarcloud.io/summary/new_code?id=scooper4711_demiplane-pf2e)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=scooper4711_demiplane-pf2e&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=scooper4711_demiplane-pf2e)
![License](https://img.shields.io/github/license/scooper4711/demiplane-pf2e)

# Demiplane PF2e Sync for Foundry VTT

_Written with AI assistance. See [below](#regarding-the-use-of-ai) for a statement about the use of AI in this project._

Build your Pathfinder 2e character on [Demiplane Nexus](https://app.demiplane.com), then bring it straight into your Foundry game. No copy-pasting stats, no manual data entry, no "wait, what level did I take Fleet at?"

Level up on Demiplane, click update in Foundry, and you're good to go.

## Demo

https://github.com/user-attachments/assets/dfca47d2-0786-4bfa-8812-0b4a8aea0f58

## Why You Want This

**Players:** You already love Demiplane's character builder. Now you can use it _and_ play on Foundry without rebuilding your character by hand. Import once, and future updates are a single click.

**Pathfinder Society players:** Demiplane already integrates with Roll20. With this module, you can use the same character on both Roll20 and Foundry, always kept in sync through Demiplane. Play with different GMs on different VTTs without maintaining separate character sheets.

**GMs:** Foundry has the best support for Pathfinder of all the VTTs out there. But it lets players by mistake create invalid characters with too many spell slots or similar hard-to-spot errors. Demiplane enforces the rules of character building, and so by using this module you know that the character build is correct. And if you want to augment the character for some homebrew rules? You can absolutely do that, and Demplane PF2e Sync will leave your additions alone while syncing the rest of the character feats and skills.

## What Gets Imported

- Ancestry, heritage, and background
- Class, subclass, and all class features
- Feats (ancestry, class, skill, general, bonus)
- Equipment and weapons
- Attribute boosts and skill proficiencies
- Spells and focus spells
- Rituals and crafting formulas
- Languages
- Biography and appearance

The import builds your character the same way as if you dragged and dropped each item onto the sheet yourself. It doesn't mess with internal structures or take shortcuts, which means you're far less likely to hit weird errors during play that only happen with imported characters.

## Syncing Back to Demiplane

When you change your character in Foundry, the module can keep your Demiplane sheet up to date. How much it writes back is controlled by the **Write to Demiplane** setting (under Game Settings). Each level includes everything from the levels before it, and the description under the menu changes to tell you what the level you’ve picked will do.

| Level                   | What gets written to Demiplane when you edit in Foundry                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Read-only** (default) | Nothing — Foundry never changes your Demiplane sheet. Good for Pathfinder Society play or when the GM doesn’t have permission to edit your Demiplane character.                                                                                                                                                                                                                                                                                                    |
| **Story mode**          | Biography and appearance, languages, organized play ID, and campaign notes can all be edited in Foundry and written to Demiplane. Inventory and any field ending in “points” (hit points, hero points, focus points) stays only in Foundry.                                                                                                                                                                                                                        |
| **Session mode**        | Everything in Story Mode, plus hit points (current and temp), hero points, focus points, coins, spell slots, and inventory (how many you have, whether it’s worn, held in one or two hands, invested, and which container it’s in).<br>Deleting an item here doesn’t truly delete it — it just sets its amount to 0 on Demiplane. You can get it back later by raising the amount again. At this level, items with an amount of 0 are hidden when you next import. |
| **Full sync**           | The same as Session Mode, but deleting an item actually removes it from Demiplane. You’ll always be asked to confirm first.                                                                                                                                                                                                                                                                                                                                        |

A new install starts at **Read-only**, so the module won’t change anything on Demiplane until a GM chooses a higher level.

Deity can come from either the “deity” text field, or from the class definition for e.g. clerics and champions. It is never written to Demiplane at any level — your choice still shows up when you import, but changing it in Foundry won’t change Demiplane. Adding a brand-new item in Foundry (something that didn’t come from Demiplane) isn’t sent to Demiplane either.

**Deleting an item is the most permanent change.** In Session mode it’s reversible (the amount just goes to 0, no pop-up). In Full sync it truly removes the item from Demiplane and you’ll always get a pop-up asking you to confirm — you can choose to keep it on Demiplane and just remove it in Foundry. In Read-only or Story mode, deleting in Foundry only removes it in Foundry. If you delete something you added yourself in Foundry that never came from Demiplane, it never asks and never tries to change Demiplane. A quantity of 0 only means “deleted” at Session mode; at every other level 0 is just a normal amount (useful if you use up a consumable and want to set it back to a few later).

When you edit your character in Foundry, you’ll see the change appear on your Demiplane sheet a few seconds later — you don’t need to press anything else. If you want it to go right away, you can also click **Push to Demiplane** at the top of your character sheet.

Spell use and inventory organization carry over as well — casting a prepared spell, spending a spontaneous spell slot or a focus point, or moving items in and out of backpacks and pouches (even when you’ve renamed or added extra containers) will show up on Demiplane the same way.

> **Do not edit the same character in Demiplane and in Foundry at the same time.** If you import into Foundry and then edit in Demiplane, your next change in Foundry will trigger a full re-import of your character, and you risk losing your Foundry edits.

Still on the roadmap:

- Adding inventory items in Foundry write to Demiplane
- Pets/Familiars/Summons
- Starfinder support

## How It Works

### First Import (Usually the GM)

The first time a character is imported, the module creates a new Foundry Actor. This requires **Create Actor** permission, which most servers restrict to GMs. So the typical flow is:

1. **GM** clicks the "Import Demiplane Character" button in the Actors sidebar.
2. GM pastes the character's Demiplane URL or UUID.
3. The module creates the actor and populates everything.
4. GM assigns ownership of the actor to the player.

After that, the player can update their own character whenever they level up or make changes on Demiplane.

### Updating an Existing Character (Players Can Do This)

Once the actor exists and the player has ownership:

1. Right-click the actor in the sidebar and choose "Update from Demiplane."
2. Or open the actor sheet's **Sync** tab and click **Import from Demiplane**.

That's it. The module fetches the latest version and applies the diff.

### Mapping Unknown Items (GM Only)

Demiplane and Foundry don't always use the same name for the same thing, and Demiplane sometimes carries content the PF2e compendium lists under a different name. When the importer can't find a match, it skips the item and records it as an unresolved item rather than guessing. The **Demiplane Mapping** screen lets a GM teach the module those matches once, and every future import for every player picks them up automatically.

Open it from **Settings > Game Settings > Demiplane PF2e Sync > Demiplane Mapping** (visible to GMs only). You'll see the unresolved Demiplane names grouped by kind — equipment, feats, spells, ancestry, heritage, background, and class — along with which characters each one affects.

To create a mapping:

1. Click a row's browse action. For equipment, feats, and spells this opens the PF2e Compendium Browser on the matching tab; for ancestry, heritage, background, and class it opens the relevant compendium pack.
2. Find the correct Foundry item.
3. Drag it onto the row. The module remembers the match and the row updates to show the mapped item.

Once mapped, the Demiplane name resolves on its own from then on — no need to remap it per character or per import. Mappings can also be exported and imported across worlds, so a table starting fresh doesn't reteach them.

**Quickly adopt new classes and sourcebooks:** this is the fast path when a new class, ancestry, or sourcebook lands. Rather than waiting for the module to catch up, a GM can map the new Demiplane content onto the corresponding Foundry compendium entries once, and the whole table can import those characters right away.

**Homebrew** You can also use this to create your own homebrew items and map them (Homebrew for Demiplane not yet released).

### Linking a Character

You can't link an existing Actor in Foundry to Demiplane. In order for the module to
replicate the character build correctly, it needs to start from an empty actor. This allows
it to keep the actor up-to-date even when you completely rebuild the character.

Importing a character is easy - just press the "import from Demiplane" button and provide
either:

- The full Demiplane URL: `https://app.demiplane.com/nexus/pathfinder2e/character-sheet/...`
- Or just the UUID from that URL

You can find this by opening your character on Demiplane and copying the URL from the address bar.

## Configuration

In **Settings > Module Settings > Demiplane PF2e Sync**:

- **Demiplane Authorization Token** — The GM must provide the token used to access the Demiplane API. Players can use the token for imports and sync operations, but the token setting is hidden from them.

### Getting the Demiplane Token

The easiest way to get your token is with a Chrome browser extension that captures authorization headers automatically:

1. Install one of these Chrome extensions:
   - [Access Token Grabber](https://chromewebstore.google.com/detail/access-token-grabber/dmdogmnoogmaabbeemfjolaohpimiiif) (Featured)
   - [Bearer Token Grabber](https://chromewebstore.google.com/detail/bearer-token-grabber/hmaeemkadgnleglmmgkklojkcfbcamgj)
   - [Get Authorization Token](https://chromewebstore.google.com/detail/kipgkanokhilagghiahpbmhkhdacejen)
2. Log in to [Demiplane Nexus](https://app.demiplane.com) in Chrome.
3. Open any character sheet on Demiplane.
4. Click the extension icon — it will show the captured token.
5. Copy the token. If the value starts with `Bearer `, you can paste the whole thing — the module strips that prefix automatically.
6. In Foundry, open **Settings > Module Settings > Demiplane PF2e Sync**, paste the token into **Demiplane Authorization Token**, and save.

<details>
<summary>Alternative: using browser DevTools (for technical users)</summary>

1. Log in to [Demiplane Nexus](https://app.demiplane.com) in a desktop browser.
2. Open developer tools (**F12** or **Cmd+Option+I**) and select the **Network** tab.
3. Open a character sheet or refresh one that is already open.
4. Find a request to `https://apiv4.demiplane.com/v1/graphql`.
5. Open the request headers and copy the value of the `Authorization` header (a leading `Bearer ` is fine — the module strips it).
6. Paste into the module settings as above.

</details>

The token is stored as a world setting so players can import characters they own without seeing or entering the token. Demiplane tokens expire, so the GM must repeat these steps when imports begin reporting authentication errors. Treat the token like a password and do not share it outside the Foundry world.

## Troubleshooting

**"No Demiplane token configured"** — Ask the GM to configure the authorization token. See the [Getting the Demiplane Token](#getting-the-demiplane-token) section above.

**"Your Demiplane token has expired"** — Demiplane tokens expire. Repeat the [Getting the Demiplane Token](#getting-the-demiplane-token) steps above and paste the fresh token into the module settings.

**Some items show as unresolved after import** — A few Demiplane items may not have an exact match in the Foundry PF2e compendium yet. The import skips those and lists them in the Demiplane dialog so you can add them manually. The Demiplane icon shifts appearance to red on the linked actor's titlebar while such sync issues are outstanding. A GM can also resolve them for everyone using the [Demiplane Mapping](#mapping-unknown-items-gm-only) screen so future imports pick them up automatically. Feat-granting and ancestry choices increasingly resolve on their own, and a push that conflicts with newer Demiplane edits recovers according to your write level instead of always forcing a re-import.

## Pre-Release Notice

This module is pre-release software. It can result in data loss for the Foundry Actor, the Demiplane character, or both. Back up your world and your Demiplane characters before using it. You'll see a warning dialog each time the module loads as a reminder.

## Compatibility

- Foundry VTT v14+
- PF2e system

## License

MIT

## Acknowledgements

Huge thanks to the beta testers whose feedback shaped this module: **AKA_Kira**, **Anchor89**, and **Greywolf**.

## Support

If this module saves you time at the table, consider supporting development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/coop207627)

---

## Regarding the use of AI:

I used AI as a coding assistant while building this. I'm a software engineer with decades of professional experience. I could have written every line myself, but AI let me move faster. I drove the architecture and design decisions, followed industry best practices for code quality, and made sure everything is human-readable and maintainable. The project has SonarCloud quality gates and a full test suite that must pass before any release.

Think of it like driving a car instead of walking. I plan the route, decide the stops along the way, and AI gets me to the destination faster than I could on foot. But I'm still the one behind the wheel.

If you don't want to use tools written with AI assistance, then I respect that decision. That's why I'm transparent about it. You can make up your own mind.
