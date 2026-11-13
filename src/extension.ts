import * as vscode from "vscode";
import { registerCurrentPageScanning } from "./currentPageScanning";
import { registerIssuePresentation } from "./issuePresentation";
import type { ScannerIntegration } from "./types/scannerIntegration";

export function activate(context: vscode.ExtensionContext): ScannerIntegration {
  const scanner = registerCurrentPageScanning(vscode, context);
  registerIssuePresentation(vscode, context, scanner);
  return scanner;
}
