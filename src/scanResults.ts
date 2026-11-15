import type * as VSCode from "vscode";
import { getRule } from "./accessibility/rules";
import type { AccessibilityIssue, IssueSeverity, ScanOutcome } from "./types/accessibility";
import type { IssueContext, ScanSnapshot } from "./types/scannerIntegration";

/** One entry per URI, shared by current-page and repository scanning. */
export function createScanResults(api: typeof VSCode) {
  const diagnostics = api.languages.createDiagnosticCollection("ops-aoda");
  const snapshots = new Map<string, ScanSnapshot>();
  const contexts = new Map<string, IssueContext>();
  let disposed = false;
  const changes = new api.EventEmitter<string>();
  const attempts = new Map<string, symbol>();
  function begin(fileUri: string): symbol {
    const token = Symbol(fileUri);
    attempts.set(fileUri, token);
    return token;
  }
  const severities: Record<IssueSeverity, VSCode.DiagnosticSeverity> = {
    error: api.DiagnosticSeverity.Error,
    warning: api.DiagnosticSeverity.Warning,
    info: api.DiagnosticSeverity.Information,
  };

  function remove(fileUri: string, notify = true): void {
    if (disposed) return;
    attempts.delete(fileUri);
    for (const issue of snapshots.get(fileUri)?.issues ?? []) contexts.delete(issue.id);
    snapshots.delete(fileUri);
    diagnostics.delete(api.Uri.parse(fileUri));
    if (notify) changes.fire(fileUri);
  }

  return {
    begin,
    isCurrent: (fileUri: string, token: symbol) => !disposed && attempts.get(fileUri) === token,
    onDidChange: changes.event,
    set(document: VSCode.TextDocument, input: readonly AccessibilityIssue[] | ScanOutcome): ScanSnapshot {
      const outcome: ScanOutcome = Array.isArray(input) ? { status: "analyzed", issues: input } : input as ScanOutcome;
      const issues = outcome.issues;
      if (disposed) throw new Error("Scan results have been disposed.");
      const snapshot = Object.freeze({
        ...outcome,
        fileUri: document.uri.toString(),
        documentVersion: document.version,
        issues: Object.freeze(issues.map((issue) => Object.freeze({
          ...issue,
          range: Object.freeze({ ...issue.range }),
          wcagCriteria: Object.freeze([...issue.wcagCriteria]),
        }))),
      }) as ScanSnapshot;
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
      remove(snapshot.fileUri, false);
      diagnostics.set(document.uri, entries);
      snapshots.set(snapshot.fileUri, snapshot);
      for (const details of nextContexts) contexts.set(details.issue.id, details);
      changes.fire(snapshot.fileUri);
      return snapshot;
    },
    remove,
    clear() {
      const files = [...snapshots.keys()];
      attempts.clear();
      diagnostics.clear();
      snapshots.clear();
      contexts.clear();
      for (const fileUri of files) changes.fire(fileUri);
    },
    getSnapshot: (fileUri: string) => snapshots.get(fileUri),
    getSnapshots: (): readonly ScanSnapshot[] => [...snapshots.values()],
    getTrackedFiles: () => [...new Set([...attempts.keys(), ...snapshots.keys()])],
    getIssueContext: (issueId: string) => contexts.get(issueId),
    dispose() { disposed = true; attempts.clear(); changes.dispose(); diagnostics.dispose(); snapshots.clear(); contexts.clear(); },
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
    for (const fileUri of results.getTrackedFiles()) {
      const uri = api.Uri.parse(fileUri);
      if (event.files.some((deleted) => uri.scheme === deleted.scheme && uri.authority === deleted.authority &&
        (uri.path === deleted.path || uri.path.startsWith(deleted.path.replace(/\/$/, "") + "/")))) {
        results.remove(fileUri);
      }
    }
  }));
  return results;
}
