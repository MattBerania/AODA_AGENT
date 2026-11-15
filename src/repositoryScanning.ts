import type * as VSCode from "vscode";
import { scanAccessibility } from "./accessibility/scanner";
import type { ScanSnapshot } from "./types/scannerIntegration";
import type { ScanResults } from "./scanResults";

export interface RepositoryScanResult {
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
  for (const uri of files) {
    try {
      const document = await api.workspace.openTextDocument(uri);
      const issues = scanAccessibility(document.getText(), document.uri.toString());
      snapshots.push(results ? results.set(document, issues) : {
        fileUri: document.uri.toString(),
        documentVersion: document.version,
        issues,
      });
    } catch (error) {
      results?.remove(uri.toString());
      failures.push({
        fileUri: uri.toString(),
        message: error instanceof Error ? error.message : "Unexpected file scan error.",
      });
    }
  }
  return { snapshots, failures };
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
        const findings = result.snapshots.reduce((total, snapshot) => total + snapshot.issues.length, 0);
        await api.window.showInformationMessage(
          `OPS AODA: ${files.length} files discovered, ${result.snapshots.length} processed, ` +
          `${findings} confirmed findings, ${result.failures.length} failed. ` +
          "See Problems for findings. Unsupported Razor or malformed HTML may have been skipped.",
        );
        if (result.failures.length > 0) {
          await api.window.showWarningMessage(
            "OPS AODA could not process:\n" + result.failures.map((failure) =>
              `${failure.fileUri}: ${failure.message}`).join("\n"),
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

