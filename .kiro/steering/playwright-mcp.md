---
inclusion: auto
---

# Playwright MCP Server Usage Guidelines

Minimize token consumption when using the Playwright MCP browser tools.

## Snapshots

- Prefer `browser_find` (text search) over `browser_snapshot` when locating elements
- When `browser_snapshot` is needed, use `target` to scope to a specific element
- Use `depth` parameter to limit tree depth (2-3 is usually enough)
- Never take a full-page snapshot just to find a button — use `browser_find` first

## Evaluate Calls

- Return only the fields you need — not entire objects
- For any evaluate that might return >50 lines or large data (character engines, item arrays,
  compendium indices), use the `filename` parameter to save results to a file instead of
  returning into the conversation. Then read only the parts you need with `read_file`.
  Example: `browser_evaluate({ function: "...", filename: "tmp/engines-dump.json" })`
- Never pass long tokens/secrets inline in evaluate code — read from `game.settings` or module state
- For data exploration, extract and process in bash/python first, not in the browser
- Keep return values under 50 lines — summarize or filter server-side
- Combine multiple queries into a single evaluate call when possible

## Console Messages

- Only request `browser_console_messages` when debugging a specific error
- Use `level: "error"` filter — don't pull full info/debug logs
- Don't request console messages "just to check" — only when something failed

## Navigation & Interaction

- Use `browser_click` with a known ref rather than evaluate + querySelector
- Combine multiple checks into a single evaluate call rather than making separate calls
- After a page reload, use `browser_wait_for` with a specific text condition (e.g., an element
  that appears when the page is ready) rather than arbitrary time waits — don't poll repeatedly

## General

- If you already have data cached (e.g., engine data in a file), use bash/python to analyze it rather than re-fetching via the browser
- Prefer running Playwright test suites for validation over manual MCP interactions when possible
- When the MCP browser shows something you've already verified in tests, trust the tests

## Temporary Files

- Use the project's `tmp/` directory (at the repo root) for all temporary files — never `/tmp`
- This keeps temp files visible in the workspace, avoids sandbox permission prompts,
  and makes debugging easier
- The `tmp/` directory must be listed in `.gitignore`
- Create it with `mkdir -p tmp` if it doesn't exist before writing temp files
- Use descriptive filenames: `tmp/engines-dump.json`, `tmp/spell-import-result.json`
