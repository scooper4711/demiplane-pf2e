/**
 * ChoiceSet resolution package: the choice-set driver, its matcher registry,
 * built-in strategies, class-specific configs, and per-actor user overrides.
 * Depends only on core, shared, and (for item creation) the compendium seam.
 */
export * from "./choice-set-types.js";
export * from "./choice-slug.js";
export * from "./matcher-registry.js";
export * from "./choice-matchers.js";
export * from "./choice-overrides.js";
export * from "./grant-builder-matchers.js";
export * from "./kineticist-matchers.js";
export * from "./class-choice-config.js";
export * from "./ikon-weapon-matcher.js";
export * from "./ikon-weapon-resolver.js";
export * from "./choice-set-handler.js";
