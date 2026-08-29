/**
 * Produces a stable signature of a character's engine content so the push path
 * can tell a genuine remote edit apart from a benign `updated` bump (e.g. the
 * Demiplane sheet being open or an autosave). Only engine name/value pairs are
 * compared, since those are what this module actually reads and writes.
 *
 * Object values are serialized with sorted keys so semantically-equal engines
 * produce the same signature regardless of property insertion order.
 */
export function computeEngineSig(engines: Array<{ name?: string; value?: unknown }>): string {
  const stable = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v !== "object") return JSON.stringify(v);
    try {
      return JSON.stringify(v, Object.keys(v as object).sort());
    } catch {
      return String(v);
    }
  };
  return engines
    .map((e) => `${e.name ?? ""}=${stable(e.value ?? null)}`)
    .sort()
    .join("|");
}
