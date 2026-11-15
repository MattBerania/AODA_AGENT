import { extname } from "node:path";
import type * as VSCode from "vscode";
import { scanAccessibility } from "./accessibility/scanner";
import { createScanResults, type ScanResults } from "./scanResults";
import type { AccessibilityIssue } from "./types/accessibility";
import type { ScannerIntegration, ScanSnapshot } from "./types/scannerIntegration";

export const SCAN_CURRENT_PAGE_COMMAND = "opsAoda.scanCurrentPage";
export const SCAN_DEBOUNCE_MS = 400;

function isSupportedDocument(document: VSCode.TextDocument | undefined): document is VSCode.TextDocument {
  if (!document || document.isClosed) return false;
  return [".html", ".cshtml"].includes(extname(document.uri.path).toLowerCase());
}

/** The VS Code API is passed in so the command can also run in plain Node tests. */
export function registerCurrentPageScanning(
  api: typeof VSCode,
  context: Pick<VSCode.ExtensionContext, "subscriptions">,
  workspaceResults?: ScanResults,
): ScannerIntegration {
  const results = workspaceResults ?? createScanResults(api);
  if (!workspaceResults) context.subscriptions.push(results);
  const changes = new api.EventEmitter<ScanSnapshot | undefined>();
  let latestScan: ScanSnapshot | undefined;
  let pendingScan: ReturnType<typeof setTimeout> | undefined;
  let scheduledDocument: VSCode.TextDocument | undefined;
  let disposed = false;
  function scanDocument(document: VSCode.TextDocument, notify: boolean): AccessibilityIssue[] {
    if (disposed) return [];
    if (!workspaceResults) results.clear();
    latestScan = undefined;
    try {
      const issues = scanAccessibility(document.getText(), document.uri.toString());
      const snapshot = results.set(document, issues);
      latestScan = snapshot;
      changes.fire(snapshot);
      if (notify) {
        const message = issues.length === 0
          ? "No confirmed findings in supported markup. Unsupported Razor or malformed HTML may have been skipped."
          : `OPS AODA found ${issues.length} accessibility ${issues.length === 1 ? "finding" : "findings"}. See Problems for details.`;
        void api.window.showInformationMessage(message);
      }
      return issues;
    } catch (error) {
      if (workspaceResults) results.remove(document.uri.toString());
      else results.clear();
      latestScan = undefined;
      changes.fire(undefined);
      const detail = error instanceof Error ? error.message : "Unexpected scanner error.";
      void api.window.showErrorMessage(`OPS AODA could not scan the current page: ${detail}`);
      return [];
    }
  }

  function cancelPendingScan(): void {
    if (pendingScan !== undefined) clearTimeout(pendingScan);
    pendingScan = undefined;
    scheduledDocument = undefined;
  }

  function invalidateResults(): void {
    if (!workspaceResults) results.clear();
    const hadSnapshot = latestScan !== undefined;
    latestScan = undefined;
    if (hadSnapshot) changes.fire(undefined);
  }

  function scheduleScan(document: VSCode.TextDocument | undefined): void {
    cancelPendingScan();
    if (disposed || !isSupportedDocument(document)) return;
    scheduledDocument = document;
    pendingScan = setTimeout(() => {
      pendingScan = undefined;
      scheduledDocument = undefined;
      // A queued callback must still belong to the current, open editor buffer.
      if (disposed || document.isClosed || api.window.activeTextEditor?.document !== document) return;
      scanDocument(document, false);
    }, SCAN_DEBOUNCE_MS);
  }

  const command = api.commands.registerCommand(SCAN_CURRENT_PAGE_COMMAND, (): AccessibilityIssue[] => {
    cancelPendingScan();
    const document = api.window.activeTextEditor?.document;
    if (!document) {
      void api.window.showInformationMessage("Open an .html or .cshtml document to scan.");
      return [];
    }
    if (!isSupportedDocument(document)) {
      void api.window.showWarningMessage("Current-page scanning supports .html and .cshtml documents.");
      return [];
    }
    return scanDocument(document, true);
  });

  const edits = api.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0 || event.document !== api.window.activeTextEditor?.document ||
      !isSupportedDocument(event.document)) return;
    if (workspaceResults) results.remove(event.document.uri.toString());
    invalidateResults();
    scheduleScan(event.document);
  });
  const activeEditor = api.window.onDidChangeActiveTextEditor((editor) => {
    const document = editor?.document;
    // Selecting an issue in an already-scanned editor should retain its details.
    if (document && latestScan?.fileUri === document.uri.toString() &&
      latestScan.documentVersion === document.version) return;
    invalidateResults();
    scheduleScan(document);
  });
  const closedDocuments = api.workspace.onDidCloseTextDocument((document) => {
    if (scheduledDocument === document) cancelPendingScan();
    if (latestScan?.fileUri === document.uri.toString()) invalidateResults();
  });

  context.subscriptions.push(command, edits, activeEditor, closedDocuments, {
    dispose() {
      disposed = true;
      cancelPendingScan();
      latestScan = undefined;
      changes.dispose();
    },
  });
  scheduleScan(api.window.activeTextEditor?.document);
  return {
    onDidChangeScan: changes.event,
    getLatestScan: () => latestScan,
    getIssueContext: (issueId) => results.getIssueContext(issueId),
    refreshCurrentPage() {
      cancelPendingScan();
      const document = api.window.activeTextEditor?.document;
      if (disposed || !isSupportedDocument(document)) return undefined;
      scanDocument(document, false);
      return latestScan;
    },
  };
}
