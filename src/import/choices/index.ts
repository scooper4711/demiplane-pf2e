/**
 * ChoiceSet resolution package: the choice-set driver, its matcher registry,
 * built-in strategies, class-specific configs, and per-actor user overrides.
 * Depends only on core and shared (via its barrel).
 */
export { localizeChoiceLabel } from "./choice-overrides.js";
export { ChoiceSetHandler, formatChoiceSetFallback } from "./choice-set-handler.js";
