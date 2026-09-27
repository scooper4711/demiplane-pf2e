/**
 * PF2e proficiency ranks and other bounded game constants, named so the values
 * read as intent rather than magic numbers.
 *
 * PF2e proficiency is a 0–4 scale shared by skills, saves, spellcasting entries,
 * etc. (mirrors ZeroToFour / the proficiency ranks in
 * pf2e/src/module/actor/data/values.ts).
 */
export const PROFICIENCY_UNTRAINED = 0;
export const PROFICIENCY_TRAINED = 1;
export const PROFICIENCY_EXPERT = 2;
export const PROFICIENCY_MASTER = 3;
export const PROFICIENCY_LEGENDARY = 4;

/** A character can hold at most 3 hero points (pf2e/src/module/actor/character/data.ts). */
export const MAX_HERO_POINTS = 3;
