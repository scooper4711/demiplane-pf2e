/**
 * Architecture enforcement for the src/ package layout.
 *
 * Two invariants keep each package's public surface minimal:
 *  1. Barrel discipline — every cross-package import must target the owning
 *     package's index.ts barrel, never a deep file. The barrel then *is* the
 *     public surface (curated named exports, not `export *`).
 *  2. Layering — core <- sync/export/mapping <- import <- ui, with the import
 *     driver (import/*.ts) above its domain sub-packages, which sit above
 *     import/shared. sync/sync-flows.ts is the single documented bridge
 *     allowed to reach into import/ and export/.
 *
 * Run with `npm run check:deps`. Only src/ is cruised; tests import deep
 * paths deliberately and are out of scope.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- 1. Barrel discipline: no deep cross-package imports ---
    {
      name: "no-deep-imports-into-core",
      severity: "error",
      from: { pathNot: "src/core" },
      to: { path: "src/core/.+\\.ts$", pathNot: "src/core/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-sync",
      severity: "error",
      from: { pathNot: "src/sync" },
      to: { path: "src/sync/.+\\.ts$", pathNot: "src/sync/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-export",
      severity: "error",
      from: { pathNot: "src/export" },
      to: { path: "src/export/.+\\.ts$", pathNot: "src/export/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-mapping",
      severity: "error",
      from: { pathNot: "src/mapping" },
      to: { path: "src/mapping/.+\\.ts$", pathNot: "src/mapping/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-ui",
      severity: "error",
      from: { pathNot: "src/ui" },
      to: { path: "src/ui/.+\\.ts$", pathNot: "src/ui/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-flows",
      severity: "error",
      from: { pathNot: "src/flows" },
      to: { path: "src/flows/.+\\.ts$", pathNot: "src/flows/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-import-root",
      severity: "error",
      comment: "The import driver (orchestrator/phases/...) is consumed via src/import/index.ts only.",
      from: { pathNot: "src/import" },
      to: { path: "src/import/[^/]+\\.ts$", pathNot: "src/import/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-import-choices",
      severity: "error",
      from: { pathNot: "src/import/choices" },
      to: { path: "src/import/choices/.+\\.ts$", pathNot: "src/import/choices/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-import-spells",
      severity: "error",
      from: { pathNot: "src/import/spells" },
      to: { path: "src/import/spells/.+\\.ts$", pathNot: "src/import/spells/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-import-equipment",
      severity: "error",
      from: { pathNot: "src/import/equipment" },
      to: { path: "src/import/equipment/.+\\.ts$", pathNot: "src/import/equipment/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-import-character",
      severity: "error",
      from: { pathNot: "src/import/character" },
      to: { path: "src/import/character/.+\\.ts$", pathNot: "src/import/character/index\\.ts$" },
    },
    {
      name: "no-deep-imports-into-import-shared",
      severity: "error",
      from: { pathNot: "src/import/shared" },
      to: { path: "src/import/shared/.+\\.ts$", pathNot: "src/import/shared/index\\.ts$" },
    },

    // --- 2. Layering: packages only depend inward ---
    {
      name: "core-is-foundation",
      severity: "error",
      from: { path: "src/core" },
      to: { path: "src/(sync|export|mapping|ui|import)/" },
    },
    {
      name: "sync-depends-inward",
      severity: "error",
      from: { path: "src/sync/" },
      to: { path: "src/(export|mapping|ui|import)/" },
    },
    {
      name: "flows-bridge-scope",
      severity: "error",
      comment: "The flows bridge sits above core/sync/import/export and reaches nothing else.",
      from: { path: "src/flows/" },
      to: { path: "src/(mapping|ui)/" },
    },
    {
      name: "export-depends-inward",
      severity: "error",
      from: { path: "src/export" },
      to: { path: "src/(mapping|ui|import)/" },
    },
    {
      name: "mapping-depends-inward",
      severity: "error",
      from: { path: "src/mapping" },
      to: { path: "src/(export|ui|import)/" },
    },
    {
      name: "import-driver-depends-inward",
      severity: "error",
      from: { path: "src/import/[^/]+\\.ts$" },
      to: { path: "src/(export|ui)/" },
    },
    {
      name: "import-shared-is-lowest",
      severity: "error",
      from: { path: "src/import/shared/" },
      to: { path: "src/(sync|export|ui)/|src/import/(choices|spells|equipment|character)/|src/import/[^/]+\\.ts$" },
    },
    {
      name: "import-choices-depends-inward",
      severity: "error",
      from: { path: "src/import/choices/" },
      to: { path: "src/(sync|export|mapping|ui)/|src/import/(spells|equipment|character)/|src/import/[^/]+\\.ts$" },
    },
    {
      name: "import-spells-depends-inward",
      severity: "error",
      from: { path: "src/import/spells/" },
      to: { path: "src/(sync|export|mapping|ui)/|src/import/(choices|equipment|character)/|src/import/[^/]+\\.ts$" },
    },
    {
      name: "import-character-depends-inward",
      severity: "error",
      from: { path: "src/import/character/" },
      to: { path: "src/(sync|export|ui)/|src/import/(choices|spells|equipment)/|src/import/[^/]+\\.ts$" },
    },
    {
      name: "import-equipment-depends-inward",
      severity: "error",
      from: { path: "src/import/equipment/" },
      to: { path: "src/(export|ui)/|src/import/(choices|spells|character)/|src/import/[^/]+\\.ts$" },
    },

    // --- 3. Hygiene ---
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
