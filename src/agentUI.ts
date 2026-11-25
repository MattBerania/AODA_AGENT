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
        const isContrast = issue.ruleId === INLINE_TEXT_CONTRAST_RULE_ID;
        const prompt = isContrast
            ? `Fix the following AODA/WCAG inline text contrast violation.
Rule: ${issue.ruleId} (${issue.message})
Guidance: ${rule.remediation}

Original foreground colour token:
${originalText}

Return only a single replacement 6-digit hex colour code (for example, #595959) that achieves at least a 4.5:1 WCAG AA contrast ratio against the background colour described above. Do not include quotes, semicolons, CSS properties, explanations, or code fences.`
            : `Fix the following AODA/WCAG accessibility violation.
Rule: ${issue.ruleId} (${issue.message})
Guidance: ${rule.remediation}

Original code:
${originalText}

Return only the revised opening tag for the same element. Preserve unrelated attributes and Razor expressions. Do not include a closing tag, surrounding markup, explanations or code fences.`;

        const messages = [api.LanguageModelChatMessage.User(prompt)];

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

function isAgentIssue(_issue: AccessibilityIssue): boolean {
    return true;
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

    type UndoEntry = {
        label: string;
        files: { fileUri: string; beforeText: string; }[];
    };
    const undoStack: UndoEntry[] = [];
    const proposalFiles = new Map<string, string>();

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
                        let beforeFileText: string | undefined;
                        let afterFileText: string | undefined;
                        let changedRange: { startLine: number; endLine: number; newEndLine: number } | undefined;

                        if (result.status === 'ready') {
                            const details = scanner.getIssueContext(issueId);
                            if (details?.issue?.fileUri) {
                                proposalFiles.set(result.proposalId, details.issue.fileUri);
                                try {
                                    const doc = await api.workspace.openTextDocument(api.Uri.parse(details.issue.fileUri));
                                    const r = details.issue.range;
                                    const startOffset = doc.offsetAt(new api.Position(r.startLine, r.startCharacter));
                                    const endOffset = doc.offsetAt(new api.Position(r.endLine, r.endCharacter));
                                    const fullText = doc.getText();

                                    const lineText = doc.lineAt(r.startLine).text;
                                    const indent = lineText.match(/^\s*/)?.[0] ?? '';
                                    const indentedFix = result.replacementText
                                        .split(/\r?\n/)
                                        .map((line: string, i: number) => (i === 0 ? line : indent + line))
                                        .join('\n');

                                    beforeFileText = fullText;
                                    afterFileText = fullText.slice(0, startOffset) + indentedFix + fullText.slice(endOffset);
                                    changedRange = {
                                        startLine: r.startLine,
                                        endLine: r.endLine,
                                        newEndLine: r.startLine + indentedFix.split('\n').length - 1
                                    };
                                } catch {
                                    // Fallback to snippet-only preview
                                }
                            }
                        }

                        send({
                            type: 'FIX_RESPONSE',
                            issueId,
                            requestId,
                            beforeFileText,
                            afterFileText,
                            changedRange,
                            ...result
                        });
                    }
                    break;
                }

                case 'dismissFix': {
                    proposals.clear();
                    break;
                }

                case 'applyFix': {
                    const { proposalId } = message;
                    const targetUri = proposalFiles.get(proposalId);
                    let beforeText: string | undefined;
                    if (targetUri) {
                        try {
                            const doc = await api.workspace.openTextDocument(api.Uri.parse(targetUri));
                            beforeText = doc.getText();
                        }
                        catch {
                            // Ignore if document can't be opened; undo will not be available
                        }
                    }
                    const result = Object.keys(message).every(key => key === 'command' || key === 'proposalId')
                        ? await proposals.approve(proposalId)
                        : { status: 'rejected', message: 'Approval must contain only the proposal identifier.' };
                    const didApply = result.status === 'applied'|| result.status === 'verified' || result.status === 'unverified';
                    if (didApply && targetUri && typeof beforeText === 'string') {
                        undoStack.push({
                            label: 'suggested fix',
                            files: [{ fileUri: targetUri, beforeText }],
                        });
                    }
                    proposalFiles.delete(proposalId);
                    if (panel === owner) {
                        send({ 
                            type: 'FIX_RESULT',
                            ...result, 
                            proposalId,
                            canUndo: undoStack.length > 0,
                            undoLabel: undoStack[undoStack.length - 1]?.label ?? '',
                        });
                    }
                    break;
                }

                case 'batchFix': {
                    const issueIds: string[] = Array.isArray(message.issueIds) ? message.issueIds : [];
                    const label: string = typeof message.label === 'string' ? message.label : 'selected';

                    if (issueIds.length === 0) break;

                    const confirm = await api.window.showWarningMessage(
                        `Automatically fix ${issueIds.length} AODA issue${issueIds.length === 1 ? '' : 's'} in ${label}?`,
                        {
                            modal: true,
                            detail: 'Copilot will generate and apply accessibility fixes directly to the affected files.'
                        },
                        'Fix Automatically'
                    );

                    if (confirm !== 'Fix Automatically') {
                        if (panel === owner) {
                            send({ type: 'BATCH_FIX_RESULT', status: 'cancelled' });
                        }
                        break;
                    }

                    if (panel === owner) {
                        send({
                            type: 'BATCH_FIX_STATUS',
                            message: `Fixing ${issueIds.length} issue${issueIds.length === 1 ? '' : 's'} in ${label}...`
                        });
                    }

                    let fixedCount = 0;
                    let failedCount = 0;

                    // Group issues by file so edits apply safely
                    const byFile = new Map<string, IssueContext[]>();
                    for (const id of issueIds) {
                        const details = scanner.getIssueContext(id);
                        if (!details) {
                            failedCount++;
                            continue;
                        }
                        const list = byFile.get(details.issue.fileUri) ?? [];
                        list.push(details);
                        byFile.set(details.issue.fileUri, list);
                    }

                    const fileSnapshots: { fileUri: string; beforeText: string }[] = [];
                    const edit = new api.WorkspaceEdit();

                    for (const [fileUri, contexts] of byFile.entries()) {
                        const uri = api.Uri.parse(fileUri);
                        const doc = await api.workspace.openTextDocument(uri);
                        fileSnapshots.push({ fileUri, beforeText: doc.getText() });

                        // Sort bottom-to-top so earlier ranges don't shift
                        contexts.sort((a, b) =>
                            b.issue.range.startLine - a.issue.range.startLine ||
                            b.issue.range.startCharacter - a.issue.range.startCharacter
                        );

                        for (const details of contexts) {
                            const aiFix = await generateAiFix(api, details);
                            if (!aiFix) {
                                failedCount++;
                                continue;
                            }

                            const r = details.issue.range;
                            const range = new api.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter);
                            const lineText = doc.lineAt(r.startLine).text;
                            const indent = lineText.match(/^\s*/)?.[0] ?? '';
                            const indentedFix = aiFix
                                .split('\n')
                                .map((line, i) => (i === 0 ? line : indent + line))
                                .join('\n');

                            edit.replace(uri, range, indentedFix);
                            fixedCount++;
                        }
                    }

                    if (fixedCount > 0) {
                        await api.workspace.applyEdit(edit);
                        undoStack.push({ label, files: fileSnapshots });
                    }

                    void api.window.showInformationMessage(
                        `AODA Batch Fix complete: ${fixedCount} fixed${failedCount ? `, ${failedCount} failed` : ''}.`
                    );

                    if (panel === owner) {
                        send({
                            type: 'BATCH_FIX_RESULT',
                            status: 'done',
                            fixedCount,
                            failedCount,
                            canUndo: undoStack.length > 0,
                            undoLabel: undoStack[undoStack.length - 1]?.label ?? '',
                        });
                    }
                    break;
                }

                case 'undoLastFix': {
                    const entry = undoStack.pop();
                    if (!entry) {
                        send({ type: 'UNDO_RESULT', success: false, canUndo: false, undoLabel: '' });
                        break;
                    }

                    try {
                        const edit = new api.WorkspaceEdit();
                        for (const file of entry.files) {
                            const uri = api.Uri.parse(file.fileUri);
                            const doc = await api.workspace.openTextDocument(uri);
                            const fullRange = new api.Range(
                                doc.positionAt(0),
                                doc.positionAt(doc.getText().length)
                            );
                            edit.replace(uri, fullRange, file.beforeText);
                        }
                        const success = await api.workspace.applyEdit(edit);
                        void api.window.showInformationMessage(
                            success ? `Reverted AODA fix (${entry.label}).` : 'Could not undo the last fix.'
                        );
                        send({
                            type: 'UNDO_RESULT',
                            success,
                            canUndo: undoStack.length > 0,
                            undoLabel: undoStack[undoStack.length - 1]?.label ?? '',
                        });
                    } catch (err) {
                        console.error('Undo fix error:', err);
                        send({
                            type: 'UNDO_RESULT',
                            success: false,
                            canUndo: undoStack.length > 0,
                            undoLabel: undoStack[undoStack.length - 1]?.label ?? '',
                        });
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
