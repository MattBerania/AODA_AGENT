import { basename } from "node:path";
import type * as VSCode from "vscode";
import type { ScannerIntegration } from "./types/scannerIntegration";

export const SHOW_SCAN_ISSUES_COMMAND = "opsAoda.showScanIssues";
export const SHOW_ISSUE_COMMAND = "opsAoda.showIssue";

/** Native issue selection and details, reading the same snapshot as consumers. */
export function registerIssuePresentation(
  api: typeof VSCode,
  context: Pick<VSCode.ExtensionContext, "subscriptions">,
  scanner: ScannerIntegration,
): void {
  const output = api.window.createOutputChannel("OPS AODA Issues");

  async function showIssue(issueId: unknown): Promise<void> {
    const snapshot = scanner.getLatestScan();
    const details = typeof issueId === "string" ? scanner.getIssueContext(issueId) : undefined;
    if (!snapshot || !details) {
      void api.window.showWarningMessage("That finding is unavailable. Run OPS AODA: Scan Current Page again.");
      return;
    }
    try {
      const document = await api.workspace.openTextDocument(api.Uri.parse(details.issue.fileUri));
      const position = details.issue.range;
      const range = new api.Range(
        position.startLine, position.startCharacter, position.endLine, position.endCharacter,
      );
      if (snapshot !== scanner.getLatestScan() || document.version !== details.documentVersion ||
        document.getText(range) !== details.originalText) {
        void api.window.showWarningMessage("The source or scan has changed. Run OPS AODA: Scan Current Page again.");
        return;
      }
      await api.window.showTextDocument(document, { selection: range, preview: true });
      output.replace([
        details.issue.title,
        `Rule: ${details.rule.id}`,
        `Category: ${details.rule.category}`,
        `Severity: ${details.issue.severity}`,
        `WCAG: ${details.rule.wcagCriteria.join(", ")}`,
        `File: ${details.issue.fileUri}`,
        `Location: ${position.startLine + 1}:${position.startCharacter + 1}`,
        `Document version: ${details.documentVersion}`,
        "", details.rule.description,
        "", "Remediation", details.rule.remediation,
        "", "Source at scan time", details.originalText,
      ].join("\n"));
      output.show(true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected presentation error.";
      void api.window.showErrorMessage(`OPS AODA could not show this finding: ${detail}`);
    }
  }

  const showIssues = api.commands.registerCommand(SHOW_SCAN_ISSUES_COMMAND, async (): Promise<void> => {
    const snapshot = scanner.getLatestScan();
    if (!snapshot) {
      void api.window.showInformationMessage("Run OPS AODA: Scan Current Page to populate the issue list.");
      return;
    }
    if (snapshot.issues.length === 0) {
      void api.window.showInformationMessage("The latest scan has no confirmed findings. Unsupported markup may have been skipped.");
      return;
    }
    try {
      const selection = await api.window.showQuickPick(snapshot.issues.map((issue) => ({
        label: issue.title,
        description: `${basename(api.Uri.parse(issue.fileUri).path)}:${issue.range.startLine + 1}`,
        detail: issue.message,
        issueId: issue.id,
      })), { title: "OPS AODA Scan Issues", matchOnDescription: true, matchOnDetail: true });
      if (!selection) return;
      if (snapshot !== scanner.getLatestScan()) {
        void api.window.showWarningMessage("The scan changed while selecting a finding. Open Show Scan Issues again.");
        return;
      }
      await showIssue(selection.issueId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected presentation error.";
      void api.window.showErrorMessage(`OPS AODA could not list scan issues: ${detail}`);
    }
  });

  context.subscriptions.push(output, scanner.onDidChangeScan(() => output.clear()), showIssues,
    api.commands.registerCommand(SHOW_ISSUE_COMMAND, showIssue));
}
