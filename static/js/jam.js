/*
  AURA JAM∞ - Real-time Synchronized Co-Listening WebSockets Engine
  Handles Playback Synchronization, Latency Drift Correction, Shared Queues, Chat & Reactions.
*/

let jamSocket = null;
let currentRoomCode = "";
let currentUsername = "";
let currentUserRole = "listener"; // Default
let jamReconnectTimer = null;
let jamReconnectAttempts = 0;
let jamShouldReconnect = false; // Only reconnect if user hasn't manually left
const JAM_MAX_RECONNECT = 100; // Safar ke hisaab se limit badhayi (Lagatar 15 minute tak try karega)
const JAM_RECONNECT_BASE_MS = 1500;

// 🔥 SMART NETWORK LISTENER: Jaise hi phone mein internet wapas aayega, turant reconnect fire hoga
window.addEventListener('online', () => {
    if (jamShouldReconnect && (!jamSocket || jamSocket.readyState !== WebSocket.OPEN)) {
        clearTimeout(jamReconnectTimer);
        connectJamRoom(currentUsername, currentRoomCode, true);
    }
});

function connectJamRoom(username, roomCode, isReconnect = false) {
    if (jamSocket && jamSocket.readyState === WebSocket.OPEN) {
        jamSocket.close();
    }
    
    currentUsername = username.trim();
    currentRoomCode = roomCode.toUpperCase().trim();
    jamShouldReconnect = true;
    
    // Construct WebSockets URL
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/jam/ws/${currentRoomCode}?username=${encodeURIComponent(currentUsername)}`;
    
    if (!isReconnect) {
        showToast(`Connecting to Room ${currentRoomCode}...`);
    } else {
        // UI mein chupchaap background mein reconnect karenge bina user ko disturb kiye
        setJamSyncStatus('reconnecting');
    }
    
    try {
        jamSocket = new WebSocket(wsUrl);
    } catch (e) {
        console.error('WebSocket creation failed:', e);
        scheduleJamReconnect();
        return;
    }
    
    jamSocket.onopen = () => {
        jamReconnectAttempts = 0;
        clearTimeout(jamReconnectTimer);
        setJamSyncStatus('online');
        
        if (!isReconnect) {
            showToast(`Connected to Party Room!`); // Sirf life mein ek baar (First time) dikhao
            document.getElementById("jam-lobby-view").classList.add("hide");
            document.getElementById("jam-room-view").classList.remove("hide");
            document.getElementById("jam-room-code-display").innerText = currentRoomCode;
            // Hide standard local player queue button if inside Jam
            document.getElementById("player-queue-toggle-btn").style.opacity = "0.5";
        }
    };
    
    jamSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleJamWSMessage(data);
        } catch (err) {
            console.error("Failed to parse Jam WS packet:", err);
        }
    };
    
    jamSocket.onerror = (err) => {
        console.error("Jam WebSocket Error:", err);
    };
    
    jamSocket.onclose = (event) => {
        console.log(`Jam WS closed: code=${event.code}, clean=${event.wasClean}`);
        setJamSyncStatus('offline');
        
        if (jamShouldReconnect) {
            scheduleJamReconnect();
        } else {
            exitJamUI();
        }
    };
}

function scheduleJamReconnect() {
    if (!jamShouldReconnect) return;
    if (jamReconnectAttempts >= JAM_MAX_RECONNECT) {
        showToast("Connection lost. Could not reconnect to Jam room.");
        jamShouldReconnect = false;
        exitJamUI();
        return;
    }
    
    jamReconnectAttempts++;
    const delay = Math.min(JAM_RECONNECT_BASE_MS * Math.pow(1.5, jamReconnectAttempts - 1), 15000);
    console.log(`Jam reconnect in ${Math.round(delay)}ms (attempt ${jamReconnectAttempts})`);
    setJamSyncStatus('reconnecting');
    
    jamReconnectTimer = setTimeout(() => {
        connectJamRoom(currentUsername, currentRoomCode, true);
    }, delay);
}

function setJamSyncStatus(status) {
    const indicator = document.querySelector('.sync-indicator');
    if (!indicator) return;
    indicator.className = `sync-indicator ${status}`;
    const icons = { online: '\u25cf Connected', reconnecting: '\u25cb Reconnecting...', offline: '\u25cf Disconnected' };
    indicator.innerHTML = `<i class="fa-solid fa-circle"></i> ${icons[status] || 'Unknown'}`;
}

function exitJamUI() {
    clearTimeout(jamReconnectTimer);
    jamSocket = null;
    currentRoomCode = "";
    currentUserRole = "listener";
    jamShouldReconnect = false;
    jamReconnectAttempts = 0;
    document.getElementById("jam-lobby-view").classList.remove("hide");
    document.getElementById("jam-room-view").classList.add("hide");
    document.getElementById("player-queue-toggle-btn").style.opacity = "1";
}

function leaveJamRoom() {
    jamShouldReconnect = false; // Manual leave - don't reconnect
    clearTimeout(jamReconnectTimer);
    if (jamSocket) {
        jamSocket.close();
        jamSocket = null;
    }
    exitJamUI();
}

// Outgoing websocket transmissions

function sendJamPlaybackUpdate(video_id, state, position, trackData) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    
    // Only controllers or hosts should push playback syncs
    if (currentUserRole !== "host" && currentUserRole !== "co-host") return;
    
    jamSocket.send(JSON.stringify({
        type: "playback_update",
        video_id: video_id,
        state: state,
        position: parseFloat(position),
        track: trackData
    }));
}

function sendJamAddQueue(song) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "add_queue",
        song: song
    }));
}

function sendJamVoteQueue(songId, vote) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "vote_queue",
        song_id: songId,
        vote: parseInt(vote)
    }));
}

function sendJamRemoveQueue(songId) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "remove_queue",
        song_id: songId
    }));
}

function sendJamSkipToNext() {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "skip_to_next"
    }));
}

function sendJamChatMessage(msg) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "chat",
        message: msg
    }));
}

function sendJamReaction(emoji) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "reaction",
        emoji: emoji
    }));
}

function sendJamSetRole(targetUser, role) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "set_role",
        target_user: targetUser,
        role: role
    }));
}

// Incoming websocket router

function handleJamWSMessage(data) {
    const type = data.type;
    
    if (type === "room_state") {
        updateJamRoomUI(data.state);
    } 
    else if (type === "playback_sync") {
        // If I am the sender, ignore. Or if I am the Host (Host is source of truth, doesn't sync from others)
        if (data.sender === currentUsername || currentUserRole === "host") {
            return;
        }
        
        syncLocalPlayback(data);
    } 
    else if (type === "chat_message") {
        appendJamChatMessage(data.message);
    } 
    else if (type === "reaction") {
        triggerFloatingReaction(data.username, data.emoji);
    }
}

// UI State Bindings

function updateJamRoomUI(state) {
    // 1. Resolve current user role
    const me = state.users.find(u => u.username === currentUsername);
    if (me) {
        currentUserRole = me.role;
    }
    
    // 2. Update stats and count
    const listenersCount = state.users.length;
    document.getElementById("jam-participant-count").innerHTML = `<i class="fa-solid fa-users"></i> ${listenersCount} Listener${listenersCount > 1 ? 's' : ''}`;
    
    // 3. Render Users list
    const usersContainer = document.getElementById("jam-users-list");
    usersContainer.innerHTML = "";
    
    state.users.forEach((user) => {
        const chip = document.createElement("div");
        chip.className = `participant-chip ${user.role === 'host' ? 'host-chip' : ''}`;
        
        // Host option controls inside chip dropdown
        let actionHTML = "";
        if (currentUserRole === "host" && user.username !== currentUsername) {
            actionHTML = `
                <select class="role-selector" onchange="sendJamSetRole('${user.username}', this.value)" style="background:transparent; border:none; color:inherit; font-size:10px; cursor:pointer;">
                    <option value="listener" ${user.role === 'listener' ? 'selected' : ''}>Listener</option>
                    <option value="contributor" ${user.role === 'contributor' ? 'selected' : ''}>Contributor</option>
                    <option value="moderator" ${user.role === 'moderator' ? 'selected' : ''}>Mod</option>
                    <option value="co-host" ${user.role === 'co-host' ? 'selected' : ''}>Co-Host</option>
                </select>
            `;
        } else {
            actionHTML = `<span class="role-badge">${user.role}</span>`;
        }

        chip.innerHTML = `
            <i class="fa-solid ${user.role === 'host' ? 'fa-crown' : 'fa-user'}"></i>
            <span>${user.username}</span>
            ${actionHTML}
        `;
        usersContainer.appendChild(chip);
    });

    // 4. Render Shared Queue with upvote/downvote scores
    const queueContainer = document.getElementById("jam-queue-list");
    queueContainer.innerHTML = "";
    
    if (state.queue.length === 0) {
        queueContainer.innerHTML = `<div class="empty-queue-msg">Queue is empty. Find songs in Search!</div>`;
    } else {
        state.queue.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "track-row";
            
            // Check if user already upvoted/downvoted
            const userVote = item.votes[currentUsername] || 0;
            const upClass = userVote === 1 ? "text-primary glow-gold" : "";
            const downClass = userVote === -1 ? "text-primary glow-purple" : "";
            
            let removeBtnHTML = "";
            if (currentUserRole === "host" || currentUserRole === "co-host" || currentUserRole === "moderator" || item.submitted_by === currentUsername) {
                removeBtnHTML = `<button onclick="sendJamRemoveQueue('${item.id}')" title="Remove"><i class="fa-solid fa-trash-can"></i></button>`;
            }

            row.innerHTML = `
                <div class="track-row-art"><img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
                <div class="track-row-info">
                    <h4>${item.title}</h4>
                    <p>${item.artist} • <span style="font-size:10px; color:var(--text-muted);">Added by ${item.submitted_by}</span></p>
                </div>
                <div class="track-row-actions">
                    <span class="track-duration-badge">${item.duration}</span>
                    <button class="${upClass}" onclick="sendJamVoteQueue('${item.id}', ${userVote === 1 ? 0 : 1})" title="Upvote"><i class="fa-solid fa-thumbs-up"></i></button>
                    <span style="font-size:12px; font-weight:700; color:var(--gold); min-width:14px; text-align:center;">${item.net_votes}</span>
                    <button class="${downClass}" onclick="sendJamVoteQueue('${item.id}', ${userVote === -1 ? 0 : -1})" title="Downvote"><i class="fa-solid fa-thumbs-down"></i></button>
                    ${removeBtnHTML}
                </div>
            `;
            queueContainer.appendChild(row);
        });
    }

    // 5. If my playback is completely empty and room has a playing song, sync it initial
    if (state.playback.current_track && state.playback.current_track.id) {
        // Render current playing song details
        // Wait, the client handles loading the song and seeking via syncLocalPlayback.
        // We trigger it initially if no song is loaded or IDs differ
        const loadedTrack = window.currentLoadedTrack;
        if (!loadedTrack || loadedTrack.id !== state.playback.current_track.id) {
            syncLocalPlayback({
                video_id: state.playback.current_track.id,
                state: state.playback.state,
                position: state.playback.position,
                track: state.playback.current_track,
                server_time: state.playback.last_updated * 1000
            });
        }
    }
}

// co-playing alignment mechanism
function syncLocalPlayback(data) {
    const audio = document.getElementById("audio-element");
    if (!audio) return;
    
    const targetVideoId = data.video_id;
    const targetState = data.state;
    const targetPosition = parseFloat(data.position);
    
    // If empty track, stop playback
    if (!targetVideoId) {
        if (!audio.paused) {
            audio.pause();
        }
        if (window.onSongPlayStateChange) window.onSongPlayStateChange(false);
        return;
    }
    
    // 1. Calculate Latency/Drift Compensation
    const now = Date.now();
    const transmissionDelay = Math.max(0, now - data.server_time) / 1000.0;
    
    let compensatedTarget = targetPosition;
    if (targetState === "PLAYING") {
        compensatedTarget += transmissionDelay;
    }
    
    const currentSong = window.currentLoadedTrack;
    
    // Check if song needs to change
    if (!currentSong || currentSong.id !== targetVideoId) {
        showToast(`Syncing song: ${data.track.title}`);
        if (window.playSongById) {
            window.playSongById(targetVideoId, data.track, compensatedTarget, targetState === "PLAYING");
        }
    } else {
        // Song is identical. Align states
        if (targetState === "PLAYING" && audio.paused) {
            audio.play().catch(() => {
                showToast("Tap screen to authorize audio playback sync");
            });
            if (window.onSongPlayStateChange) window.onSongPlayStateChange(true);
        } else if (targetState === "PAUSED" && !audio.paused) {
            audio.pause();
            if (window.onSongPlayStateChange) window.onSongPlayStateChange(false);
        }
        
        // Align timestamps (drift thresholds)
        const drift = Math.abs(audio.currentTime - compensatedTarget);
        if (drift > 0.150) { // 150ms drift limit
            console.log(`Playback drift detected (${Math.round(drift*1000)}ms). Aligning...`);
            
            // Perform silent latency correction:
            // If drift is minor (e.g. <500ms), we can speed up/slow down rate, else hard seek
            if (drift < 1.0) {
                if (audio.currentTime < compensatedTarget) {
                    audio.playbackRate = 1.08; // slightly faster
                    setTimeout(() => { audio.playbackRate = 1.0; }, 2000);
                } else {
                    audio.playbackRate = 0.92; // slightly slower
                    setTimeout(() => { audio.playbackRate = 1.0; }, 2000);
                }
            } else {
                // Large drift: Hard seek
                audio.currentTime = compensatedTarget;
            }
        }
    }
}

// Emojis reaction animation - FIXED positioning
function triggerFloatingReaction(username, emoji) {
    // Create animated emoji floating up on the screen
    const element = document.createElement("div");
    element.className = "floating-emoji";
    element.innerText = emoji;
    
    // Random side coordinate offsets
    const startX = Math.random() * 70 + 10; // 10% to 80% horizontal range
    
    element.style.cssText = `
        position: fixed;
        bottom: 120px;
        left: ${startX}vw;
        font-size: 34px;
        z-index: 10000;
        pointer-events: none;
        animation: float-emoji-up 2.5s ease-out forwards;
    `;
    
    document.body.appendChild(element);
    
    // Remove element after animation completes
    setTimeout(() => {
        if (element.parentNode) element.remove();
    }, 2600);

    // Show temporary toast for reaction
    showMiniBubble(`${username} reacted: ${emoji}`);
}

function showMiniBubble(text) {
    // Visual trace of party reactions
    const chatMsg = document.createElement("div");
    chatMsg.className = "chat-msg system-msg";
    chatMsg.innerHTML = `<span style="font-size:10px;">${text}</span>`;
    
    const chatContainer = document.getElementById("jam-chat-messages");
    if (chatContainer) {
        chatContainer.appendChild(chatMsg);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
}

// Chat UI rendering

function appendJamChatMessage(msg) {
    const chatContainer = document.getElementById("jam-chat-messages");
    if (!chatContainer) return;
    
    const isSelf = msg.username === currentUsername;
    const msgCard = document.createElement("div");
    msgCard.className = `chat-msg ${isSelf ? 'self-msg' : ''} ${msg.type === 'system' ? 'system-msg' : ''}`;
    
    if (msg.type === 'system') {
        msgCard.innerHTML = `<span>${msg.message}</span>`;
    } else {
        msgCard.innerHTML = `
            <div class="msg-meta">
                <span>${msg.username}</span>
                <span>${msg.time}</span>
            </div>
            <div class="msg-content">${escapeHTML(msg.message)}</div>
        `;
    }
    
    chatContainer.appendChild(msgCard);
    
    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function escapeHTML(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Add animation stylesheet dynamically for floating emojis
const jamStyles = document.createElement("style");
jamStyles.innerText = `
    @keyframes float-emoji-up {
        0% { transform: translateY(0) scale(0.6) rotate(0deg); opacity: 0; }
        10% { opacity: 1; transform: translateY(-30px) scale(1.2); }
        90% { opacity: 0.8; }
        100% { transform: translateY(-400px) scale(0.8) rotate(${Math.random() * 60 - 30}deg); opacity: 0; }
    }
    .role-selector {
        background: rgba(255,255,255,0.06);
        border: 1px solid var(--border-glass);
        color: var(--text-primary);
        border-radius: 6px;
        padding: 2px 4px;
        font-size: 11px;
    }
    .role-selector option {
        background: #08080c;
        color: #fff;
    }
    .glow-gold {
        color: var(--gold) !important;
        text-shadow: 0 0 8px var(--gold-glow);
    }
    .glow-purple {
        color: var(--purple) !important;
        text-shadow: 0 0 8px rgba(155, 93, 229, 0.4);
    }
`;
document.head.appendChild(jamStyles);

// Export symbols to window
window.connectJamRoom = connectJamRoom;
window.leaveJamRoom = leaveJamRoom;
window.sendJamPlaybackUpdate = sendJamPlaybackUpdate;
window.sendJamAddQueue = sendJamAddQueue;
window.sendJamVoteQueue = sendJamVoteQueue;
window.sendJamRemoveQueue = sendJamRemoveQueue;
window.sendJamSkipToNext = sendJamSkipToNext;
window.sendJamChatMessage = sendJamChatMessage;
window.sendJamReaction = sendJamReaction;
window.sendJamSetRole = sendJamSetRole;
window.isInsideJam = () => jamSocket !== null && jamSocket.readyState === WebSocket.OPEN;
window.getJamRole = () => currentUserRole;
window.getJamUsername = () => currentUsername;
