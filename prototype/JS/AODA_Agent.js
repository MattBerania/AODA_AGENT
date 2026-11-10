/// JS SKELETON FILE TO IMPLEMENT TO DECOM.. APP
document.addEventListener('DOMContentLoaded', () => {
    const launcherBtn = document.getElementById('aoda-launcher');
    const sidebar = document.getElementById('aoda-sidebar');
    const sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
    const errorItems = document.querySelectorAll('.error-item');
    const detailPanel = document.getElementById('aoda-detail-panel');
    const chatCloseBtn = document.getElementById('chatCloseBtn');

    // Open Sidebar
    launcherBtn.addEventListener('click', () => {
        sidebar.classList.add('is-open');
    });

    // Close Sidebar
    sidebarCloseBtn.addEventListener('click', () => {
        sidebar.classList.remove('is-open');
        detailPanel.classList.remove('chat-container-is-open');
    });

    // Open Detail Panel
    errorItems.forEach(item => {
        item.addEventListener('click', () => {
            detailPanel.classList.add('chat-container-is-open');
        });
    });

    // Close Detail Panel
    chatCloseBtn.addEventListener('click', () => {
        detailPanel.classList.remove('chat-container-is-open');
    });

    // Chat functionality
    const chatInput = document.getElementById('chatInput');
    const sendMsgBtn = document.getElementById('sendMsgBtn');
    const chatHistory = document.querySelector('.chat-history');

    function sendMessage() {
        if (chatInput.value.trim() === '') return;

        const msgDiv = document.createElement('div');
        msgDiv.textContent = chatInput.value;
        chatHistory.appendChild(msgDiv);

        chatInput.value = '';
    }

    sendMsgBtn.addEventListener('click', sendMessage);
});