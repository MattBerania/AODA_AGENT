import { AGENT_SIDEBAR_VIEW_ID } from "./agentSidebar";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as VSCode from "vscode";
import { INLINE_TEXT_CONTRAST_RULE_ID } from "./accessibility/rules";
import { createFixProposals } from "./fixProposals";
import { SCAN_REPOSITORY_COMMAND, type RepositoryScanResult } from "./repositoryScanning";
import type { AccessibilityIssue } from "./types/accessibility";
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
        const contextPrompt = errorContext?.issue
            ? `You are an expert AODA and WCAG 2.2 accessibility assistant.
            The user is asking about this code snippet:
            \`\`\`html
            ${codeSnippet}
            \`\`\`
            It violates rule: ${ruleId}
            Remediation guidance: ${ruleDescription}

            Answer concisely. If they ask for a fix, provide the corrected HTML/Razor code.`
                        : `You are an expert AODA (Accessibility for Ontarians with Disabilities Act) and WCAG 2.0/2.2 accessibility assistant.
            Answer the user's accessibility questions concisely and provide clean HTML/Razor examples when helpful.`;
        const messages = [
            api.LanguageModelChatMessage.User(contextPrompt),
            api.LanguageModelChatMessage.User(userText),
        ];
        const tokenSource = new api.CancellationTokenSource();
        try {
            const response = await model.sendRequest(messages, {}, tokenSource.token);
            let fullReply = "";
            for await (const chunk of response.text) {
                fullReply += chunk;
            }
            return fullReply;
        } finally { tokenSource.dispose(); }
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

function isAgentIssue(issue: AccessibilityIssue): boolean {
    return issue.ruleId !== INLINE_TEXT_CONTRAST_RULE_ID;
}

