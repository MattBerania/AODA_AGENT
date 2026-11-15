import type * as VSCode from "vscode";
import { getRule } from "./accessibility/rules";
import type { AccessibilityIssue, IssueSeverity } from "./types/accessibility";
import type { IssueContext, ScanSnapshot } from "./types/scannerIntegration";

/** One entry per URI, shared by current-page and repository scanning. */
export function createScanResults(api: typeof VSCode) {
  const diagnostics = api.languages.createDiagnosticCollection("ops-aoda");
  const snapshots = new Map<string, ScanSnapshot>();
  const contexts = new Map<string, IssueContext>();
  let disposed = false;
  const severities: Record<IssueSeverity, VSCode.DiagnosticSeverity> = {
    error: api.DiagnosticSeverity.Error,
    warning: api.DiagnosticSeverity.Warning,
    info: api.DiagnosticSeverity.Information,
  };

  function remove(fileUri: string): void {
    if (disposed) return;
    for (const issue of snapshots.get(fileUri)?.issues ?? []) contexts.delete(issue.id);
    snapshots.delete(fileUri);
    diagnostics.delete(api.Uri.parse(fileUri));
  }

  return {
    set(document: VSCode.TextDocument, issues: readonly AccessibilityIssue[]): ScanSnapshot {
      if (disposed) throw new Error("Scan results have been disposed.");
      const snapshot: ScanSnapshot = Object.freeze({
        fileUri: document.uri.toString(),
        documentVersion: document.version,
        issues: Object.freeze(issues.map((issue) => Object.freeze({
          ...issue,
          range: Object.freeze({ ...issue.range }),
          wcagCriteria: Object.freeze([...issue.wcagCriteria]),
        }))),
      });
      // Prepare everything before replacing the previous entry.
      const nextContexts: IssueContext[] = [];
      const entries = snapshot.issues.map((issue) => {
        const range = new api.Range(issue.range.startLine, issue.range.startCharacter,
          issue.range.endLine, issue.range.endCharacter);
        const diagnostic = new api.Diagnostic(range, issue.message, severities[issue.severity]);
        diagnostic.source = "OPS AODA";
        diagnostic.code = issue.ruleId;
        const rule = getRule(issue.ruleId);
        if (!rule) throw new Error(`Missing ${issue.ruleId} rule metadata`);
        nextContexts.push(Object.freeze({
          issue,
          rule: Object.freeze({ ...rule, wcagCriteria: Object.freeze([...rule.wcagCriteria]) }),
          originalText: document.getText(range),
          documentVersion: snapshot.documentVersion,
        }));
        return diagnostic;
      });
      remove(snapshot.fileUri);
      diagnostics.set(document.uri, entries);
      snapshots.set(snapshot.fileUri, snapshot);
      for (const details of nextContexts) contexts.set(details.issue.id, details);
      return snapshot;
    },
    remove,
    clear() { diagnostics.clear(); snapshots.clear(); contexts.clear(); },
    getSnapshot: (fileUri: string) => snapshots.get(fileUri),
    getSnapshots: (): readonly ScanSnapshot[] => [...snapshots.values()],
    getIssueContext: (issueId: string) => contexts.get(issueId),
    dispose() { disposed = true; diagnostics.dispose(); snapshots.clear(); contexts.clear(); },
  };
}

export type ScanResults = ReturnType<typeof createScanResults>;

/** Own workspace-wide lifetime and invalidate findings when source changes. */
export function registerWorkspaceScanResults(
  api: typeof VSCode,
  context: Pick<VSCode.ExtensionContext, "subscriptions">,
): ScanResults {
  const results = createScanResults(api);
  context.subscriptions.push(results, api.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length > 0) results.remove(event.document.uri.toString());
  }), api.workspace.onDidDeleteFiles((event) => {
    for (const snapshot of results.getSnapshots()) {
      const uri = api.Uri.parse(snapshot.fileUri);
      if (event.files.some((deleted) => uri.scheme === deleted.scheme && uri.authority === deleted.authority &&
        (uri.path === deleted.path || uri.path.startsWith(deleted.path.replace(/\/$/, "") + "/")))) {
        results.remove(snapshot.fileUri);
      }
    }
  }));
  return results;
}
