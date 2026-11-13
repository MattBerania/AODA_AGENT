import * as vscode from "vscode";
import { registerCurrentPageScanning } from "./currentPageScanning";

export function activate(context: vscode.ExtensionContext): void {
  registerCurrentPageScanning(vscode, context);
}
