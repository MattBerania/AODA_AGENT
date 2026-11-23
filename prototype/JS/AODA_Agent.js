document.addEventListener('DOMContentLoaded', () => {
    let activeTab = 'home';
    let currentActiveError = null;
    let chatSessions = [];
    let activeSessionId = null;
    let requestId;
    let proposalId;
    //VSCODE API FOR GITHUB COPILOT
    const vscode = acquireVsCodeApi();

    const savedState = vscode.getState() || {};

    //VIEWS
    const homeView = document.getElementById('home-view');
    const errorListView = document.getElementById('error-list-view');
    const detailChatView = document.getElementById('detail-chat-view');
    const sidebarContent = document.getElementById('sidebar-content');
    const detailContainer = document.querySelector('.detail-container');
    const homeContainer = document.querySelector('.home-container');
    const chatSection = document.getElementById('chatSection');
    const homeChatMount = document.getElementById('home-chat-mount');
    const detailChatMount = document.getElementById('detail-chat-mount');
    
    //BUTTONS
    const homeBtn = document.getElementById('homeBtn');
    const backBtn = document.getElementById('backBtn');
    const maximizeChatBtn = document.getElementById('maximizeChatBtn');
    const scanPageBtn = document.getElementById('scanPageBtn');
    const scanRepoBtn = document.getElementById('scanRepoBtn');

    function setActiveTab(tab) {
        activeTab = tab;
        homeBtn.classList.toggle('primary', tab === 'home');
        scanPageBtn.classList.toggle('primary', tab === 'page');
        scanRepoBtn.classList.toggle('primary', tab === 'repo');
    }

    function showHomeView() {
        setActiveTab('home');
        currentActiveError = null;
        homeContainer.classList.remove('chat-maximized');
        detailContainer.classList.remove('chat-maximized');
        maximizeChatBtn.textContent = '⛶';
        maximizeChatBtn.setAttribute('aria-label', 'Maximize chat');
        maximizeChatBtn.title = 'Maximize chat';

        homeChatMount.appendChild(chatSection);
        errorListView.classList.remove('active');
        detailChatView.classList.remove('active');
        homeView.classList.add('active');
    }

    homeBtn.addEventListener('click', showHomeView);

    scanPageBtn.addEventListener('click', () => {
        setActiveTab('page');
        homeView.classList.remove('active');
        detailChatView.classList.remove('active');
        errorListView.classList.add('active');
        sidebarContent.innerHTML = '<p style="padding: 15px;"><em>Scanning current page...</em></p>';
        vscode.postMessage({ command: 'scanCurrentPage' });
    });

    scanRepoBtn.addEventListener('click', () => {
        setActiveTab('repo');
        homeView.classList.remove('active');
        detailChatView.classList.remove('active');
        errorListView.classList.add('active');
        sidebarContent.innerHTML = '<p style="padding: 15px;"><em>Scanning repository...</em></p>';
        vscode.postMessage({ command: 'scanRepository' });
    });
    
    // 1. LISTEN FOR LIVE VS CODE DATA
    window.addEventListener('message', event => {
        const message = event.data; 
        if (message.type === 'SCAN_RESULTS') {
            if (activeTab !== 'page') return;
            populateSidebar(message.payload);
            if (message.status && message.status !== 'analyzed') {
                sidebarContent.textContent = message.status === 'pending'
                    ? 'Waiting for scan results.'
                    : 'Scan ' + message.status + '. ' + (message.reason || '');
            }
        }
        else if (message.type === 'CHAT_HISTORY_LOADED') {
            chatSessions = Array.isArray(message.payload) ? message.payload : [];
            renderChatSessionList();
        }
        else if (message.type === 'CHAT_RESPONSE') {
            const typingIndicator = document.getElementById(message.typingId);
            if (typingIndicator) {
                typingIndicator.remove();
            }
            const formattedReply = formatBotMessage(message.payload);
            appendMessage(formattedReply, false);
            saveMessageToActiveSession(formattedReply, false);
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
        else if (message.type === 'REPO_SCAN_RESULTS') {
            if (message.message) {
                sidebarContent.innerHTML = `<p style="padding: 15px;">${escapeHTML(message.message)}</p>`;
            } else {
                populateRepoSidebar(message.payload);
            }
        }
    });

    // 2. DYNAMIC SIDEBAR GENERATION
    function populateSidebar(liveScanResults) {
        sidebarContent.innerHTML = '';
        const categories = {};
        
        if (!liveScanResults || liveScanResults.length === 0) {
            sidebarContent.textContent = 'No findings to display in the Agent.';
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

    function populateRepoSidebar(repoScanResults) {
        sidebarContent.innerHTML = '';

        if (!repoScanResults || repoScanResults.length === 0) {
            sidebarContent.textContent = 'No repository findings to display in the Agent. See Problems for scan diagnostics.';
            return;
        }

        // Category -> Folder -> File -> Issues[]
        const tree = {};
        repoScanResults.forEach(ctx => {
            if (!ctx.issue) return;
            const cat = ctx.issue.category || 'Other';
            const folder = ctx.folderPath || 'Root';
            const file = ctx.fileName || 'Unknown File';

            if (!tree[cat]) tree[cat] = {};
            if (!tree[cat][folder]) tree[cat][folder] = {};
            if (!tree[cat][folder][file]) tree[cat][folder][file] = [];
            tree[cat][folder][file].push(ctx);
        });

        for (const [category, folders] of Object.entries(tree)) {
            const catTotal = Object.values(folders).reduce(
                (sum, files) => sum + Object.values(files).reduce((fSum, list) => fSum + list.length, 0),
                0
            );

            const catDetails = document.createElement('details');
            catDetails.className = 'aoda-accordion';
            catDetails.open = true;

            const catSummary = document.createElement('summary');
            catSummary.className = 'repo-summary-row';
            catSummary.innerHTML = `<span>${escapeHTML(category)}</span><span class="error-badge">${catTotal}</span>`;
            catDetails.appendChild(catSummary);

            for (const [folderName, files] of Object.entries(folders)) {
                const folderTotal = Object.values(files).reduce((sum, list) => sum + list.length, 0);

                const folderDetails = document.createElement('details');
                folderDetails.className = 'repo-folder-accordion';
                folderDetails.open = true;

                const folderSummary = document.createElement('summary');
                folderSummary.className = 'repo-folder-summary';
                folderSummary.innerHTML = `<span>${escapeHTML(folderName)}</span><span class="error-badge">${folderTotal}</span>`;
                folderDetails.appendChild(folderSummary);

                const fileList = document.createElement('ul');
                fileList.className = 'repo-file-list';

                for (const [fileName, fileContexts] of Object.entries(files)) {
                    const li = document.createElement('li');
                    li.className = 'repo-file-item';

                    const fileLink = document.createElement('span');
                    fileLink.className = 'repo-file-link';
                    fileLink.textContent = fileName;

                    const fileBadge = document.createElement('span');
                    fileBadge.className = 'error-badge';
                    fileBadge.textContent = fileContexts.length;

                    li.appendChild(fileLink);
                    li.appendChild(fileBadge);
                    li.addEventListener('click', () => loadErrorDetails(fileContexts[0]));

                    fileList.appendChild(li);
                }

                folderDetails.appendChild(fileList);
                catDetails.appendChild(folderDetails);
            }

            sidebarContent.appendChild(catDetails);
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
        
        homeView.classList.remove('active');
        errorListView.classList.remove('active');
        detailChatView.classList.add('active');
        detailChatMount.appendChild(chatSection);
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
        const activeContainer = homeView.classList.contains('active') ? homeContainer : detailContainer;
        const isMaximized = activeContainer.classList.toggle('chat-maximized');
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
    const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');
    const newChatBtn = document.getElementById('newChatBtn');
    const chatHistoryDrawer = document.getElementById('chatHistoryDrawer');
    const chatSessionList = document.getElementById('chatSessionList');

    toggleHistoryBtn.addEventListener('click', () => {
        chatHistoryDrawer.classList.toggle('open');
    });

    newChatBtn.addEventListener('click', () => {
        activeSessionId = null;
        chatHistory.innerHTML = '';
        chatHistoryDrawer.classList.remove('open');
        renderChatSessionList();
    });

    clearChatBtn.addEventListener('click', () => {
        chatHistory.innerHTML = '';
        if (activeSessionId) {
            const session = chatSessions.find(s => s.id === activeSessionId);
            if (session) {
                session.messages = [];
                persistChatSessions();
                renderChatSessionList();
            }
        }
    });

    function persistChatSessions() {
        vscode.setState({ draft: chatInput.value, activeSessionId });
        vscode.postMessage({ command: 'saveChatHistory', payload: chatSessions });
    }

    function ensureActiveSession(firstPromptText) {
        if (activeSessionId) {
            const existing = chatSessions.find(s => s.id === activeSessionId);
            if (existing) return existing;
        }

        const newSession = {
            id: 'chat-' + Date.now(),
            title: firstPromptText.length > 32 ? firstPromptText.slice(0, 32) + '...' : firstPromptText,
            issueTitle: currentActiveError?.issue?.title || 'General AODA',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            messages: []
        };

        chatSessions.unshift(newSession);
        activeSessionId = newSession.id;
        return newSession;
    }

    function saveMessageToActiveSession(htmlContent, isUser, rawText = '') {
        const session = ensureActiveSession(rawText || 'Chat');
        session.messages.push({ html: htmlContent, isUser });
        session.timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        persistChatSessions();
        renderChatSessionList();
    }

    function loadChatSession(sessionId) {
        const session = chatSessions.find(s => s.id === sessionId);
        if (!session) return;

        activeSessionId = session.id;
        vscode.setState({ draft: chatInput.value, activeSessionId });
        chatHistory.innerHTML = '';
        session.messages.forEach(m => appendMessage(m.html, m.isUser));
        chatHistoryDrawer.classList.remove('open');
        renderChatSessionList();
    }

    function deleteChatSession(sessionId, event) {
        event.stopPropagation();
        chatSessions = chatSessions.filter(s => s.id !== sessionId);
        if (activeSessionId === sessionId) {
            activeSessionId = null;
            chatHistory.innerHTML = '';
        }
        persistChatSessions();
        renderChatSessionList();
    }

    function renderChatSessionList() {
        if (!chatSessionList) return;
        chatSessionList.innerHTML = '';

        if (chatSessions.length === 0) {
            chatSessionList.innerHTML = '<div class="history-empty">No past chats yet.</div>';
            return;
        }

        chatSessions.forEach(session => {
            const item = document.createElement('div');
            item.className = 'history-item' + (session.id === activeSessionId ? ' active' : '');
            item.innerHTML = `
                <div class="history-item-content">
                    <div class="history-item-title">${escapeHTML(session.title)}</div>
                    <div class="history-item-meta">${escapeHTML(session.issueTitle)} • ${escapeHTML(session.timestamp)}</div>
                </div>
                <button class="history-delete-btn" title="Delete chat" aria-label="Delete chat">✕</button>
            `;

            item.addEventListener('click', () => loadChatSession(session.id));
            item.querySelector('.history-delete-btn').addEventListener('click', (e) => deleteChatSession(session.id, e));
            chatSessionList.appendChild(item);
        });
    }

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

        const safeUserHtml = escapeHTML(text);
        appendMessage(safeUserHtml, true);
        saveMessageToActiveSession(safeUserHtml, true, text);
        chatInput.value = '';
        vscode.setState({ draft: '', activeSessionId });
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
    chatInput.value = savedState.draft || '';
    activeSessionId = savedState.activeSessionId || null;
    chatInput.addEventListener('input', () => vscode.setState({ draft: chatInput.value, activeSessionId }));
    vscode.postMessage({ command: 'ready' });
    vscode.postMessage({ command: 'getChatHistory' });
});