function isPositionInIssue(position: VSCode.Position, issue: AccessibilityIssue): boolean {
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
): VSCode.WebviewViewProvider {
    let panel: VSCode.WebviewView | undefined;
    let ready = false;
    let pendingSelection: IssueContext | undefined;
    let cleanupView = () => {};
    let send = (_message: unknown): void => {};
    const CHAT_HISTORY_KEY = "aodaAgent.chatHistory";
    let showRepository = false;
    let hasResized = false;

    function updateWebview() {
        if (!panel || !ready || showRepository) {
            return;
        }
        const snapshot = scanner.getLatestScan();

        if (!snapshot) {
            if (api.window.activeTextEditor) {
                send({ type: "SCAN_RESULTS", payload: [], status: "pending" });
            }
            return;
        }

        const payload = snapshot.issues
            .filter(isAgentIssue)
            .map(issue => scanner.getIssueContext(issue.id));
        send({
            type: "SCAN_RESULTS",
            payload,
            status: snapshot.status,
            reason: snapshot.status === "analyzed" ? undefined : snapshot.reason
        });
    }

    const command = api.commands.registerCommand(OPEN_AGENT_UI_COMMAND, () =>
        api.commands.executeCommand(`${AGENT_SIDEBAR_VIEW_ID}.focus`));

    const provider: VSCode.WebviewViewProvider = { resolveWebviewView(view) {
        cleanupView();
        panel = view;
        ready = false;
        showRepository = false;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [api.Uri.file(join(context.extensionPath, 'prototype'))],
        };
        const htmlPath = join(context.extensionPath, 'prototype', 'index.html');
        let html = readFileSync(htmlPath, 'utf8');
        const cssUri = panel.webview.asWebviewUri(api.Uri.file(join(context.extensionPath, 'prototype', 'CSS', 'AODA.css')));
        const jsUri = panel.webview.asWebviewUri(api.Uri.file(join(context.extensionPath, 'prototype', 'JS', 'AODA_Agent.js')));
        html = html.replace('CSS/AODA.css', cssUri.toString());
        html = html.replace('JS/AODA_Agent.js', jsUri.toString());

        const owner = panel;
        let repositoryScanRunning = false;
        const proposals = createFixProposals(api, scanner, details => generateAiFix(api, details));
        const queued: unknown[] = [];
        send = message => {
            if (panel !== owner) return;
            if (!ready || !owner.visible) queued.push(message);
            else void owner.webview.postMessage(message);
        };
        const visibility = owner.onDidChangeVisibility(() => {
            if (!owner.visible || !ready) return;
            for (const message of queued.splice(0)) void owner.webview.postMessage(message);
            updateWebview();
        });
        let closed = false;
        const disposed = owner.onDidDispose(() => cleanupView());
        cleanupView = () => {
            if (closed) return;
            closed = true;
            proposals.clear();
            queued.length = 0;
            receiver.dispose();
            visibility.dispose();
            disposed.dispose();
            if (panel === owner) { panel = undefined; ready = false; }
        };

        const receiver = panel.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message !== 'object' || panel !== owner) return;
            switch (message.command) {
                case 'ready': {
                    ready = true;
                    for (const item of queued.splice(0)) send(item);
                    updateWebview();
                    if (pendingSelection) {
                        send({ type: 'SELECT_ISSUE', payload: pendingSelection });
                        pendingSelection = undefined;
                    }
                    if (!hasResized) {
                        for (let i = 0; i < 3; i++) {
                            await api.commands.executeCommand('workbench.action.decreaseViewWidth');
                        }
                        hasResized = true;
                    }

                    break;
                }
                case 'askChatbot': {
                    const { text, context: errorContext, typingId } = message;
                    const botReply = await handleChatPrompt(api, text, errorContext);

                    if (panel !== owner) break;
                    send({
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
                        void send({ type: 'FIX_RESPONSE', issueId, requestId, ...result });
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
                        void send({ type: 'FIX_RESULT', proposalId, ...result });
                    }
                    break;
                }

                case 'scanCurrentPage': {
                    showRepository = false;
                    await api.commands.executeCommand('opsAoda.scanCurrentPage');
                    updateWebview();
                    break;
                }

                case 'scanRepository': {
                    showRepository = true;
                    if (repositoryScanRunning) break;
                    repositoryScanRunning = true;
                    try {
                        const result = await api.commands.executeCommand<RepositoryScanResult | undefined>(
                            SCAN_REPOSITORY_COMMAND);
                        if (panel !== owner || !showRepository) break;
                        if (!result) {
                            void send({
                                type: 'REPO_SCAN_RESULTS',
                                message: 'Repository scan unavailable. See VS Code notifications for details.',
                            });
                            break;
                        }

                        const payload: (IssueContext & { folderPath: string; fileName: string })[] = [];
                        for (const snapshot of result.snapshots) {
                            const issues = snapshot.issues.filter(isAgentIssue);
                            if (!issues.length) continue;
                            const uri = api.Uri.parse(snapshot.fileUri);
                            const rootName = api.workspace.getWorkspaceFolder(uri)?.name ?? 'Workspace';
                            const relPath = api.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
                            const lastSlash = relPath.lastIndexOf('/');
                            const folderPath = lastSlash >= 0 ? `${rootName}/${relPath.slice(0, lastSlash)}` : rootName;
                            const fileName = relPath.slice(lastSlash + 1);
                            for (const issue of issues) {
                                const details = scanner.getIssueContext(issue.id);
                                if (details?.documentVersion === snapshot.documentVersion) {
                                    payload.push({ ...details, folderPath, fileName });
                                }
                            }
                        }
                        void send({ type: 'REPO_SCAN_RESULTS', payload });
                    } catch (error) {
                        console.error('Repository scan error:', error);
                        if (panel === owner && showRepository) {
                            void send({
                                type: 'REPO_SCAN_RESULTS',
                                message: 'Error scanning repository.',
                            });
                        }
                    } finally {
                        repositoryScanRunning = false;
                    }
                    break;
                }

                case 'getChatHistory': {
                    const history = context.workspaceState.get<any[]>(CHAT_HISTORY_KEY, []);
                    send({
                        type: 'CHAT_HISTORY_LOADED',
                        payload: history
                    });
                    break;
                }

                case 'saveChatHistory': {
                    await context.workspaceState.update(CHAT_HISTORY_KEY, message.payload ?? []);
                    break;
                }
            }
        });

        panel.webview.html = html;
    } };

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
            isAgentIssue(issue) && isPositionInIssue(clickedPos, issue));
        if (!matchedIssue) return;

        const issueCtx = scanner.getIssueContext(matchedIssue.id);
        if (!issueCtx) return;

        if (!panel || !ready) {
            pendingSelection = issueCtx;
            await api.commands.executeCommand(OPEN_AGENT_UI_COMMAND);
        } else {
            panel.show(true);
            send({ type: 'SELECT_ISSUE', payload: issueCtx });
        }
    });

    let timeoutId: NodeJS.Timeout;
    context.subscriptions.push(
        command,
        { dispose() { clearTimeout(timeoutId); cleanupView(); pendingSelection = undefined; } },
        selectionListener,
        scanner.onDidChangeScan(() => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => { updateWebview(); }, 300);
        })
    );
    return provider;
}
