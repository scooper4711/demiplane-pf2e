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

Build your Pathfinder 2e character on [Demiplane Nexus](https://app.demiplane.com), then bring it straight into your Foundry game. No copy-pasting stats, no manual data entry, no "wait, what level did I take Fleet at?"

Level up on Demiplane, click update in Foundry, and you're good to go.

## Demo

[docs/Demiplane%20Import%20Demo.mp4](https://github.com/scooper4711/demiplane-pf2e/raw/refs/heads/main/docs/Demiplane%20Import%20Demo.mp4)

## Why You Want This

**Players:** You already love Demiplane's character builder. Now you can use it _and_ play on Foundry without rebuilding your character by hand. Import once, and future updates are a single click.

**Pathfinder Society players:** Demiplane already integrates with Roll20. With this module, you can use the same character on both Roll20 and Foundry, always kept in sync through Demiplane. Play with different GMs on different VTTs without maintaining separate character sheets.

**GMs:** Your players show up with characters that just work — ancestry, feats, equipment, skills, the whole thing. No more fixing broken sheets mid-session.

## What Gets Imported

- Ancestry, heritage, and background
- Class, subclass, and all class features
- Feats (ancestry, class, skill, general, bonus)
- Equipment and weapons
- Attribute boosts and skill proficiencies
- Spells and focus spells
- Languages
- Biography and appearance

The import builds your character the same way as if you dragged and dropped each item onto the sheet yourself. It doesn't mess with internal structures or take shortcuts, which means you're far less likely to hit weird errors during play that only happen with imported characters.

## Syncing Back to Demiplane

The module can push session state from Foundry back to the linked Demiplane sheet:

- Current hit points
- Temporary hit points
- Hero points
- Item equipped state (including 1H/2H hand assignment and armor worn-in-slot)
- Item quantity

Turn on **Auto-sync on Actor Update** in module settings to push those fields automatically (debounced by two seconds, rate-limited). You can also push on demand from the actor sheet's **Demiplane** header button (**Push to Demiplane**), or from the console with `game.modules.get("demiplane-pf2e").api.exportNow(actor)`.

Still on the roadmap:

- Focus points
- Currency (gold, silver, copper, platinum)
- Inventory changes (items gained, spent, or lost during a session)

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

### Linking a Character

The module needs to know which Demiplane character maps to which Foundry actor. You link them by providing either:

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
5. Copy the token. If the value starts with `Bearer `, remove that prefix — you only need the long string after it.
6. In Foundry, open **Settings > Module Settings > Demiplane PF2e Sync**, paste the token into **Demiplane Authorization Token**, and save.

<details>
<summary>Alternative: using browser DevTools (for technical users)</summary>

1. Log in to [Demiplane Nexus](https://app.demiplane.com) in a desktop browser.
2. Open developer tools (**F12** or **Cmd+Option+I**) and select the **Network** tab.
3. Open a character sheet or refresh one that is already open.
4. Find a request to `https://apiv4.demiplane.com/v1/graphql`.
5. Open the request headers and copy the value of the `Authorization` header, without the `Bearer ` prefix.
6. Paste into the module settings as above.

</details>

The token is stored as a world setting so players can import characters they own without seeing or entering the token. Demiplane tokens expire, so the GM must repeat these steps when imports begin reporting authentication errors. Treat the token like a password and do not share it outside the Foundry world.

## Troubleshooting

**"No Demiplane token configured"** — Ask the GM to configure the authorization token. See the [Getting the Demiplane Token](#getting-the-demiplane-token) section above.

**Some items show as unresolved after import** — A few Demiplane items may not have an exact match in the Foundry PF2e compendium yet. The import skips those and lists them in the Demiplane dialog so you can add them manually. A red dot appears on the linked actor's titlebar while such sync issues are outstanding.

## Pre-Release Notice

This module is pre-release software. It can result in data loss for the Foundry Actor, the Demiplane character, or both. Back up your world and your Demiplane characters before using it. You'll see a warning dialog each time the module loads as a reminder.

## Compatibility

- Foundry VTT v14+
- PF2e system

## License

MIT

## Support

If this module saves you time at the table, consider supporting development:

[Support on Ko-fi](https://ko-fi.com/coop207627)
