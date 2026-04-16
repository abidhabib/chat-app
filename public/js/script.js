let socket = null;
let authToken = localStorage.getItem('authToken');
let currentUser = localStorage.getItem('currentUser');
let partnerName = null;
let soundEnabled = false;
let windowHasFocus = true;
let inactivityTimer = null;
let typingTimeout = null;
let isTyping = false;
let statusInterval = null;

const INACTIVE_TIMEOUT = 2.5 * 60 * 1000;
const MESSAGE_PAGE_SIZE = 30;
const MAX_FILES = 5;
const MAX_FILE_SIZE = 32 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'application/pdf'
]);

const notificationSound = document.getElementById('notificationSound');
const loginOverlay = document.getElementById('loginOverlay');
const chatContainer = document.getElementById('chatContainer');
const loginForm = document.getElementById('loginForm');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const fileInput = document.getElementById('fileInput');
const sendButton = document.getElementById('sendButton');
const messagesContainer = document.getElementById('messagesContainer');
const messagesList = document.getElementById('messages');
const mediaPreview = document.getElementById('mediaPreview');
const loginError = document.getElementById('loginError');
const chatTitle = document.getElementById('chatTitle');
const partnerStatus = document.getElementById('partnerStatus');
const mediaLightbox = document.getElementById('mediaLightbox');
const mediaLightboxImage = document.getElementById('mediaLightboxImage');
const mediaLightboxVideo = document.getElementById('mediaLightboxVideo');
const mediaLightboxClose = document.getElementById('mediaLightboxClose');

const state = {
    page: 0,
    hasMore: true,
    isLoadingHistory: false,
    isSendingMessage: false,
    isUploading: false,
    initialHistoryLoaded: false,
    pendingFiles: [],
    messageIds: new Set(),
    clientMessageIds: new Set()
};

notificationSound.load();

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function normalizeMessage(message) {
    return {
        ...message,
        media_urls: Array.isArray(message.media_urls)
            ? message.media_urls
            : safeJsonParse(message.media_urls),
        media_types: Array.isArray(message.media_types)
            ? message.media_types
            : safeJsonParse(message.media_types)
    };
}

function safeJsonParse(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return [];
    }
}

function enableSound() {
    if (soundEnabled) return;

    notificationSound.volume = 0;
    notificationSound.play()
        .then(() => {
            soundEnabled = true;
            notificationSound.pause();
            notificationSound.currentTime = 0;
            notificationSound.volume = 1;
        })
        .catch(() => {});
}

['click', 'touchstart', 'keydown'].forEach((eventName) => {
    document.addEventListener(eventName, enableSound, { once: true });
});

window.addEventListener('focus', () => {
    windowHasFocus = true;
});

window.addEventListener('blur', () => {
    windowHasFocus = false;
});

function playNotificationSound() {
    if (!soundEnabled || windowHasFocus) return;

    notificationSound.currentTime = 0;
    notificationSound.play().catch(() => {});
}

function showLoginForm() {
    loginOverlay.style.display = 'flex';
    chatContainer.style.display = 'none';
    loginError.textContent = '';
}

function showChat() {
    loginOverlay.style.display = 'none';
    chatContainer.style.display = 'flex';
}

function getPartnerName(username) {
    return username.toLowerCase() === 'abid' ? 'sara' : 'abid';
}

async function validateSession() {
    if (!authToken) return false;

    try {
        const response = await fetch('/validate-session', {
            headers: {
                Authorization: `Bearer ${authToken}`
            }
        });

        return response.ok;
    } catch (error) {
        return false;
    }
}

function resetChatState() {
    clearTypingState();
    state.page = 0;
    state.hasMore = true;
    state.isLoadingHistory = false;
    state.isSendingMessage = false;
    state.isUploading = false;
    state.initialHistoryLoaded = false;
    state.pendingFiles = [];
    state.messageIds.clear();
    state.clientMessageIds.clear();
    messagesList.innerHTML = '';
    mediaPreview.innerHTML = '';
    fileInput.value = '';
    messageInput.value = '';
    closeMediaLightbox();
}

function clearTypingState() {
    window.clearTimeout(typingTimeout);

    if (socket?.connected && isTyping) {
        socket.emit('typing', { isTyping: false });
    }

    isTyping = false;
}

