import { exportMappings, importMappings, parseMappingsExport, type MappingsImportResult } from "./slug-mapping.js";

/**
 * Cross-world sharing of the Demiplane slug-mapping table: an "export
 * everything to a file" action and an "import from a file" action that merges
 * what resolves in this world. Kept separate from the mapping editor UI so the
 * editor module stays focused on rendering the table.
 */

/** The download filename for an exported mapping set, stamped with the world id. */
function exportFilename(): string {
  const worldId = (game as { world?: { id?: string } }).world?.id ?? "world";
  return `demiplane-mappings-${worldId}.json`;
}

/**
 * "Export" toolbar action: writes every mapping to a JSON file the GM can load
 * into another world. Notifies (rather than writing an empty file) when there
 * is nothing to export.
 */
export async function exportAction(): Promise<void> {
  const data = exportMappings();
  const count = Object.values(data.mappings).reduce((sum, forKind) => sum + Object.keys(forKind ?? {}).length, 0);
  if (count === 0) {
    ui.notifications.info("No mappings to export yet.");
    return;
  }

  foundry.utils.saveDataToFile(JSON.stringify(data, null, 2), "application/json", exportFilename());
  ui.notifications.info(`Exported ${count} mapping${count === 1 ? "" : "s"}.`);
}

/**
 * "Import" toolbar action: asks for a file and whether to overwrite existing
 * mappings, merges what resolves in this world, and reports what was skipped.
 *
 * @param onImported - Called after a successful merge so the caller can refresh
 *   any open editor. Kept as a callback so this module doesn't depend on the
 *   editor app.
 */
export async function importAction(onImported: () => void): Promise<void> {
  const choice = await promptImport();
  if (!choice) return;

  const parsed = parseMappingsExport(choice.text);
  if (!parsed) {
    ui.notifications.error("That file isn't a valid Demiplane mappings export.");
    return;
  }

  const result = await importMappings(parsed, { overwrite: choice.overwrite });
  onImported();
  await showImportSummary(result);
}

/** The file text and overwrite choice from the import prompt, or null if cancelled. */
interface ImportChoice {
  text: string;
  overwrite: boolean;
}

/**
 * Prompts for a mapping file and the overwrite option, returning the file's text
 * and the choice. Returns null when the GM cancels or picks no file.
 */
async function promptImport(): Promise<ImportChoice | null> {
  // The Import button's `callback` produces the dialog's resolved value: it reads
  // the chosen file and the overwrite flag from the form. Returning null (no file
  // picked) or dismissing the dialog both resolve to a non-choice.
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: "Import Demiplane Mappings" },
    content:
      `<div style="max-width:26em;">` +
      `<p>Load mappings exported from another world. Mappings whose target item doesn't exist in this world are skipped.</p>` +
      `<p><input type="file" name="file" accept="application/json,.json" /></p>` +
      `<p><label><input type="checkbox" name="overwrite" /> Overwrite existing mappings</label></p>` +
      `</div>`,
    buttons: [
      {
        action: "import",
        label: "Import",
        icon: "fa-solid fa-file-import",
        default: true,
        callback: readImportChoice,
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" },
    ],
  });

  return isImportChoice(result) ? result : null;
}

/** Reads the file text and overwrite flag from the import dialog's form. */
async function readImportChoice(
  _event: Event,
  _button: HTMLButtonElement,
  dialog: foundry.applications.api.DialogV2
): Promise<ImportChoice | null> {
  const form = dialog.element;
  const file = form.querySelector<HTMLInputElement>('input[name="file"]')?.files?.[0];
  if (!file) {
    ui.notifications.warn("Choose a file to import.");
    return null;
  }
  const overwrite = form.querySelector<HTMLInputElement>('input[name="overwrite"]')?.checked ?? false;
  return { text: await file.text(), overwrite };
}

/** Narrows a DialogV2 result to a well-formed import choice. */
function isImportChoice(result: unknown): result is ImportChoice {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as ImportChoice).text === "string" &&
    typeof (result as ImportChoice).overwrite === "boolean"
  );
}

/** Shows the post-import summary: what was written and what was skipped and why. */
async function showImportSummary(result: MappingsImportResult): Promise<void> {
  const lines = [`<p>Imported <strong>${result.imported}</strong> mapping${result.imported === 1 ? "" : "s"}.</p>`];

  if (result.skippedExisting > 0) {
    lines.push(`<p>Skipped ${result.skippedExisting} already mapped in this world.</p>`);
  }

  if (result.skippedMissing > 0) {
    const extra = result.skippedMissing - result.missingSamples.length;
    const sample = result.missingSamples.map((entry) => `<li>${entry}</li>`).join("");
    const more = extra > 0 ? `<li>…and ${extra} more</li>` : "";
    lines.push(`<p>Excluded ${result.skippedMissing} that don't exist in this world:</p><ul>${sample}${more}</ul>`);
  }

  await foundry.applications.api.DialogV2.prompt({
    window: { title: "Mappings Imported" },
    content: `<div style="max-width:26em;">${lines.join("")}</div>`,
    ok: { label: "Close" },
  });
}
