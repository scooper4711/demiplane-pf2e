# Spellcasting Entry Validation

Check off each row after verifying tradition and key ability against Demiplane.
Use the comments column to direct any rework.

Spec coverage: prepared type, tradition, key ability, and proficiency rank are
asserted per entry via `expectSpellcastingEntries` in every import spec.

Per the rules, the attribute behind a spell attack depends on the source:
class spellcasting uses the key attribute, innate spells default to Charisma
unless their grant says otherwise, and focus spells use whatever the granting
ability specifies. Every entry below rolls spell attacks and spell DCs off its
own tradition/ability/proficiency — none of them uses the actor-level class
DC, which belongs to non-spell class features (Exploit Vulnerability,
impulses, finishers) rather than spellcasting entries. Imported entries start
at trained proficiency; rank progression rides the imported class item's own
rules. The module never writes class DC (system-owned). No fixture exercises flexible preparation (the
`flexible` checkbox reads false on every entry); the specs pin that, so the
day one does will light up. (Flexible preparation belonged to the pre-remaster
Flexible Spellcaster archetype and went away with the remaster, so false
everywhere is the expected steady state, not a gap.)

## Main entries

| Verified | Class       | Entry                       | Kind        | Tradition | Ability   | Proficiency                    | Comments                                                      |
| -------- | ----------- | --------------------------- | ----------- | --------- | --------- | ------------------------------ | ------------------------------------------------------------- |
| [ ]      | Bard        | Bard Spells (Occult)        | spontaneous | occult    | cha       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Cleric      | Cleric Spells (Divine)      | prepared    | divine    | wis       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Druid       | Druid Spells (Primal)       | prepared    | primal    | wis       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Sorcerer    | Sorcerer Spells (Arcane)    | spontaneous | arcane    | cha       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Wizard      | Wizard Spells (Arcane)      | prepared    | arcane    | int       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Witch       | Witch Spells (Occult)       | prepared    | occult    | int       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Magus       | Magus Spells (Arcane)       | prepared    | arcane    | int       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Oracle      | Oracle Spells (Divine)      | spontaneous | divine    | cha       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Psychic     | Psychic Spells (Occult)     | spontaneous | occult    | cha       | Spell Attack Modifiers and DCs | Assumes Cha — an Int psychic has no Demiplane signal; confirm |
| [ ]      | Animist     | Animist Spells (Divine)     | prepared    | divine    | wis       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Necromancer | Necromancer Spells (Occult) | prepared    | occult    | int       | Spell Attack Modifiers and DCs |                                                               |
| [ ]      | Summoner    | Summoner Spells (Tradition) | spontaneous | eidolon's | cha       | Spell Attack Modifiers and DCs | Tradition follows the eidolon                                 |
| [ ]      | Archetypes  | (base class entry)          | (as base)   | (as base) | (as base) | Spell Attack Modifiers and DCs | Casts exactly like the base class                             |

## Focus and special entries

`—` means the importer writes no ability and the system default applies.
Confirm that default is acceptable wherever the entry holds save-carrying
spells (e.g. Necrotic Bomb).

| Verified | Entry                                | Tradition                      | Ability written | Proficiency                    | Source                   | Comments                          |
| -------- | ------------------------------------ | ------------------------------ | --------------- | ------------------------------ | ------------------------ | --------------------------------- |
| [ ]      | Composition Spells (bard)            | occult                         | —               | Spell Attack Modifiers and DCs | class declaration        |                                   |
| [ ]      | Hexes (witch)                        | occult                         | —               | Spell Attack Modifiers and DCs | class declaration        |                                   |
| [ ]      | Divine Font (cleric)                 | divine                         | ?               | Spell Attack Modifiers and DCs | font entry               | Confirm ability                   |
| [ ]      | Apparition Spells (Divine) (animist) | divine                         | —               | Spell Attack Modifiers and DCs | apparition feature       | Spontaneous entry, not focus      |
| [ ]      | Vessel Spells (animist)              | divine                         | —               | Spell Attack Modifiers and DCs | vessel grant             |                                   |
| [ ]      | Revelation Spells (oracle)           | divine                         | —               | Spell Attack Modifiers and DCs | mystery declaration      |                                   |
| [ ]      | Grave Spells (necromancer)           | occult                         | —               | Spell Attack Modifiers and DCs | spellcasting declaration |                                   |
| [ ]      | Link Spells (summoner)               | eidolon's                      | —               | Spell Attack Modifiers and DCs | hardcoded fallback       |                                   |
| [ ]      | Devotion Spells (champion)           | divine                         | cha             | Spell Attack Modifiers and DCs | selection table          |                                   |
| [ ]      | Qi Spells (monk)                     | occult                         | wis             | Spell Attack Modifiers and DCs | selection table          |                                   |
| [ ]      | Warden Spells (ranger)               | primal, divine if vindicator   | wis             | Spell Attack Modifiers and DCs | selection table          | Vindicator edge flips tradition   |
| [ ]      | Focus Spells (generic fallback)      | resolved from existing entries | —               | Spell Attack Modifiers and DCs | fallback                 | Currently holds Vindicator's Mark |

## Non-caster entries

One row per character entry. When a character holds more than one entry with
different kinds, traditions, or abilities, each gets its own row; when all of
a character's entries match on all three, they collapse to a single row named
"all".

| Verified | Character | Entry           | Kind   | Tradition | Ability | Proficiency                    | Comments                                                                                                                  |
| -------- | --------- | --------------- | ------ | --------- | ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| [X]      | Champion  | Devotion Spells | focus  | divine    | cha     | Spell Attack Modifiers and DCs | Unclear in demiplane if it's spell attack or class dc, as there are no attack rolls or saves asssocicated with the spell. |
| [X]      | Monk      | Qi Spells       | focus  | occult    | wis     | Spell Attack Modifiers and DCs | Unclear in demiplane if it's spell attack or class dc since Qi Rush just allows additional strides.                       |
| [X]      | Ranger    | Warden Spells   | focus  | divine    | wis     | Spell Attack Modifiers and DCs | Normally primal; divine via the vindication edge                                                                          |
| [X]      | Ranger    | Focus Spells    | focus  | divine    | cha     | Spell Attack Modifiers and DCs | Holds Vindicator's Mark - demiplane says this is wisdom, not charisma                                                     |
| [X]      | Exemplar  | Innate Spells   | innate | divine    | cha     | Spell Attack Modifiers and DCs | Empty Sky kitsune chain                                                                                                   |
