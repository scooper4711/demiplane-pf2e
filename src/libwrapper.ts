import { MODULE_ID } from "./import/types.js";

/**
 * Thin adapter over the community libWrapper module.
 *
 * libWrapper (https://github.com/ruipin/fvtt-lib-wrapper) mediates method
 * wrapping so multiple modules can wrap the same method without clobbering each
 * other. It is a very common Foundry dependency, but this module treats it as
 * optional: when present we route our single ChoiceSet patch through it (so we
 * chain politely with any other module and get conflict diagnostics), and when
 * absent we fall back to a direct prototype patch.
 *
 * This file isolates the untyped global surface so the rest of the codebase can
 * ask a single question — "is libWrapper available?" — and register/unregister
 * through typed helpers.
 */

/** libWrapper's wrapper types. We only ever use MIXED for our conditional patch. */
export type WrapperType = "WRAPPER" | "MIXED" | "OVERRIDE";

/** The next function in the wrapper chain (the original, or another module's wrapper). */
export type WrappedFn = (...args: unknown[]) => unknown;

/** A libWrapper wrapper: receives the next fn first, then the original call args. */
export type WrapperFn = (this: unknown, wrapped: WrappedFn, ...args: unknown[]) => unknown;

interface LibWrapperApi {
  register: (packageId: string, target: string, fn: WrapperFn, type: WrapperType) => number;
  unregister: (packageId: string, target: string) => void;
}

/**
 * Returns the libWrapper API only when the module is installed and active,
 * otherwise `null`. A registered-but-disabled libWrapper must not be used, so
 * the module's `active` flag is checked rather than merely the global existing.
 */
export function getLibWrapper(): LibWrapperApi | null {
  const active = game.modules.get("lib-wrapper")?.active === true;
  if (!active) return null;

  const api = (globalThis as unknown as { libWrapper?: LibWrapperApi }).libWrapper;
  return api ?? null;
}

/** Registers a MIXED wrapper scoped to this module's package id. */
export function registerWrapper(target: string, fn: WrapperFn): void {
  getLibWrapper()?.register(MODULE_ID, target, fn, "MIXED");
}

/** Removes this module's wrapper for the given target. */
export function unregisterWrapper(target: string): void {
  getLibWrapper()?.unregister(MODULE_ID, target);
}
