import type * as VSCode from "vscode";
import { scanAccessibilityOutcome } from "./accessibility/scanner";
import type { ScanOutcome } from "./types/accessibility";
import type { ScanSnapshot } from "./types/scannerIntegration";
import type { ScanResults } from "./scanResults";

export interface RepositoryScanResult {
  readonly outcomes: readonly (ScanOutcome & { readonly fileUri: string })[];
  readonly snapshots: readonly ScanSnapshot[];
  readonly failures: readonly { readonly fileUri: string; readonly message: string }[];
}

/** Open documents without showing editors; an already-open document includes unsaved edits. */
export async function scanRepositoryFiles(
  api: typeof VSCode,
  files: readonly VSCode.Uri[],
  results?: ScanResults,
): Promise<RepositoryScanResult> {
  const snapshots: ScanSnapshot[] = [];
  const failures: { fileUri: string; message: string }[] = [];
  const outcomes: (ScanOutcome & { fileUri: string })[] = [];
  for (const uri of files) {
    const token = results?.begin(uri.toString());
    let document: VSCode.TextDocument | undefined;
    try {
      document = await api.workspace.openTextDocument(uri);
      if (results && !results.isCurrent(uri.toString(), token!)) {
        outcomes.push({ fileUri: uri.toString(), status: "skipped", issues: [], reason: "Superseded by a newer scan or source change." });
        continue;
      }
      const version = document.version;
      const outcome = scanAccessibilityOutcome(document.getText(), document.uri.toString());
      if (document.isClosed || document.version !== version) {
        outcomes.push({ fileUri: uri.toString(), status: "skipped", issues: [], reason: "Document changed or closed during analysis." });
        continue;
      }
      if (outcome.status === "failed") throw new Error(outcome.reason);
      snapshots.push(results ? results.set(document, outcome) : {
        fileUri: document.uri.toString(),
        documentVersion: document.version,
        ...outcome,
      });
      outcomes.push({ ...outcome, fileUri: uri.toString() });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unexpected file scan error.";
      if (results && results.isCurrent(uri.toString(), token!)) {
        if (document) results.set(document, { status: "failed", issues: [], reason });
        else results.remove(uri.toString());
      }
      outcomes.push({ fileUri: uri.toString(), status: "failed", issues: [], reason });
      failures.push({
        fileUri: uri.toString(),
        message: error instanceof Error ? error.message : "Unexpected file scan error.",
      });
    }
  }
  return { snapshots, failures, outcomes };
}

export async function discoverSupportedFiles(
  api: typeof VSCode,
): Promise<VSCode.Uri[]> {
  return api.workspace.findFiles(
    "**/*.{[hH][tT][mM][lL],[cC][sS][hH][tT][mM][lL]}",
    "**/{node_modules,bin,obj,dist,.git,.vs}/**",
  );
}

export const SCAN_REPOSITORY_COMMAND = "opsAoda.scanRepository";

export function registerRepositoryScanning(
  api: typeof VSCode,
  context: Pick<VSCode.ExtensionContext, "subscriptions">,
  results?: ScanResults,
): void {
  let running = false;
  let previousFiles = new Set<string>();
  const command = api.commands.registerCommand(
    SCAN_REPOSITORY_COMMAND,
    async (): Promise<void> => {
      if (running) {
        await api.window.showInformationMessage("A repository scan is already running.");
        return;
      }
      const folders = api.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        await api.window.showInformationMessage(
          "Open a workspace folder to discover supported files.",
        );
        return;
      }

      running = true;
      try {
        const files = await discoverSupportedFiles(api);
        const currentFiles = new Set(files.map((uri) => uri.toString()));
        for (const fileUri of previousFiles) {
          if (!currentFiles.has(fileUri)) results?.remove(fileUri);
        }
        previousFiles = currentFiles;
        const result = await scanRepositoryFiles(api, files, results);
        const analyzed = result.outcomes.filter((entry) => entry.status === "analyzed").length;
        const skipped = result.outcomes.filter((entry) => entry.status === "skipped").length;
        const findings = result.snapshots.reduce((total, snapshot) => total + snapshot.issues.length, 0);
        await api.window.showInformationMessage(
          `OPS AODA: ${files.length} files discovered, ${result.snapshots.length} processed, ` +
          `${findings} confirmed findings, ${result.failures.length} failed. ` +
          `Files attempted ${result.outcomes.length}, analyzed ${analyzed}, skipped ${skipped}. ` +
          (skipped || result.failures.length ? "Coverage is incomplete. " : "") +
          "Results cover the implemented static checks. See Problems for findings.",
        );
        if (result.outcomes.some((entry) => entry.status !== "analyzed")) {
          await api.window.showWarningMessage(
            "OPS AODA could not process:\n" + result.outcomes.filter((entry) => entry.status !== "analyzed").map((entry) =>
              `${entry.fileUri}: ${entry.reason}`).join("\n"),
          );
        }
      } catch (error) {
        const detail = error instanceof Error
          ? error.message
          : "Unexpected file discovery error.";
        await api.window.showErrorMessage(
          `OPS AODA could not scan workspace files: ${detail}`,
        );
      } finally {
        running = false;
      }
    },
  );

  context.subscriptions.push(command);
}