async function initializeChat() {
    partnerName = getPartnerName(currentUser);
    chatTitle.textContent = 'Chat';
    partnerStatus.textContent = `Talking with ${partnerName}`;
    showChat();
    resetChatState();
    setupActivityListeners();
    initializeSocket();
    await loadMessageHistory(0, { jumpToBottom: true });
}

function cleanupSocket() {
    if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
    }

    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
}

function initializeSocket() {
    cleanupSocket();

    socket = io({
        auth: {
            token: authToken
        }
    });

    socket.on('connect', () => {
        requestPartnerStatus();
    });

    socket.on('connect_error', (error) => {
        if (String(error.message || '').toLowerCase().includes('auth')) {
            handleAuthError();
        }
    });

    socket.on('initialStatus', (users) => {
        if (users && users[0]) {
            updatePartnerStatus({
                status: users[0].is_online ? 'online' : 'offline',
                lastSeen: users[0].last_seen
            });
        }
    });

    socket.on('userStatus', (payload) => {
        if (!payload.username || payload.username.toLowerCase() !== partnerName.toLowerCase()) {
            return;
        }
        updatePartnerStatus(payload);
    });

    socket.on('userTyping', (payload) => {
        if (payload.username?.toLowerCase() !== partnerName.toLowerCase()) return;
        if (payload.isTyping) {
            partnerStatus.textContent = 'typing...';
            partnerStatus.className = 'partner-status typing';
            return;
        }
        requestPartnerStatus();
    });

    socket.on('newMessage', (incoming) => {
        const message = normalizeMessage(incoming);
        const isOwn = message.sender.toLowerCase() === currentUser.toLowerCase();

        if (isOwn && message.client_message_id) {
            replacePendingMessage(message.client_message_id, message);
            return;
        }

        if (isDuplicateMessage(message)) {
            return;
        }

        const shouldStickToBottom = isNearBottom();
        renderMessage(message);

        if (isOwn || shouldStickToBottom) {
            revealLatestMessage();
        }

        if (!isOwn) {
            playNotificationSound();
        }
    });

    socket.on('disconnect', () => {
        partnerStatus.textContent = 'connecting...';
        partnerStatus.className = 'partner-status';
    });

    statusInterval = window.setInterval(requestPartnerStatus, 15000);
}

function requestPartnerStatus() {
    if (socket?.connected) {
        socket.emit('requestUserStatus');
    }
}

function updatePartnerStatus(payload) {
    partnerStatus.className = 'partner-status';

    if (payload.status === 'online') {
        partnerStatus.textContent = 'online';
        partnerStatus.classList.add('online');
        return;
    }

    if (payload.lastSeen) {
        partnerStatus.textContent = `last seen ${formatRelativeTime(payload.lastSeen)}`;
        return;
    }

    partnerStatus.textContent = 'offline';
}

