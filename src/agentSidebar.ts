import type * as VSCode from "vscode";

// Keep this identifier aligned with contributes.views in package.json.
export const AGENT_SIDEBAR_VIEW_ID = "opsAoda.agentSidebar";

/** Placeholder only. The actual agent UI will be connected here separately. */
export function registerAgentSidebar(
  api: typeof VSCode,
  context: Pick<VSCode.ExtensionContext, "subscriptions">,
): void {
  context.subscriptions.push(api.window.registerWebviewViewProvider(AGENT_SIDEBAR_VIEW_ID, {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: false, localResourceRoots: [] };
      view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
  <title>OPS AODA Agent</title>
</head>
<body>
  <p>OPS AODA Agent</p>
</body>
</html>`;
    },
  }));
}
