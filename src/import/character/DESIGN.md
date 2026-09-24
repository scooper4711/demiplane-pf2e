# `import/character` sub-package

Actor-profile import: biography, attribute boosts, skill proficiencies, and
languages. Depends only on `core`, `shared`, and `mapping` (enforced by
`import-character-depends-inward`).

## Responsibility

Write the non-item actor profile — identity/bio fields, deity fallback,
attribute boosts placed on their source items, skill increases, and
languages — with Demiplane free text normalized to compendium slugs
(including remaster renames).

## Public surface

`index.ts` is authoritative (4 names). The driver needs only the
apply-steps:

| From                             | Role                              | Names                                                               |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `biography-importer.ts`          | Bio fields, deity, organized play | `applyBiography`                                                    |
| `attribute-language-importer.ts` | Boosts, skills, languages         | `applyAttributeBoosts`, `applyLanguages`, `applySkillProficiencies` |

Internal (not exported): `remaster-renames.ts` (free-text → remaster slug
normalization, used only by the attribute/language importer).

## How it works

- Biography resolves the deity (a fallback read — deity is build-derived
  and never pushed; see DESIGN §25) and writes bio fields through the
  `core/pf2e-types.ts` seams.
- Attributes place boosts on their source items (DESIGN §11) and skills
  apply increases; languages normalize free text (`slugifyFreeText`)
  through remaster renames before matching, so trailing punctuation and
  pre-remaster names still hit.
- Unresolvable languages are reported as import errors rather than forced
  into the unmapped-slug shape (DESIGN §18).

## Constraints

- No sibling, driver, `sync`, `export/`, or `ui/` imports. Profile writes
  that need write-gating should ask `sync/` — if that need arises, this
  constraint documents the edge to add deliberately, not accidentally.