function formatRelativeTime(value) {
    const date = new Date(value);
    const diffSeconds = Math.floor((Date.now() - date.getTime()) / 1000);

    if (diffSeconds < 60) return 'just now';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} min ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} hr ago`;
    return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function createLoadingIndicator() {
    let indicator = document.getElementById('loadingIndicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'loadingIndicator';
        indicator.className = 'loading-indicator';
        document.body.appendChild(indicator);
    }
    return indicator;
}

function showLoading(message) {
    const indicator = createLoadingIndicator();
    indicator.textContent = message;
    indicator.style.display = 'block';
}

function hideLoading() {
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
}

function isNearBottom() {
    const threshold = 120;
    return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
}

function scrollToBottom(smooth = true) {
    messagesContainer.scrollTo({
        top: messagesContainer.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
    });
}

function revealLatestMessage() {
    const lastMessage = messagesList.lastElementChild;
    const snap = () => {
        if (lastMessage) {
            lastMessage.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
        }
        messagesContainer.scrollTop = messagesContainer.scrollHeight - messagesContainer.clientHeight;
    };

    snap();
    requestAnimationFrame(() => {
        snap();
        requestAnimationFrame(snap);
    });
    window.setTimeout(snap, 120);
    window.setTimeout(snap, 280);
}

function ensureInitialBottomPosition() {
    revealLatestMessage();
    window.setTimeout(revealLatestMessage, 250);
    window.setTimeout(revealLatestMessage, 500);
}

async function loadMessageHistory(page = 0, options = {}) {
    if (state.isLoadingHistory || (!state.hasMore && page !== 0)) return;

    const { jumpToBottom = false } = options;
    state.isLoadingHistory = true;

    const previousHeight = messagesContainer.scrollHeight;
    const previousTop = messagesContainer.scrollTop;

    if (!state.initialHistoryLoaded) {
        showLoading('Loading messages...');
    } else {
        showHistoryLoader(true);
    }

    try {
        const response = await fetch(`/messages?page=${page}&limit=${MESSAGE_PAGE_SIZE}`, {
            headers: {
                Authorization: `Bearer ${authToken}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to load messages');
        }

        const data = await response.json();
        const messages = Array.isArray(data.messages) ? data.messages.map(normalizeMessage) : [];

        state.page = data.pagination?.page || page;
        state.hasMore = Boolean(data.pagination?.hasMore);

        if (page === 0) {
            messagesList.innerHTML = '';
            state.messageIds.clear();
            state.clientMessageIds.clear();
            messages.forEach((message) => renderMessage(message));
            state.initialHistoryLoaded = true;
            if (jumpToBottom) {
                ensureInitialBottomPosition();
            }
            return;
        }

        messages.forEach((message) => renderMessage(message, { prepend: true }));

        requestAnimationFrame(() => {
            const newHeight = messagesContainer.scrollHeight;
            messagesContainer.scrollTop = previousTop + (newHeight - previousHeight);
        });
    } catch (error) {
        console.error(error);
        if (String(error.message).toLowerCase().includes('auth')) {
            handleAuthError();
        }
    } finally {
        state.isLoadingHistory = false;
        hideLoading();
        showHistoryLoader(false);
    }
}

function showHistoryLoader(show) {
    let loader = document.getElementById('historyLoader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'historyLoader';
        loader.className = 'history-loader';
        loader.textContent = 'Loading older messages...';
        messagesContainer.prepend(loader);
    }
    loader.style.display = show ? 'block' : 'none';
}

function isDuplicateMessage(message) {
    if (message.id && state.messageIds.has(String(message.id))) return true;
    if (message.client_message_id && state.clientMessageIds.has(message.client_message_id)) return true;
    return false;
}

function rememberMessage(message) {
    if (message.id) {
        state.messageIds.add(String(message.id));
    }
    if (message.client_message_id) {
        state.clientMessageIds.add(message.client_message_id);
    }
}

