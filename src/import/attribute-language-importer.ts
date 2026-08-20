import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";

/**
 * Imports skill proficiencies from Demiplane.
 */
export async function applySkillProficiencies(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
): Promise<void> {
  const skillEngines = engines.filter(
    (e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug,
  );
  if (skillEngines.length === 0) return;

  const profOverrides: Record<string, number> = {};
  const overriddenFlags = new Set<string>();
  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    const overriddenMatch = eng.name.match(/^character_(.+)_prof--overridden$/);
    if (overriddenMatch && eng.value === 1) {
      overriddenFlags.add(overriddenMatch[1]);
    }
    const profMatch = eng.name.match(/^character_(.+)_prof$/);
    if (profMatch && typeof eng.value === "number") {
      profOverrides[profMatch[1]] = eng.value as number;
    }
  }

  const activeOverrides: Record<string, number> = {};
  for (const skill of overriddenFlags) {
    if (skill in profOverrides) {
      activeOverrides[skill] = profOverrides[skill];
    }
  }

  const ranks: Record<string, number> = {};
  for (const eng of skillEngines) {
    const slug = eng.args.slug as string;
    const sourceRow = (eng.args.sourceRow as string) || "";

    if (sourceRow.includes("select-skill-") && sourceRow.match(/heritage|human-rm/)) continue;
    if (slug in activeOverrides) continue;

    const isIncrease = sourceRow.includes("skill-increase");
    const rank = isIncrease ? 2 : 1;
    ranks[slug] = Math.max(ranks[slug] || 0, rank);
  }

  const updates: Record<string, number> = {};
  const currentSkills = (actor.system as { skills: Record<string, { rank: number }> }).skills;

  for (const [skill, targetRank] of Object.entries(ranks)) {
    const currentRank = currentSkills[skill]?.rank ?? 0;
    if (targetRank > currentRank) {
      updates[`system.skills.${skill}.rank`] = targetRank;
    }
  }

  if (Object.keys(updates).length > 0) {
    await actor.update(updates);
    const applied = Object.entries(updates).map(([s, r]) => `${s.replace("system.skills.","").replace(".rank","")}:${r}`).join(", ");
    summary.log.push(`+ skills: [${applied}]`);
  }

  if (Object.keys(activeOverrides).length > 0) {
    const overrideUpdates: Record<string, number> = {};
    for (const [skill, rank] of Object.entries(activeOverrides)) {
      const currentRank = currentSkills[skill]?.rank ?? 0;
      if (rank !== currentRank) {
        overrideUpdates[`system.skills.${skill}.rank`] = rank;
      }
    }
    if (Object.keys(overrideUpdates).length > 0) {
      await actor.update(overrideUpdates);
      const applied = Object.entries(activeOverrides).map(([s, r]) => `${s}:${r}`).join(", ");
      summary.log.push(`+ skill overrides: [${applied}]`);
    }
  }
}

/**
 * Imports additional languages from Demiplane free-text field.
 */
export async function applyLanguages(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
): Promise<void> {
  const langEngine = engines.find(
    (e) => e.name === "character-languages-user" && e.type === "CustomDemiplaneEngine",
  );
  if (!langEngine || !langEngine.value || typeof langEngine.value !== "string") return;

  const rawLanguages = (langEngine.value as string)
    .split(/[,\n\r]+/)
    .map((l) => l.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);

  const validLanguages = Object.keys(
    (game as unknown as { pf2e: { system: { config: { PF2E: { languages: Record<string, string> } } } } }).pf2e?.system?.config?.PF2E?.languages
    ?? (CONFIG as unknown as { PF2E: { languages: Record<string, string> } }).PF2E?.languages
    ?? {},
  );

  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const lang of rawLanguages) {
    if (validLanguages.includes(lang)) {
      matched.push(lang);
    } else {
      unmatched.push(lang);
    }
  }

  if (matched.length > 0) {
    const currentLangs = (actor.system as { details: { languages: { value: string[] } } }).details.languages.value;
    const newLangs = [...new Set([...currentLangs, ...matched])];
    await actor.update({ "system.details.languages.value": newLangs });
    summary.log.push(`+ languages: [${matched.join(", ")}]`);
  }

  if (unmatched.length > 0) {
    summary.log.push(`! languages not found in Foundry: [${unmatched.join(", ")}]`);
  }
}

/**
 * Imports attribute boosts from Demiplane and applies them.
 */
export async function applyAttributeBoosts(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
): Promise<void> {
  const boostEngines = engines.filter(
    (e) => e.name === "core/selection/attribute/boost.eng" && e.args?.slug,
  );

  const attrMap: Record<string, string> = {
    strength: "str", dexterity: "dex", constitution: "con",
    intelligence: "int", wisdom: "wis", charisma: "cha",
  };

  const ancestryBoosts: string[] = [];
  const backgroundBoosts: string[] = [];
  const levelBoosts: Record<string, string[]> = {};

  for (const eng of boostEngines) {
    const slug = attrMap[eng.args.slug as string] || (eng.args.slug as string);
    const sourceRow = (eng.args.sourceRow as string) || "";

    if (sourceRow === "ancestry-boosts") {
      ancestryBoosts.push(slug);
    } else if (sourceRow === "background-boosts") {
      backgroundBoosts.push(slug);
    } else if (sourceRow === "class-key-attribute") {
      // Handled by Grant Chain
    } else {
      const levelMatch = sourceRow.match(/attribute-boosts-level-(\d+)/);
      if (levelMatch) {
        const level = levelMatch[1];
        if (!levelBoosts[level]) levelBoosts[level] = [];
        levelBoosts[level].push(slug);
      }
    }
  }

  const ancestryItem = actor.items.find((i: { type: string }) => i.type === "ancestry");
  if (ancestryItem && ancestryBoosts.length > 0) {
    const updates: Record<string, string> = {};
    ancestryBoosts.forEach((slug, i) => { updates[`system.boosts.${i}.selected`] = slug; });
    await ancestryItem.update(updates);
    summary.log.push(`+ boosts: ancestry [${ancestryBoosts.join(", ")}]`);
  }

  const backgroundItem = actor.items.find((i: { type: string }) => i.type === "background");
  if (backgroundItem && backgroundBoosts.length > 0) {
    const updates: Record<string, string> = {};
    backgroundBoosts.forEach((slug, i) => { updates[`system.boosts.${i}.selected`] = slug; });
    await backgroundItem.update(updates);
    summary.log.push(`+ boosts: background [${backgroundBoosts.join(", ")}]`);
  }

  if (Object.keys(levelBoosts).length > 0) {
    const updates: Record<string, string[]> = {};
    for (const [level, boosts] of Object.entries(levelBoosts)) {
      updates[`system.build.attributes.boosts.${level}`] = boosts;
    }
    await actor.update(updates);
    summary.log.push(`+ boosts: levels [${Object.entries(levelBoosts).map(([l, b]) => `L${l}:${b.join(",")}`).join("; ")}]`);
  }
}
