document.addEventListener('DOMContentLoaded', () => {
    let currentActiveError = null;
    let requestId;
    let proposalId;
    //VSCODE API FOR GITHUB COPILOT
    const vscode = acquireVsCodeApi();
    //VSCODE VIEWS
    const errorListView = document.getElementById('error-list-view');
    const detailChatView = document.getElementById('detail-chat-view');
    const sidebarContent = document.getElementById('sidebar-content');
    const detailContainer = document.querySelector('.detail-container');
    
    //BUTTONS 
    const backBtn = document.getElementById('backBtn');
    const maximizeChatBtn = document.getElementById('maximizeChatBtn');
    const scanPageBtn = document.getElementById('scanPageBtn');
    const scanRepoBtn = document.getElementById('scanRepoBtn');

    scanPageBtn.addEventListener('click', () => {
        sidebarContent.innerHTML = '<p style="padding: 15px;"><em>Scanning current page...</em></p>';
        vscode.postMessage({ command: 'scanCurrentPage' });
    });

    scanRepoBtn.addEventListener('click', () => {
        detailChatView.classList.remove('active');
        errorListView.classList.add('active');
        sidebarContent.innerHTML = '<p style="padding: 15px;"><em>Scanning repository...</em></p>';
        vscode.postMessage({ command: 'scanRepository' });
    });
    
    // 1. LISTEN FOR LIVE VS CODE DATA
    window.addEventListener('message', event => {
        const message = event.data; 
        if (message.type === 'SCAN_RESULTS') {
            populateSidebar(message.payload);
            if (message.status && message.status !== 'analyzed') {
                sidebarContent.textContent = message.status === 'pending'
                    ? 'Waiting for scan results.'
                    : 'Scan ' + message.status + '. ' + (message.reason || '');
            }
        } 
        else if (message.type === 'CHAT_RESPONSE') {
            const typingIndicator = document.getElementById(message.typingId);
            if (typingIndicator) {
                typingIndicator.remove();
            }
            appendMessage(formatBotMessage(message.payload), false);
        }
        else if (message.type === 'FIX_RESPONSE') {
            if (requestId !== message.requestId || currentActiveError?.issue.id !== message.issueId) return;
            if (message.status === 'ready') {
                proposalId = message.proposalId;
                document.querySelector('.original-code').textContent = message.originalText;
                renderSuggestedFix(message.replacementText, proposalId);
            } else {
                document.querySelector('.code-diff-viewer').textContent = message.message;
            }
        }
        else if (message.type === 'SELECT_ISSUE') {
            if (message.payload) {
                loadErrorDetails(message.payload);
            }
        }
        else if (message.type === 'FIX_RESULT' && proposalId && proposalId === message.proposalId) {
            const button = document.getElementById('applyFixBtn');
            button.disabled = true;
            const labels = { applied: 'Applied', verified: 'Verified', unverified: 'Unverified', rejected: 'Rejected', failed: 'Failed' };
            button.textContent = labels[message.status];
            document.querySelector('.fix-status').textContent = message.message;
        }
    });

    // 2. DYNAMIC SIDEBAR GENERATION
    function populateSidebar(liveScanResults) {
        sidebarContent.innerHTML = '';
        const categories = {};
        
        if (!liveScanResults || liveScanResults.length === 0) {
            sidebarContent.innerHTML = '<p style="padding: 15px; color: var(--success);">Analyzed with no confirmed findings from the implemented checks.</p>';
            return;
        }

        liveScanResults.forEach(context => {
            if (!context?.issue) return;
            const cat = context.issue.category;
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(context);
        });

        for (const [category, contexts] of Object.entries(categories)) {
            const details = document.createElement('details');
            details.className = 'aoda-accordion';
            details.open = true;
            const summary = document.createElement('summary');
            summary.textContent = category;
            details.appendChild(summary);
            const ul = document.createElement('ul');
            ul.className = 'error-list';
            const issuesByTitle = {};
            contexts.forEach(ctx => {
                const title = ctx.issue.title;
                if (!issuesByTitle[title]) issuesByTitle[title] = [];
                issuesByTitle[title].push(ctx);
            });
            for (const [title, titleContexts] of Object.entries(issuesByTitle)) {
                const li = document.createElement('li');
                li.className = 'error-item';
                const titleHeader = document.createElement('div');
                titleHeader.className = 'error-title-header';
                
                const titleLabel = document.createElement('span');
                titleLabel.className = 'error-title-label';
                titleLabel.textContent = title;
                
                const badge = document.createElement('span');
                badge.className = 'error-badge';
                badge.textContent = titleContexts.length;
                
                titleHeader.appendChild(titleLabel);
                titleHeader.appendChild(badge);
                li.appendChild(titleHeader);

                titleContexts.forEach(context => {
                    const codeSnippet = document.createElement('span');
                    codeSnippet.className = 'error-code-link';
                    
                    const cleanCode = context.originalText.trim().replace(/\s+/g, ' ');
                    const words = cleanCode.split(' ');
                    codeSnippet.textContent = words.length > 7 
                        ? words.slice(0, 7).join(' ') + '...' 
                        : cleanCode;

                    codeSnippet.addEventListener('click', () => loadErrorDetails(context));
                    li.appendChild(codeSnippet);
                });
                
                ul.appendChild(li);
            }

            details.appendChild(ul);
            sidebarContent.appendChild(details);
        }
    }

    // 4. NAVIGATION & DETAILS
    function loadErrorDetails(context) {
        const isNewError = !currentActiveError || currentActiveError.issue.id !== context.issue.id;
        currentActiveError = context;
        requestId = crypto.randomUUID();
        proposalId = undefined;
        if (isNewError) {
            chatHistory.innerHTML = '';
        }
        
        errorListView.classList.remove('active');
        detailChatView.classList.add('active');
        detailContainer.classList.remove('chat-maximized');
        maximizeChatBtn.textContent = '⛶';
        maximizeChatBtn.setAttribute('aria-label', 'Maximize Chat');
        maximizeChatBtn.title = 'Maximize Chat';



        const errorDesc = document.querySelector('.error-description');
        errorDesc.innerHTML = `
            <strong>${escapeHTML(context.issue.title)}</strong>
            <p>${escapeHTML(context.issue.message)}</p>
            <div class="code-header">
                <strong>Original Code:</strong>
            </div>
            <p>${escapeHTML(context.issue.fileUri)} · Line ${context.issue.range.startLine + 1}</p>
            <div class="code-block original-code">${escapeHTML(context.originalText)}</div>
        `;

        const codeDiff = document.querySelector('.code-diff-viewer');
        if (context.issue.ruleId === 'inline-text-contrast') {
            codeDiff.textContent = '';
            vscode.postMessage({ command: 'dismissFix' });
            return;
        }
        codeDiff.innerHTML = "<em>Generating AI code suggestion...</em>";

        vscode.postMessage({
            command: 'generateFix',
            issueId: context.issue.id,
            documentVersion: context.documentVersion,
            requestId
        });
    }

    function renderSuggestedFix(replacementText, reviewedId) {
        const codeDiff = document.querySelector('.code-diff-viewer');

        codeDiff.innerHTML = `
            <div class="code-header">
                <strong>Copilot suggested fix:</strong>
                <div class="code-actions">
                    <button id="applyFixBtn" class="copy-btn generate-btn" title="Apply fix directly to code">
                        Apply fix
                    </button>
                    <button id="copyFixBtn" class="copy-btn" title="Copy to clipboard">
                        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10h1V2h6.414l-1-1H3z"/></svg>
                        Copy
                    </button>
                </div>
            </div>
            <div class="code-block suggestion-block">${escapeHTML(replacementText)}</div>
            <div class="fix-status" role="status"></div>
        `;

        const applyBtn = document.getElementById('applyFixBtn');
        applyBtn.addEventListener('click', () => {
            if (applyBtn.disabled || proposalId !== reviewedId) return;
            applyBtn.disabled = true;
            applyBtn.textContent = 'Applying…';
            vscode.postMessage({ command: 'applyFix', proposalId: reviewedId });
        });

        const copyBtn = document.getElementById('copyFixBtn');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(replacementText).then(() => {
                const originalIcon = copyBtn.innerHTML;
                copyBtn.innerHTML = '✓ Copied!';
                copyBtn.style.color = 'var(--success-green)';
                copyBtn.style.borderColor = 'var(--success-green)';
                
                setTimeout(() => {
                    copyBtn.innerHTML = originalIcon;
                    copyBtn.style.color = '';
                    copyBtn.style.borderColor = '';
                }, 2000);
            });
        });
    }

    backBtn.addEventListener('click', () => {
        requestId = undefined;
        proposalId = undefined;
        vscode.postMessage({ command: 'dismissFix' });
        detailChatView.classList.remove('active');
        errorListView.classList.add('active');
    });

    maximizeChatBtn.addEventListener('click', () => {
        const isMaximized = detailContainer.classList.toggle('chat-maximized');
        maximizeChatBtn.textContent = isMaximized ? '🗗' : '⛶';
        const label = isMaximized ? 'Minimize chat' : 'Maximize chat';
        maximizeChatBtn.setAttribute('aria-label', label);
        maximizeChatBtn.title = label;
    });

    // 5. INTERACTIVE CHATBOT LOGIC
    const chatInput = document.getElementById('chatInput');
    const sendMsgBtn = document.getElementById('sendMsgBtn');
    const chatHistory = document.querySelector('.chat-history');
    const clearChatBtn = document.getElementById('clearChatBtn');
    clearChatBtn.addEventListener('click', () => {
        chatHistory.innerHTML = '';
    });

    function appendMessage(text, isUser) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-msg ${isUser ? 'msg-user' : 'msg-bot'}`;
        msgDiv.innerHTML = text;
        chatHistory.appendChild(msgDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (text === '') return;

        appendMessage(escapeHTML(text), true);
        chatInput.value = '';

        if (!currentActiveError) {
            appendMessage("Please select an error from the list first.", false);
            return;
        }

        const typingId = "typing-" + Date.now();
        const typingDiv = document.createElement('div');
        typingDiv.id = typingId;
        typingDiv.className = 'chat-msg msg-bot';
        typingDiv.innerHTML = '<em>Agent is typing...</em>';
        chatHistory.appendChild(typingDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;

        vscode.postMessage({
            command: 'askChatbot',
            text: text,
            context: currentActiveError,
            typingId: typingId
        });
    }

    sendMsgBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    function formatBotMessage(text) {
        if (!text) return '';
        const escaped = escapeHTML(text);
        return escaped
            .replace(/```[\w]*\n([\s\S]*?)```/g, '<div class="code-block">$1</div>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
            }[tag])
        );
    }
});
