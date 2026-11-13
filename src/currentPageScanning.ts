import { extname } from "node:path";
import type * as VSCode from "vscode";
import { scanAccessibility } from "./accessibility/scanner";
import { getRule } from "./accessibility/rules";
import type { AccessibilityIssue, IssueSeverity } from "./types/accessibility";
import type { IssueContext, ScannerIntegration, ScanSnapshot } from "./types/scannerIntegration";

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
): ScannerIntegration {
  const diagnostics = api.languages.createDiagnosticCollection("ops-aoda");
  const changes = new api.EventEmitter<ScanSnapshot | undefined>();
  let latestScan: ScanSnapshot | undefined;
  const issueContexts = new Map<string, IssueContext>();
  let pendingScan: ReturnType<typeof setTimeout> | undefined;
  let scheduledDocument: VSCode.TextDocument | undefined;
  let disposed = false;
  const severities: Record<IssueSeverity, VSCode.DiagnosticSeverity> = {
    error: api.DiagnosticSeverity.Error,
    warning: api.DiagnosticSeverity.Warning,
    info: api.DiagnosticSeverity.Information,
  };

  function scanDocument(document: VSCode.TextDocument, notify: boolean): AccessibilityIssue[] {
    if (disposed) return [];
    diagnostics.clear();
    latestScan = undefined;
    issueContexts.clear();
    try {
      const issues = scanAccessibility(document.getText(), document.uri.toString());
      // Copy and freeze the shared snapshot so consumers cannot alter each
      // other's results or mutate catalog arrays through their findings.
      const snapshot: ScanSnapshot = Object.freeze({
        fileUri: document.uri.toString(),
        documentVersion: document.version,
        issues: Object.freeze(issues.map((issue) => Object.freeze({
          ...issue,
          range: Object.freeze({ ...issue.range }),
          wcagCriteria: Object.freeze([...issue.wcagCriteria]),
        }))),
      });
      const entries = snapshot.issues.map((issue) => {
        const range = new api.Range(
          issue.range.startLine, issue.range.startCharacter,
          issue.range.endLine, issue.range.endCharacter,
        );
        const diagnostic = new api.Diagnostic(range, issue.message, severities[issue.severity]);
        diagnostic.source = "OPS AODA";
        diagnostic.code = issue.ruleId;
        const rule = getRule(issue.ruleId);
        if (!rule) throw new Error(`Missing ${issue.ruleId} rule metadata`);
        issueContexts.set(issue.id, Object.freeze({
          issue,
          rule: Object.freeze({ ...rule, wcagCriteria: Object.freeze([...rule.wcagCriteria]) }),
          originalText: document.getText(range),
          documentVersion: snapshot.documentVersion,
        }));
        return diagnostic;
      });
      diagnostics.set(document.uri, entries);
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
      diagnostics.clear();
      latestScan = undefined;
      issueContexts.clear();
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
    diagnostics.clear();
    const hadSnapshot = latestScan !== undefined;
    latestScan = undefined;
    issueContexts.clear();
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

  context.subscriptions.push(diagnostics, command, edits, activeEditor, closedDocuments, {
    dispose() {
      disposed = true;
      cancelPendingScan();
      latestScan = undefined;
      issueContexts.clear();
      changes.dispose();
    },
  });
  scheduleScan(api.window.activeTextEditor?.document);
  return {
    onDidChangeScan: changes.event,
    getLatestScan: () => latestScan,
    getIssueContext: (issueId) => issueContexts.get(issueId),
    refreshCurrentPage() {
      cancelPendingScan();
      const document = api.window.activeTextEditor?.document;
      if (disposed || !isSupportedDocument(document)) return undefined;
      scanDocument(document, false);
      return latestScan;
    },
  };
}