function renderMessage(message, options = {}) {
    const { prepend = false, pending = false } = options;
    if (!pending && isDuplicateMessage(message)) return;

    const item = document.createElement('div');
    const isOwn = message.sender?.toLowerCase() === currentUser?.toLowerCase();
    item.className = `message-container ${isOwn ? 'sent' : 'received'}${pending ? ' pending' : ''}`;
    item.dataset.messageId = message.id || '';
    item.dataset.clientMessageId = message.client_message_id || '';

    const bubble = document.createElement('div');
    bubble.className = 'message';

    if (message.content) {
        const text = document.createElement('div');
        text.className = 'message-text';
        text.innerHTML = escapeHtml(message.content).replace(/\n/g, '<br>');
        bubble.appendChild(text);
    }

    if (message.media_urls?.length) {
        const gallery = document.createElement('div');
        gallery.className = 'message-media';
        message.media_urls.forEach((url, index) => {
            gallery.appendChild(createMediaElement(url, message.media_types[index]));
        });
        bubble.appendChild(gallery);
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = formatMessageTimestamp(message.timestamp, pending);
    bubble.appendChild(meta);

    item.appendChild(bubble);

    if (prepend && messagesList.firstChild) {
        messagesList.insertBefore(item, messagesList.firstChild);
    } else {
        messagesList.appendChild(item);
    }

    if (!pending) {
        rememberMessage(message);
    }
}

function replacePendingMessage(clientMessageId, message) {
    const pendingNode = messagesList.querySelector(`[data-client-message-id="${CSS.escape(clientMessageId)}"]`);
    if (!pendingNode) {
        renderMessage(message);
        if (message.sender?.toLowerCase() === currentUser?.toLowerCase() || isNearBottom()) {
            revealLatestMessage();
        }
        return;
    }

    const shouldStickToBottom = message.sender?.toLowerCase() === currentUser?.toLowerCase() || isNearBottom();
    pendingNode.remove();
    renderMessage(message);

    if (shouldStickToBottom) {
        revealLatestMessage();
    }
}

function updatePendingMessageState(clientMessageId, statusText, failed = false) {
    const node = messagesList.querySelector(`[data-client-message-id="${CSS.escape(clientMessageId)}"]`);
    if (!node) return;
    const meta = node.querySelector('.message-meta');
    if (meta) {
        meta.textContent = statusText;
    }
    node.classList.toggle('failed', failed);
}

function formatMessageTimestamp(value, pending = false) {
    if (pending) return 'Sending...';

    const date = new Date(value);
    return date.toLocaleString([], {
        hour: 'numeric',
        minute: '2-digit'
    });
}

function createMediaElement(url, type) {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-item';

    if (type === 'video') {
        wrapper.classList.add('clickable-media');
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        video.playsInline = true;
        video.src = url;
        video.addEventListener('play', (event) => {
            event.preventDefault();
            video.pause();
            openMediaLightbox('video', url);
        });
        video.addEventListener('click', (event) => {
            event.preventDefault();
            openMediaLightbox('video', url);
        });
        wrapper.addEventListener('click', () => {
            openMediaLightbox('video', url);
        });
        wrapper.appendChild(video);
        return wrapper;
    }

    if (type === 'pdf') {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.className = 'pdf-link';
        link.textContent = 'Open PDF';
        wrapper.appendChild(link);
        return wrapper;
    }

    const image = document.createElement('img');
    image.src = url;
    image.loading = 'lazy';
    image.alt = 'Shared media';
    wrapper.classList.add('clickable-media');
    image.addEventListener('click', () => {
        openMediaLightbox('image', url);
    });
    wrapper.appendChild(image);
    return wrapper;
}

function openMediaLightbox(kind, url) {
    if (!mediaLightbox || !mediaLightboxVideo || !mediaLightboxImage) return;

    mediaLightboxImage.classList.add('hidden');
    mediaLightboxVideo.classList.add('hidden');
    mediaLightboxVideo.pause();
    mediaLightboxVideo.removeAttribute('src');
    mediaLightboxImage.removeAttribute('src');

    if (kind === 'video') {
        mediaLightboxVideo.src = url;
        mediaLightboxVideo.classList.remove('hidden');
    } else {
        mediaLightboxImage.src = url;
        mediaLightboxImage.classList.remove('hidden');
    }

    mediaLightbox.classList.add('active');
    mediaLightbox.setAttribute('aria-hidden', 'false');

    if (kind === 'video') {
        const playPromise = mediaLightboxVideo.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {});
        }
    }
}

function closeMediaLightbox() {
    if (!mediaLightbox || !mediaLightboxVideo || !mediaLightboxImage) return;

    mediaLightboxVideo.pause();
    mediaLightboxVideo.removeAttribute('src');
    mediaLightboxImage.removeAttribute('src');
    mediaLightboxImage.classList.add('hidden');
    mediaLightboxVideo.classList.add('hidden');
    mediaLightbox.classList.remove('active');
    mediaLightbox.setAttribute('aria-hidden', 'true');
}

function setupScrollPagination() {
    messagesContainer.addEventListener('scroll', () => {
        if (messagesContainer.scrollTop < 120 && state.hasMore && !state.isLoadingHistory) {
            loadMessageHistory(state.page + 1);
        }
    });
}

function setupTypingHandler() {
    messageInput.addEventListener('input', () => {
        autoResizeTextarea();

        if (!socket?.connected) return;

        if (!isTyping) {
            isTyping = true;
            socket.emit('typing', { isTyping: true });
        }

        window.clearTimeout(typingTimeout);
        typingTimeout = window.setTimeout(() => {
            isTyping = false;
            socket.emit('typing', { isTyping: false });
        }, 1000);
    });

    messageInput.addEventListener('blur', () => {
        clearTypingState();
    });
}

