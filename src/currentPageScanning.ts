import { extname } from "node:path";
import type * as VSCode from "vscode";
import { scanAccessibility } from "./accessibility/scanner";
import type { AccessibilityIssue, IssueSeverity } from "./types/accessibility";

export const SCAN_CURRENT_PAGE_COMMAND = "opsAoda.scanCurrentPage";

/** The VS Code API is passed in so the command can also run in plain Node tests. */
export function registerCurrentPageScanning(
  api: typeof VSCode,
  context: Pick<VSCode.ExtensionContext, "subscriptions">,
): void {
  const diagnostics = api.languages.createDiagnosticCollection("ops-aoda");
  const severities: Record<IssueSeverity, VSCode.DiagnosticSeverity> = {
    error: api.DiagnosticSeverity.Error,
    warning: api.DiagnosticSeverity.Warning,
    info: api.DiagnosticSeverity.Information,
  };

  const command = api.commands.registerCommand(SCAN_CURRENT_PAGE_COMMAND, (): AccessibilityIssue[] => {
    const document = api.window.activeTextEditor?.document;
    if (!document) {
      void api.window.showInformationMessage("Open an .html or .cshtml document to scan.");
      return [];
    }
    const extension = extname(document.uri.path).toLowerCase();
    if (extension !== ".html" && extension !== ".cshtml") {
      void api.window.showWarningMessage("Current-page scanning supports .html and .cshtml documents.");
      return [];
    }

    // Each invocation displays a snapshot of just the requested current page.
    diagnostics.clear();
    try {
      const issues = scanAccessibility(document.getText(), document.uri.toString());
      const entries = issues.map((issue) => {
        const range = new api.Range(
          issue.range.startLine, issue.range.startCharacter,
          issue.range.endLine, issue.range.endCharacter,
        );
        const diagnostic = new api.Diagnostic(range, issue.message, severities[issue.severity]);
        diagnostic.source = "OPS AODA";
        diagnostic.code = issue.ruleId;
        return diagnostic;
      });
      diagnostics.set(document.uri, entries);
      const message = issues.length === 0
        ? "No confirmed findings in supported markup. Unsupported Razor or malformed HTML may have been skipped."
        : `OPS AODA found ${issues.length} accessibility ${issues.length === 1 ? "finding" : "findings"}. See Problems for details.`;
      void api.window.showInformationMessage(message);
      return issues;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected scanner error.";
      void api.window.showErrorMessage(`OPS AODA could not scan the current page: ${detail}`);
      return [];
    }
  });

  context.subscriptions.push(diagnostics, command);
}
