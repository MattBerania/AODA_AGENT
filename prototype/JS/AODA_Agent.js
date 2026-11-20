document.addEventListener('DOMContentLoaded', () => {
    let currentActiveError = null;
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
        scanPageBtn.classList.add('primary');
        scanRepoBtn.classList.remove('primary');
        detailChatView.classList.remove('active');
        errorListView.classList.add('active');
        sidebarContent.innerHTML = '<p style="padding: 15px;"><em>Scanning current page...</em></p>';
        vscode.postMessage({ command: 'scanCurrentPage' });
    });

    scanRepoBtn.addEventListener('click', () => {
        scanRepoBtn.classList.add('primary');
        scanPageBtn.classList.remove('primary');
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
            if (!currentActiveError || currentActiveError.issue.id !== message.issueId) {
                return;
            }
            const finalFix = message.payload 
                ? message.payload 
                : generateDynamicFix(currentActiveError.issue.ruleId, currentActiveError.originalText);
            
            renderSuggestedFix(finalFix);
        }
        else if (message.type === 'SELECT_ISSUE') {
            if (message.payload) {
                loadErrorDetails(message.payload);
            }
        }
        else if (message.type === 'FIX_APPLIED') {
            const generateBtn = document.getElementById('generateFixBtn');
            if (!generateBtn) return;

            if (message.success) {
                generateBtn.textContent = '✓ Applied!';
                generateBtn.style.color = 'var(--success-green)';
                generateBtn.style.borderColor = 'var(--success-green)';
            } else {
                generateBtn.disabled = false;
                generateBtn.textContent = 'Failed — Retry';
            }
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
            sidebarContent.innerHTML = '<p style="padding: 15px; color: var(--success);">Analyzed with no confirmed findings from the six implemented checks.</p>';
            return;
        }

        liveScanResults.forEach(context => {
            if (!context.issue) return;
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
            sidebarContent.innerHTML = '<p style="padding: 15px; color: var(--success-green);">Repository analyzed with no confirmed findings.</p>';
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

    // 3. FALLBACK CODE SUGGESTION ENGINE
    function generateDynamicFix(ruleId, originalText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(originalText, 'text/html');
        const element = ruleId === 'document-language' ? doc.documentElement : doc.body.firstChild;

        if (!element) return "Error parsing HTML.";

        switch (ruleId) {
            case 'document-language':
                element.setAttribute('lang', 'en');
                return `<html lang="en">`;
            case 'image-text-alternative':
                element.setAttribute('alt', 'Descriptive text required');
                return element.outerHTML;
            case 'form-control-name':
                if (!element.id) element.id = "input-id";
                return `<label for="${element.id}">Descriptive Label</label>\n${element.outerHTML}`;
            case 'button-name':
            case 'link-name':
                element.setAttribute('aria-label', 'Descriptive action name');
                return element.outerHTML;
            case 'iframe-name':
                element.setAttribute('title', 'Descriptive frame title');
                return element.outerHTML;
            default:
                return `<!-- Manual review required -->\n${originalText}`;
        }
    }

    // 4. NAVIGATION & DETAILS
    function loadErrorDetails(context) {
        const isNewError = !currentActiveError || currentActiveError.issue.id !== context.issue.id;
        currentActiveError = context;
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
            <strong>${context.issue.title}</strong>
            <p>${context.issue.message}</p>
            <div class="code-header">
                <strong>Original Code:</strong>
            </div>
            <div class="code-block">${escapeHTML(formatCodeBlock(context.originalText))}</div>
        `;

        const codeDiff = document.querySelector('.code-diff-viewer');
        codeDiff.innerHTML = "<em>Generating AI code suggestion...</em>";

        vscode.postMessage({
            command: 'generateFix',
            context: context
        });
    }

    function renderSuggestedFix(rawFix) {
        const codeDiff = document.querySelector('.code-diff-viewer');
        const formattedFix = formatCodeBlock(rawFix);

        codeDiff.innerHTML = `
            <div class="code-header">
                <strong>Suggested Fix:</strong>
                <div class="code-actions">
                    <button id="generateFixBtn" class="copy-btn generate-btn" title="Apply fix directly to code">
                        Generate
                    </button>
                    <button id="copyFixBtn" class="copy-btn" title="Copy to clipboard">
                        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10h1V2h6.414l-1-1H3z"/></svg>
                        Copy
                    </button>
                </div>
            </div>
            <div class="code-block suggestion-block">${escapeHTML(formattedFix)}</div>
        `;

        const generateBtn = document.getElementById('generateFixBtn');
        generateBtn.addEventListener('click', () => {
            if (!currentActiveError) return;
            generateBtn.disabled = true;
            generateBtn.textContent = 'Applying...';

            vscode.postMessage({
                command: 'applyFix',
                fixCode: formattedFix,
                context: currentActiveError
            });
        });

        const copyBtn = document.getElementById('copyFixBtn');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(formattedFix).then(() => {
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

    function formatCodeBlock(code) {
        if (!code) return '';
        const lines = code.split('\n');
        const minIndent = lines
            .filter(line => line.trim().length > 0)
            .reduce((min, line) => {
                const indent = line.match(/^\s*/)[0].length;
                return Math.min(min, indent);
            }, Infinity);
        return lines
            .map(line => line.substring(minIndent === Infinity ? 0 : minIndent))
            .join('\n')
            .trim();
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
            }[tag])
        );
    }
});