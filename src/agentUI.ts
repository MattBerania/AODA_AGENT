import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as VSCode from "vscode";
import type { ScannerIntegration } from "./types/scannerIntegration";

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
    errorContext: any
): Promise<string | null> {
    const ruleId = errorContext?.issue?.ruleId || "Unknown Rule";
    const ruleMessage = errorContext?.issue?.message || "";
    const remediation = errorContext?.rule?.remediation || "";
    const codeSnippet = errorContext?.originalText || "";

    try {
        const [model] = await api.lm.selectChatModels({ vendor: "copilot" });
        if (!model) {
            return null;
        }

        const messages = [
            api.LanguageModelChatMessage.User(
                `Fix the following AODA/WCAG accessibility violation.
Rule: ${ruleId} (${ruleMessage})
Guidance: ${remediation}

Original code:
${codeSnippet}

Return ONLY the corrected HTML/Razor code snippet. Do not include explanations, comments, or markdown code fences.`
            ),
        ];

        const tokenSource = new api.CancellationTokenSource();
        const response = await model.sendRequest(messages, {}, tokenSource.token);

        let fullReply = "";
        for await (const chunk of response.text) {
            fullReply += chunk;
        }

        return fullReply.replace(/^```[\w]*\n?/i, "").replace(/\n?```$/i, "").trim();
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

        const payload = snapshot.issues.map(issue => {
            const issueCtx = scanner.getIssueContext(issue.id);
            return {
                issue: issueCtx?.issue,
                originalText: issueCtx?.originalText,
                rule: issueCtx?.rule,
            };
        });
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
        panel.onDidDispose(() => { panel = undefined; });

        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'askChatbot': {
                    const { text, context: errorContext, typingId } = message;
                    const botReply = await handleChatPrompt(api, text, errorContext);

                    panel?.webview.postMessage({
                        type: 'CHAT_RESPONSE',
                        payload: botReply,
                        typingId: typingId
                    });
                    break;
                }

                case 'generateFix': {
                    const { context: fixContext } = message;
                    const aiFix = await generateAiFix(api, fixContext);

                    panel?.webview.postMessage({
                        type: 'FIX_RESPONSE',
                        payload: aiFix,
                        issueId: fixContext?.issue?.id
                    });
                    break;
                }
                
                case 'applyFix': {
                    const { fixCode, context: fixContext } = message;
                    const issue = fixContext?.issue;

                    if (!issue?.fileUri || !issue?.range || typeof fixCode !== 'string') {
                        panel?.webview.postMessage({ type: 'FIX_APPLIED', success: false });
                        break;
                    }

                    try {
                        const uri = api.Uri.parse(issue.fileUri);
                        const document = await api.workspace.openTextDocument(uri);
                        const range = new api.Range(
                            issue.range.startLine,
                            issue.range.startCharacter,
                            issue.range.endLine,
                            issue.range.endCharacter
                        );

                        // Match the indentation of the original line for multi-line fixes
                        const lineText = document.lineAt(issue.range.startLine).text;
                        const indent = lineText.match(/^\s*/)?.[0] ?? '';
                        const indentedFix = fixCode
                            .split('\n')
                            .map((line: string, i: number) => (i === 0 ? line : indent + line))
                            .join('\n');

                        const edit = new api.WorkspaceEdit();
                        edit.replace(uri, range, indentedFix);
                        const success = await api.workspace.applyEdit(edit);

                        panel?.webview.postMessage({ type: 'FIX_APPLIED', success });
                    } catch (err) {
                        console.error('Error applying fix:', err);
                        panel?.webview.postMessage({ type: 'FIX_APPLIED', success: false });
                    }
                    break;
                }

                case 'scanCurrentPage': {
                    await api.commands.executeCommand('opsAoda.scanCurrentPage');
                    updateWebview();
                    break;
                }

                case 'showScanIssues': {
                    if (!scanner.getLatestScan()) {
                        await api.commands.executeCommand('opsAoda.scanCurrentPage');
                    }
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

        const matchedIssue = snapshot.issues.find((issue) => isPositionInIssue(clickedPos, issue));
        if (!matchedIssue) return;

        const issueCtx = scanner.getIssueContext(matchedIssue.id);
        if (!issueCtx) return;

        const payload = {
            issue: issueCtx.issue,
            originalText: issueCtx.originalText,
            rule: issueCtx.rule,
        };

        const wasClosed = !panel;
        if (wasClosed) {
            await api.commands.executeCommand(OPEN_AGENT_UI_COMMAND);
        } else {
            panel?.reveal(api.ViewColumn.Beside, true);
        }

        setTimeout(() => {
            panel?.webview.postMessage({
                type: "SELECT_ISSUE",
                payload,
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