function autoResizeTextarea() {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 140)}px`;
}

function setupActivityListeners() {
    ['mousedown', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach((eventName) => {
        document.addEventListener(eventName, resetInactivityTimer, { passive: true });
    });
    resetInactivityTimer();
}

function resetInactivityTimer() {
    window.clearTimeout(inactivityTimer);
    inactivityTimer = window.setTimeout(() => {
        handleLogout(true);
    }, INACTIVE_TIMEOUT);
}

function handleAuthError() {
    handleLogout(false);
}

function handleLogout(isAutoLogout) {
    if (socket?.connected) {
        socket.emit('logout');
    }

    cleanupSocket();
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    authToken = null;
    currentUser = null;
    partnerName = null;
    window.clearTimeout(inactivityTimer);
    resetChatState();
    showLoginForm();

    if (isAutoLogout) {
        loginError.textContent = 'Logged out after 2.5 minutes of inactivity.';
    }
}

function validateSelectedFiles(files) {
    const accepted = [];

    for (const file of files.slice(0, MAX_FILES)) {
        if (!ALLOWED_FILE_TYPES.has(file.type)) {
            alert(`${file.name} is not supported. Only images, videos, and PDFs are allowed.`);
            continue;
        }

        if (file.size > MAX_FILE_SIZE) {
            alert(`${file.name} is too large. Maximum size is 32MB.`);
            continue;
        }

        accepted.push(file);
    }

    return accepted;
}

function renderFilePreview() {
    mediaPreview.innerHTML = '';

    state.pendingFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'media-preview-item';
        item.dataset.index = String(index);

        if (file.type.startsWith('image/')) {
            const image = document.createElement('img');
            image.src = URL.createObjectURL(file);
            image.className = 'preview-image';
            item.appendChild(image);
        } else if (file.type.startsWith('video/')) {
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            video.className = 'preview-video';
            video.muted = true;
            item.appendChild(video);
        } else {
            const pdf = document.createElement('div');
            pdf.className = 'preview-pdf';
            pdf.textContent = 'PDF';
            item.appendChild(pdf);
        }

        const info = document.createElement('div');
        info.className = 'preview-info';
        info.innerHTML = `
            <span class="preview-name">${escapeHtml(file.name)}</span>
            <span class="preview-progress">Ready</span>
            <div class="progress-track"><div class="progress-bar"></div></div>
        `;
        item.appendChild(info);

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'remove-preview';
        removeButton.textContent = '×';
        removeButton.addEventListener('click', () => {
            state.pendingFiles.splice(index, 1);
            syncFileInput();
            renderFilePreview();
        });
        item.appendChild(removeButton);

        mediaPreview.appendChild(item);
    });
}

function syncFileInput() {
    const dataTransfer = new DataTransfer();
    state.pendingFiles.forEach((file) => dataTransfer.items.add(file));
    fileInput.files = dataTransfer.files;
}

function updatePreviewProgress(index, percent, text) {
    const item = mediaPreview.querySelector(`[data-index="${index}"]`);
    if (!item) return;
    const progress = item.querySelector('.progress-bar');
    const label = item.querySelector('.preview-progress');
    progress.style.width = `${percent}%`;
    label.textContent = text;
}

async function getCloudinarySignature() {
    const response = await fetch('/cloudinary/signature', {
        headers: {
            Authorization: `Bearer ${authToken}`
        }
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Upload service is unavailable');
    }

    return response.json();
}

function uploadFileToCloudinary(file, index, signature) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const endpoint = `https://api.cloudinary.com/v1_1/${signature.cloudName}/auto/upload`;
        const formData = new FormData();

        formData.append('file', file);
        formData.append('api_key', signature.apiKey);
        formData.append('timestamp', String(signature.timestamp));
        formData.append('signature', signature.signature);
        formData.append('folder', signature.folder);

        xhr.open('POST', endpoint, true);

        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;
            const percent = Math.round((event.loaded / event.total) * 100);
            updatePreviewProgress(index, percent, `Uploading ${percent}%`);
        };

        xhr.onerror = () => reject(new Error(`Failed to upload ${file.name}`));
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const payload = JSON.parse(xhr.responseText);
                updatePreviewProgress(index, 100, 'Uploaded');
                resolve({
                    url: payload.secure_url,
                    type: file.type.startsWith('image/')
                        ? 'image'
                        : file.type.startsWith('video/')
                            ? 'video'
                            : 'pdf'
                });
                return;
            }

            let message = `Failed to upload ${file.name}`;
            try {
                const payload = JSON.parse(xhr.responseText);
                message = payload.error?.message || message;
            } catch (error) {}
            reject(new Error(message));
        };

        xhr.send(formData);
    });
}

