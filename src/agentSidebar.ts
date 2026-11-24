import type * as VSCode from "vscode";

export const AGENT_SIDEBAR_VIEW_ID = "opsAoda.agentSidebar";

export function registerAgentSidebar(
  api: typeof VSCode,
  context: Pick<VSCode.ExtensionContext, "subscriptions">,
  provider: VSCode.WebviewViewProvider,
): void {
  context.subscriptions.push(api.window.registerWebviewViewProvider(AGENT_SIDEBAR_VIEW_ID, provider, {
    webviewOptions: { retainContextWhenHidden: true },
  }));
}
