import * as vscode from "vscode";
import { registerCurrentPageScanning } from "./currentPageScanning";
import { registerRepositoryScanning } from "./repositoryScanning";
import { registerWorkspaceScanResults } from "./scanResults";
import { registerIssuePresentation } from "./issuePresentation";
import { registerAgentUI } from "./agentUI";
import { registerAgentSidebar } from "./agentSidebar";
import type { ScannerIntegration } from "./types/scannerIntegration";

export function activate(context: vscode.ExtensionContext): ScannerIntegration {
  const results = registerWorkspaceScanResults(vscode, context);
  const scanner = registerCurrentPageScanning(vscode, context, results);
  registerRepositoryScanning(vscode, context, results);
  registerIssuePresentation(vscode, context, scanner);
  registerAgentUI(vscode, context, scanner);
  registerAgentSidebar(vscode, context);
  return scanner;
}
