# `import/choices` sub-package

ChoiceSet auto-resolution: the driver, the matcher registry, the built-in
strategies, class-specific configs, and per-actor user overrides. Depends
only on `core` and `shared` (enforced by
`import-choices-depends-inward`). See
[ARCHITECTURE "ChoiceSet Auto-Resolution"](../../../docs/ARCHITECTURE.md#choiceset-auto-resolution)
and [DESIGN §7](../../../docs/DESIGN.md#7-choiceset-wrapping-libwrapper-when-available),
[§31](../../../docs/DESIGN.md#31-user-specified-choice-resolution).

## Responsibility

Resolve PF2e's interactive ChoiceSet prompts without user interaction
during import — automatically where a strategy matches, via a stored
per-actor pick where it doesn't, via a blind `choices[0]` guess only as a
last resort — and record what needs a human decision.

## Public surface

`index.ts` is authoritative (3 names). The registry, strategies, configs,
and override store are internal; the driver and `ui/` need only these:

| From                    | Role                                         | Names                                         |
| ----------------------- | -------------------------------------------- | --------------------------------------------- |
| `choice-set-handler.ts` | ChoiceSet wrap lifecycle + preset selections | `ChoiceSetHandler`, `formatChoiceSetFallback` |
| `choice-overrides.ts`   | Pure override helpers (no Foundry deps)      | `localizeChoiceLabel`                         |

Internal (not exported): `choice-set-types.ts` (context/param
interfaces), `choice-slug.ts` (label → slug normalization),
`matcher-registry.ts` (strategy composition), `choice-matchers.ts` (the 7
built-in strategies, pure), `grant-builder-matchers.ts`,
`kineticist-matchers.ts` + `class-choice-config.ts` (class-specific
configs), `ikon-weapon-matcher.ts` (pure solver) +
`ikon-weapon-resolver.ts` (actor bridge).

## How it works

- `ChoiceSetHandler.enable()` wraps `ChoiceSet.preCreate` (through
  libWrapper when available, else a defensive prototype patch restored
  only if still live) and `disable()` removes it; the wrap lives only for
  the import. `presetChoiceSelections` pre-seeds item data before creation.
- On a prompt, strategies run in priority order (skill slugs → custom
  lore → engine slugs → class-feature slugs → generic features → feat
  UUIDs → generic keywords). Resolution order per ChoiceSet is matchers →
  stored override → blind guess; single-option sets never consult
  overrides, and unresolved sets are captured as structured records for
  the sync dialog.
- Class-specific behavior (kineticist impulses, grant-builder selections,
  ikon weapons) plugs into the same registry rather than branching the
  handler, keeping the handler focused on patching and the matchers
  independently testable.

## Constraints

- Matchers stay pure (engines in, match out) — no actor I/O outside
  `choice-set-handler.ts` and `ikon-weapon-resolver.ts`.
- Overrides are consulted only after matching fails, so user picks can
  never beat an automatic match.
