document.addEventListener('DOMContentLoaded', () => {
    let currentActiveError = null;

    // View Elements
    const errorListView = document.getElementById('error-list-view');
    const detailChatView = document.getElementById('detail-chat-view');
    const sidebarContent = document.getElementById('sidebar-content');
    const detailContainer = document.querySelector('.detail-container');
    
    // Buttons
    const backBtn = document.getElementById('backBtn');
    const maximizeChatBtn = document.getElementById('maximizeChatBtn');
    
    // 1. LISTEN FOR LIVE VS CODE DATA
    window.addEventListener('message', event => {
        const message = event.data; 
        if (message.type === 'SCAN_RESULTS') {
            populateSidebar(message.payload);
        }
    });

    // 2. DYNAMIC SIDEBAR GENERATION
    function populateSidebar(liveScanResults) {
        sidebarContent.innerHTML = '';
        const categories = {};
        
        if (!liveScanResults || liveScanResults.length === 0) {
            sidebarContent.innerHTML = '<p style="padding: 15px; color: var(--success);">No accessibility findings detected on this page.</p>';
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

            contexts.forEach(context => {
                const li = document.createElement('li');
                li.className = 'error-item';
                li.textContent = context.issue.title;
                li.addEventListener('click', () => loadErrorDetails(context));
                ul.appendChild(li);
            });

            details.appendChild(ul);
            sidebarContent.appendChild(details);
        }
    }

    // 3. CODE SUGGESTION ENGINE
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
        currentActiveError = context;
        
        // Switch Views
        errorListView.classList.remove('active');
        detailChatView.classList.add('active');
        detailContainer.classList.remove('chat-maximized');
        maximizeChatBtn.textContent = '⛶ Maximize Chat';

        const errorDesc = document.querySelector('.error-description');
        // Keep the code-block tags flush against the variable to prevent phantom indentation
        errorDesc.innerHTML = `
            <strong>${context.issue.title}</strong>
            <p>${context.issue.message}</p>
            <div class="code-header">
                <strong>Original Code:</strong>
            </div>
            <div class="code-block">${escapeHTML(formatCodeBlock(context.originalText))}</div>
        `;

        const codeDiff = document.querySelector('.code-diff-viewer');
        codeDiff.innerHTML = "<em>Analyzing rule and generating code suggestion...</em>";

        const dynamicFix = generateDynamicFix(context.issue.ruleId, context.originalText);
        const formattedFix = formatCodeBlock(dynamicFix);

        setTimeout(() => {
            codeDiff.innerHTML = `
                <div class="code-header">
                    <strong>Suggested Fix:</strong>
                    <button id="copyFixBtn" class="copy-btn" title="Copy to clipboard">
                        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path d="M3 1L2 2v10h1V2h6.414l-1-1H3z"/></svg>
                        Copy
                    </button>
                </div>
                <div class="code-block suggestion-block">${escapeHTML(formattedFix)}</div>
            `;

            // Wire up the Copy Button to the system clipboard
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

        }, 400); 
    }

    backBtn.addEventListener('click', () => {
        detailChatView.classList.remove('active');
        errorListView.classList.add('active');
    });

    maximizeChatBtn.addEventListener('click', () => {
        const isMaximized = detailContainer.classList.toggle('chat-maximized');
        maximizeChatBtn.textContent = isMaximized ? '🗗 Minimize Chat' : '⛶ Maximize Chat';
    });

    // 5. INTERACTIVE CHATBOT LOGIC
    const chatInput = document.getElementById('chatInput');
    const sendMsgBtn = document.getElementById('sendMsgBtn');
    const chatHistory = document.querySelector('.chat-history');

    function appendMessage(text, isUser) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-msg ${isUser ? 'msg-user' : 'msg-bot'}`;
        msgDiv.innerHTML = text; // Safe here as we construct it internally
        chatHistory.appendChild(msgDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (text === '') return;

        appendMessage(escapeHTML(text), true);
        chatInput.value = '';

        // Simulate Bot response
        setTimeout(() => {
            if (currentActiveError) {
                const wcag = currentActiveError.rule.wcagCriteria.join(", ");
                appendMessage(`Regarding <strong>${currentActiveError.issue.title}</strong>:<br><br>${currentActiveError.rule.remediation}<br><br><em>(WCAG Criteria: ${wcag})</em>`, false);
            } else {
                appendMessage("Please select an error from the list first.", false);
            }
        }, 600);
    }

    sendMsgBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

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