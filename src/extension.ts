import * as vscode from "vscode";
import { registerCurrentPageScanning } from "./currentPageScanning";
import { registerIssuePresentation } from "./issuePresentation";
import { registerAgentUI } from "./agentUI";
import type { ScannerIntegration } from "./types/scannerIntegration";

export function activate(context: vscode.ExtensionContext): ScannerIntegration {
  const scanner = registerCurrentPageScanning(vscode, context);
  registerIssuePresentation(vscode, context, scanner);
  registerAgentUI(vscode, context, scanner);
  return scanner;
}
