import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as VSCode from "vscode";
import type { ScannerIntegration } from "./types/scannerIntegration";

export const OPEN_AGENT_UI_COMMAND = "opsAoda.openAgentUI";

export function registerAgentUI(
    api: typeof VSCode,
    context: VSCode.ExtensionContext,
    scanner: ScannerIntegration,
): void {
    let panel: VSCode.WebviewPanel | undefined;
    function updateWebview() {
        if (!panel) {
            return;
        }
        const snapshot = scanner.getLatestScan();
        
        // FIX: Only clear the UI if a real text file is actively focused. 
        // If focus is in the Webview (activeTextEditor is undefined), freeze the current errors on screen.
        if (!snapshot) {
            if (api.window.activeTextEditor) {
                panel.webview.postMessage({ type: "SCAN_RESULTS", payload: [] });
            }
            return;
        }
        
        const payload = snapshot.issues.map(issue => {
            const issueCtx = scanner.getIssueContext(issue.id);
            return {
                issue: issueCtx?.issue,
                originalText: issueCtx?.originalText,
                rule: issueCtx?.rule,
            };
        });
        panel.webview.postMessage({ type: "SCAN_RESULTS", payload });
    }
    const command = api.commands.registerCommand(OPEN_AGENT_UI_COMMAND, () => {
        if (panel) {
            panel.reveal(api.ViewColumn.Beside, true);
            setTimeout(() => { updateWebview(); }, 250);
            return;
        }

        panel = api.window.createWebviewPanel(
            'aodaAgentUI',
            'AODA Agent UI',
            { viewColumn: api.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [api.Uri.file(join(context.extensionPath, 'prototype'))]
            }
        );

        const htmlPath = join(context.extensionPath, 'prototype', 'index.html');
        let html = readFileSync(htmlPath, 'utf8');
        const cssUri = panel.webview.asWebviewUri(api.Uri.file(join(context.extensionPath, 'prototype', 'CSS', 'AODA.css')));
        const jsUri = panel.webview.asWebviewUri(api.Uri.file(join(context.extensionPath, 'prototype', 'JS', 'AODA_Agent.js')));
        html = html.replace('CSS/AODA.css', cssUri.toString());
        html = html.replace('JS/AODA_Agent.js', jsUri.toString());
        
        panel.webview.html = html;
        panel.onDidDispose(() => { panel = undefined; });

        setTimeout(() => { updateWebview(); }, 250);
    });

    let timeoutId: NodeJS.Timeout;
    context.subscriptions.push(
        command,
        scanner.onDidChangeScan(() => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => { updateWebview(); }, 300);
        })
    );
    context.subscriptions.push(
        command,
        scanner.onDidChangeScan(() => updateWebview())
    );
}