async function uploadPendingFiles() {
    if (!state.pendingFiles.length) {
        return { mediaUrls: [], mediaTypes: [] };
    }

    state.isUploading = true;
    const signature = await getCloudinarySignature();
    const uploads = [];

    for (const [index, file] of state.pendingFiles.entries()) {
        uploads.push(uploadFileToCloudinary(file, index, signature));
    }

    const results = await Promise.all(uploads);

    return {
        mediaUrls: results.map((item) => item.url),
        mediaTypes: results.map((item) => item.type)
    };
}

async function submitMessage() {
    if (state.isSendingMessage || state.isUploading) return;
    if (!socket?.connected) {
        alert('Waiting for connection. Please try again in a moment.');
        return;
    }

    const content = messageInput.value.trim();
    const hasMedia = state.pendingFiles.length > 0;

    if (!content && !hasMedia) {
        return;
    }

    const clientMessageId = crypto.randomUUID();
    clearTypingState();
    const optimisticMessage = {
        sender: currentUser,
        recipient: partnerName,
        content,
        media_urls: state.pendingFiles.map((file) => URL.createObjectURL(file)),
        media_types: state.pendingFiles.map((file) => (
            file.type.startsWith('image/')
                ? 'image'
                : file.type.startsWith('video/')
                    ? 'video'
                    : 'pdf'
        )),
        timestamp: new Date().toISOString(),
        client_message_id: clientMessageId
    };

    state.isSendingMessage = true;
    sendButton.disabled = true;
    renderMessage(optimisticMessage, { pending: true });
    revealLatestMessage();

    try {
        const mediaPayload = await uploadPendingFiles();

        const payload = {
            recipient: partnerName,
            content,
            mediaUrls: mediaPayload.mediaUrls,
            mediaTypes: mediaPayload.mediaTypes,
            clientMessageId
        };

        await new Promise((resolve, reject) => {
            socket.emit('sendMessage', payload, (response) => {
                if (!response || response.status !== 'sent' || !response.message) {
                    reject(new Error(response?.error || 'Message failed to send'));
                    return;
                }

                replacePendingMessage(clientMessageId, normalizeMessage(response.message));
                resolve();
            });
        });

        messageInput.value = '';
        state.pendingFiles = [];
        mediaPreview.innerHTML = '';
        fileInput.value = '';
        autoResizeTextarea();
        revealLatestMessage();
    } catch (error) {
        console.error(error);
        updatePendingMessageState(clientMessageId, 'Failed to send', true);
        alert(error.message);
    } finally {
        state.isSendingMessage = false;
        state.isUploading = false;
        sendButton.disabled = false;
    }
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginError.textContent = '';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || 'Login failed');
        }

        authToken = payload.token;
        currentUser = payload.username;
        localStorage.setItem('authToken', authToken);
        localStorage.setItem('currentUser', currentUser);
        await initializeChat();
    } catch (error) {
        loginError.textContent = error.message;
    }
});

messageForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitMessage();
});

fileInput.addEventListener('change', () => {
    state.pendingFiles = validateSelectedFiles(Array.from(fileInput.files));
    syncFileInput();
    renderFilePreview();
});

document.getElementById('logoutBtn').addEventListener('click', () => {
    handleLogout(false);
});

mediaLightboxClose?.addEventListener('click', closeMediaLightbox);
mediaLightbox?.addEventListener('click', (event) => {
    if (event.target === mediaLightbox) {
        closeMediaLightbox();
    }
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mediaLightbox?.classList.contains('active')) {
        closeMediaLightbox();
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    setupScrollPagination();
    setupTypingHandler();
    autoResizeTextarea();

    if (authToken && currentUser && await validateSession()) {
        await initializeChat();
    } else {
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        authToken = null;
        currentUser = null;
        showLoginForm();
    }
});
