import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as VSCode from "vscode";
import { INLINE_TEXT_CONTRAST_RULE_ID } from "./accessibility/rules";
import { createFixProposals } from "./fixProposals";
import type { IssueContext, ScannerIntegration } from "./types/scannerIntegration";

export const OPEN_AGENT_UI_COMMAND = "opsAoda.openAgentUI";

async function handleChatPrompt(
    api: typeof VSCode,
    userText: string,
    errorContext: any
): Promise<string> {
    const ruleId = errorContext?.issue?.ruleId || "Unknown Rule";
    const ruleDescription = errorContext?.rule?.remediation || "No remediation guidelines provided.";
    const codeSnippet = errorContext?.originalText || "No specific code selected.";

    try {
        const [model] = await api.lm.selectChatModels({ vendor: "copilot" });
        if (!model) {
            return "GitHub Copilot is not available. Make sure you are signed into Copilot in VS Code.";
        }

        const messages = [
            api.LanguageModelChatMessage.User(
                `You are an expert AODA and WCAG 2.2 accessibility assistant.
The user is asking about this code snippet:
\`\`\`html
${codeSnippet}
\`\`\`
It violates rule: ${ruleId}
Remediation guidance: ${ruleDescription}

Answer concisely. If they ask for a fix, provide the corrected HTML/Razor code.`
            ),
            api.LanguageModelChatMessage.User(userText),
        ];

        const tokenSource = new api.CancellationTokenSource();
        const response = await model.sendRequest(messages, {}, tokenSource.token);

        let fullReply = "";
        for await (const chunk of response.text) {
            fullReply += chunk;
        }

        return fullReply;
    } catch (err) {
        if (err instanceof api.LanguageModelError) {
            console.error("Copilot LM Error:", err.message, err.code);
            return `Copilot error: ${err.message}`;
        }
        console.error("Unexpected chatbot error:", err);
        return "An error occurred while communicating with GitHub Copilot.";
    }
}

async function generateAiFix(
    api: typeof VSCode,
    errorContext: IssueContext
): Promise<string | null> {
    const { issue, rule, originalText } = errorContext;

    try {
        const [model] = await api.lm.selectChatModels({ vendor: "copilot" });
        if (!model) {
            return null;
        }

        const messages = [
            api.LanguageModelChatMessage.User(
                `Fix the following AODA/WCAG accessibility violation.
Rule: ${issue.ruleId} (${issue.message})
Guidance: ${rule.remediation}

Original code:
${originalText}

Return only the revised opening tag for the same element. Preserve unrelated attributes and Razor expressions. Do not include a closing tag, surrounding markup, explanations or code fences.`
            ),
        ];

        const tokenSource = new api.CancellationTokenSource();
        try {
            const response = await model.sendRequest(messages, {}, tokenSource.token);
            let fullReply = "";
            for await (const chunk of response.text) fullReply += chunk;
            return fullReply.trim().replace(/^```[\w]*\r?\n?/i, "").replace(/\r?\n?```$/i, "").trim();
        } finally {
            tokenSource.dispose();
        }
    } catch (err) {
        console.error("AI Fix generation error:", err);
        return null;
    }
}

function isPositionInIssue(position: VSCode.Position, issue: any): boolean {
    const range = issue?.range;
    if (!range) return false;

    const afterStart =
        position.line > range.startLine ||
        (position.line === range.startLine && position.character >= range.startCharacter);
    const beforeEnd =
        position.line < range.endLine ||
        (position.line === range.endLine && position.character <= range.endCharacter);

    return afterStart && beforeEnd;
}

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

        if (!snapshot) {
            if (api.window.activeTextEditor) {
                panel.webview.postMessage({ type: "SCAN_RESULTS", payload: [], status: "pending" });
            }
            return;
        }

        const payload = snapshot.issues
            .filter(issue => issue.ruleId !== INLINE_TEXT_CONTRAST_RULE_ID)
            .map(issue => scanner.getIssueContext(issue.id));
        panel.webview.postMessage({
            type: "SCAN_RESULTS",
            payload,
            status: snapshot.status,
            reason: snapshot.status === "analyzed" ? undefined : snapshot.reason
        });
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
        const owner = panel;
        const proposals = createFixProposals(api, scanner, details => generateAiFix(api, details));
        panel.onDidDispose(() => {
            proposals.clear();
            panel = undefined;
        });

        panel.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message !== 'object' || panel !== owner) return;
            switch (message.command) {
                case 'askChatbot': {
                    const { text, context: errorContext, typingId } = message;
                    const botReply = await handleChatPrompt(api, text, errorContext);

                    if (panel !== owner) break;
                    panel.webview.postMessage({
                        type: 'CHAT_RESPONSE',
                        payload: botReply,
                        typingId: typingId
                    });
                    break;
                }

                case 'generateFix': {
                    const { issueId, documentVersion, requestId } = message;
                    const result = await proposals.generate(issueId, documentVersion);
                    if (result && panel === owner) {
                        void owner.webview.postMessage({ type: 'FIX_RESPONSE', issueId, requestId, ...result });
                    }
                    break;
                }

                case 'dismissFix': {
                    proposals.clear();
                    break;
                }

                case 'applyFix': {
                    const { proposalId } = message;
                    const result = Object.keys(message).every(key => key === 'command' || key === 'proposalId')
                        ? await proposals.approve(proposalId)
                        : { status: 'rejected', message: 'Approval must contain only the proposal identifier.' };
                    if (panel === owner) {
                        void owner.webview.postMessage({ type: 'FIX_RESULT', proposalId, ...result });
                    }
                    break;
                }

                case 'scanCurrentPage': {
                    await api.commands.executeCommand('opsAoda.scanCurrentPage');
                    updateWebview();
                    break;
                }

                case 'scanRepository': {
                    await api.commands.executeCommand('opsAoda.scanRepository');
                    updateWebview();
                    break;
                }
            }
        });

        setTimeout(() => { updateWebview(); }, 250);
    });

    const selectionListener = api.window.onDidChangeTextEditorSelection(async (event) => {
        if (event.kind !== api.TextEditorSelectionChangeKind.Mouse) {
            return;
        }

        const editor = event.textEditor;
        const snapshot = scanner.getLatestScan();
        if (!snapshot || snapshot.fileUri !== editor.document.uri.toString()) {
            return;
        }

        const clickedPos = event.selections[0]?.active;
        if (!clickedPos) return;

        const matchedIssue = snapshot.issues.find(issue =>
            issue.ruleId !== INLINE_TEXT_CONTRAST_RULE_ID && isPositionInIssue(clickedPos, issue));
        if (!matchedIssue) return;

        const issueCtx = scanner.getIssueContext(matchedIssue.id);
        if (!issueCtx) return;

        const wasClosed = !panel;
        if (wasClosed) {
            await api.commands.executeCommand(OPEN_AGENT_UI_COMMAND);
        } else {
            panel?.reveal(api.ViewColumn.Beside, true);
        }

        setTimeout(() => {
            panel?.webview.postMessage({
                type: "SELECT_ISSUE",
                payload: issueCtx,
            });
        }, wasClosed ? 350 : 0);
    });

    let timeoutId: NodeJS.Timeout;
    context.subscriptions.push(
        command,
        selectionListener,
        scanner.onDidChangeScan(() => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => { updateWebview(); }, 300);
        })
    );
}
