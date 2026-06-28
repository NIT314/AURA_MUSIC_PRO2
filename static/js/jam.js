/*
  AURA JAM∞ - Real-time Synchronized Co-Listening WebSockets Engine
  Handles Playback Synchronization, Latency Drift Correction, Shared Queues, Chat & Reactions.
*/

class JitterBuffer {
    constructor(size = 10) {
        this.size = size;
        this.values = [];
    }
    add(value) {
        this.values.push(value);
        if (this.values.length > this.size) {
            this.values.shift();
        }
    }
    getMedian() {
        if (this.values.length === 0) return 0;
        const sorted = [...this.values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 !== 0) {
            return sorted[mid];
        }
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
}

const transmissionJitterBuffer = new JitterBuffer(10);
let currentMedianRTT = 0;

let targetPlaybackRate = 1.0;
let currentPlaybackRate = 1.0;
let rateRampActive = false;

function updatePlaybackRateRamp() {
    const audio = document.getElementById("audio-element");
    if (!audio) {
        rateRampActive = false;
        return;
    }
    
    const diff = targetPlaybackRate - currentPlaybackRate;
    if (Math.abs(diff) > 0.001) {
        const step = 0.002; // very smooth transition (0.2% change per tick)
        if (diff > 0) {
            currentPlaybackRate = Math.min(targetPlaybackRate, currentPlaybackRate + step);
        } else {
            currentPlaybackRate = Math.max(targetPlaybackRate, currentPlaybackRate - step);
        }
        
        if (Math.abs(audio.playbackRate - currentPlaybackRate) > 0.001) {
            audio.playbackRate = currentPlaybackRate;
            console.log(`Ramping playbackRate: ${audio.playbackRate.toFixed(4)}`);
        }
        // Use setTimeout instead of requestAnimationFrame for background execution safety
        setTimeout(updatePlaybackRateRamp, 100);
    } else {
        currentPlaybackRate = targetPlaybackRate;
        audio.playbackRate = currentPlaybackRate;
        rateRampActive = false;
    }
}

function setTargetPlaybackRate(rate) {
    targetPlaybackRate = rate;
    const audio = document.getElementById("audio-element");
    if (audio) {
        currentPlaybackRate = audio.playbackRate;
    }
    if (!rateRampActive) {
        rateRampActive = true;
        updatePlaybackRateRamp();
    }
}

let jamSocket = null;
let currentRoomCode = "";
let currentUsername = "";
let currentUserRole = "listener"; // Default
let currentJamRoomState = null;
let draggingElement = null;
let jamReconnectTimer = null;
let jamReconnectAttempts = 0;
let jamShouldReconnect = false; // Only reconnect if user hasn't manually left
const JAM_MAX_RECONNECT = 10; // Safar ke hisaab se limit badhayi (Lagatar 15 minute tak try karega)
const JAM_RECONNECT_BASE_MS = 1500;

let clockOffset = 0;
let clockSyncInProgress = false;
let clockSyncInterval = null;
let hostHeartbeatInterval = null;
let clockSynced = false;
let bufferedInitialState = null;

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
    
    const trimmedUser = username ? username.trim() : "";
    const trimmedRoom = roomCode ? roomCode.toUpperCase().trim() : "";
    if (!trimmedUser || !trimmedRoom) {
        showToast("Username and Room Code cannot be empty.");
        return;
    }
    
    currentUsername = trimmedUser;
    currentRoomCode = trimmedRoom;
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
    
    jamSocket.onopen = async () => {
        jamReconnectAttempts = 0;
        clearTimeout(jamReconnectTimer);
        setJamSyncStatus('online');
        
        await runClockSync();
        clockSynced = true;
        
        clearInterval(clockSyncInterval);
        clockSyncInterval = setInterval(runClockSync, 45000);
        
        if (!isReconnect) {
            showToast(`Connected to Party Room!`); // Sirf life mein ek baar (First time) dikhao
            document.getElementById("jam-lobby-view").classList.add("hide");
            document.getElementById("jam-room-view").classList.remove("hide");
            document.getElementById("jam-room-code-display").innerText = currentRoomCode;
            // Hide standard local player queue button if inside Jam
            document.getElementById("player-queue-toggle-btn").style.opacity = "0.5";
        }

        // Apply any room state packet that was buffered during the initial clock sync
        if (bufferedInitialState) {
            updateJamRoomUI(bufferedInitialState.state, bufferedInitialState.serverTime);
            bufferedInitialState = null;
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
        
        clearInterval(clockSyncInterval);
        clockSyncInterval = null;
        stopHostHeartbeat();
        
        if (event.code === 4001) {
            showToast("Username already taken. Choose a different name.");
            jamShouldReconnect = false;
            exitJamUI();
            return;
        }
        
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
    const icons = { 
        online: '\u25cf Connected', 
        reconnecting: '\u25cb Reconnecting...', 
        host_reconnecting: '\u25cb Host Reconnecting...',
        offline: '\u25cf Disconnected' 
    };
    indicator.innerHTML = `<i class="fa-solid fa-circle"></i> ${icons[status] || 'Unknown'}`;
}

function exitJamUI() {
    clearTimeout(jamReconnectTimer);
    clearInterval(clockSyncInterval);
    clockSyncInterval = null;
    stopHostHeartbeat();
    if (window.clearHostEQSyncUI) {
        window.clearHostEQSyncUI();
    }
    jamSocket = null;
    currentRoomCode = "";
    currentUserRole = "listener";
    jamShouldReconnect = false;
    jamReconnectAttempts = 0;
    clockSynced = false;
    bufferedInitialState = null;
    
    // Reset playback rate ramping variables
    targetPlaybackRate = 1.0;
    currentPlaybackRate = 1.0;
    rateRampActive = false;
    const audio = document.getElementById("audio-element");
    if (audio) {
        audio.playbackRate = 1.0;
    }
    
    document.getElementById("jam-lobby-view").classList.remove("hide");
    document.getElementById("jam-room-view").classList.add("hide");
    document.getElementById("player-queue-toggle-btn").style.opacity = "1";
}

function leaveJamRoom() {
    jamShouldReconnect = false; // Manual leave - don't reconnect
    clearTimeout(jamReconnectTimer);
    if (jamSocket) {
        const state = jamSocket.readyState;
        if (state === WebSocket.OPEN) {
            if (currentUserRole === 'host') {
                jamSocket.send(JSON.stringify({ type: "end_jam" }));
            } else {
                jamSocket.send(JSON.stringify({ type: "leave" }));
            }
        }
        // Force close if socket is connecting or open
        if (state <= WebSocket.OPEN) {
            setTimeout(() => {
                if (jamSocket) {
                    jamSocket.close();
                    jamSocket = null;
                }
                exitJamUI();
            }, 100);
            return;
        }
    }
    exitJamUI();
}

// Outgoing websocket transmissions

function sendJamPlaybackUpdate(video_id, state, position, trackData) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    
    // Only controllers or hosts should push playback syncs
    if (currentUserRole !== "host" && currentUserRole !== "co-host") return;

    // Gate local tracks
    if (video_id && video_id.startsWith("local_")) {
        showToast("⚠️ Local files cannot be shared in Jam sessions.");
        return;
    }
    
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

    // Gate local tracks
    if (song && song.id && song.id.startsWith("local_")) {
        showToast("⚠️ Local files cannot be shared in Jam sessions.");
        return;
    }

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

function sendJamSkipToPrev() {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "skip_to_prev"
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
        if (!clockSynced) {
            bufferedInitialState = { state: data.state, serverTime: data.server_time };
        } else {
            updateJamRoomUI(data.state, data.server_time);
        }
    } 
    else if (type === "playback_sync") {
        // If I am the sender, ignore. Or if I am the Host (Host is source of truth, doesn't sync from others)
        if (data.sender === currentUsername || currentUserRole === "host") {
            return;
        }
        
        syncLocalPlayback(data);
    } 
    else if (type === "error") {
        showToast(data.reason || "An error occurred.");
        if (data.code === 4001) {
            jamShouldReconnect = false;
            exitJamUI();
        }
    }
    else if (type === "chat_message") {
        appendJamChatMessage(data.message);
    } 
    else if (type === "chat_history") {
        const chatContainer = document.getElementById("jam-chat-messages");
        if (chatContainer) {
            chatContainer.innerHTML = "";
            data.history.forEach(msg => {
                appendJamChatMessage(msg);
            });
        }
    }
    else if (type === "reaction") {
        triggerFloatingReaction(data.username, data.emoji);
    }
    else if (type === "room_closed") {
        showToast("Host has ended the Jam session.");
        exitJamUI();
    }
    else if (type === "host_reconnecting") {
        showToast("Host connection lost. Waiting for host to reconnect...");
        setJamSyncStatus("host_reconnecting");
    }
    else if (type === "host_back") {
        showToast("Host has reconnected!");
        setJamSyncStatus("online");
    }
    else if (type === "eq_sync") {
        if (currentUserRole !== 'host' && window.applyHostEQState) {
            window.applyHostEQState(data.settings);
        }
    }
}

// UI State Bindings

function updateJamRoomUI(state, serverTime = null) {
    currentJamRoomState = state;
    // 1. Resolve current user role
    const me = state.users.find(u => u.username === currentUsername);
    if (me) {
        currentUserRole = me.role;
    }

    const leaveBtn = document.getElementById("leave-jam-btn");
    if (currentUserRole === "host") {
        if (leaveBtn) leaveBtn.innerText = "End Jam for Everyone";
        if (!hostHeartbeatInterval) {
            startHostHeartbeat();
        }
    } else {
        if (leaveBtn) leaveBtn.innerText = "Leave Room";
        stopHostHeartbeat();
    }

    const hostControls = document.getElementById("jam-host-controls");
    if (hostControls) {
        if (currentUserRole === "host") {
            hostControls.classList.remove("hide");
        } else {
            hostControls.classList.add("hide");
        }
    }
    const addOnlyToggle = document.getElementById("jam-add-only-toggle");
    if (addOnlyToggle) {
        addOnlyToggle.checked = !!state.add_only_mode;
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
                    <option value="host">Host (Transfer)</option>
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

    // 4. Render Queue
    const queueContainer = document.getElementById("jam-queue-list");
    if (draggingElement) {
        console.log("Drag in progress, skipping queue render to prevent interruption.");
    } else {
        queueContainer.innerHTML = "";
        
        if (state.queue.length === 0) {
            queueContainer.innerHTML = `<div class="empty-queue-msg">Queue is empty. Find songs in Search!</div>`;
        } else {
            const canControl = currentUserRole === "host" || currentUserRole === "co-host";
            const isActiveTrack = (item) => {
                return state.playback.current_track && state.playback.current_track.id === item.id;
            };

            state.queue.forEach((item, idx) => {
                const row = document.createElement("div");
                const active = isActiveTrack(item);
                row.className = `track-row ${active ? 'active-track' : ''}`;
                
                let dragHandleHTML = "";
                let menuBtnHTML = "";
                
                if (canControl) {
                    row.draggable = true;
                    row.setAttribute('data-id', item.id);
                    
                    // HTML5 Drag and Drop events
                    row.addEventListener('dragstart', (e) => {
                        draggingElement = row;
                        row.classList.add('row-dragging');
                        queueContainer.classList.add('queue-dragging-active');
                        e.dataTransfer.effectAllowed = 'move';
                        // Slight delay to allow the browser to snapshot the drag ghost
                        requestAnimationFrame(() => {
                            row.style.opacity = '0.4';
                        });
                    });
                    row.addEventListener('dragend', () => {
                        row.classList.remove('row-dragging');
                        row.style.opacity = '';
                        queueContainer.classList.remove('queue-dragging-active');
                        // Remove any leftover drop indicators
                        queueContainer.querySelectorAll('.track-row').forEach(r => {
                            r.classList.remove('drag-over-above', 'drag-over-below');
                        });
                        draggingElement = null;
                        const rows = Array.from(queueContainer.querySelectorAll('.track-row'));
                        const newIds = rows.map(r => r.getAttribute('data-id'));
                        if (window.sendJamReorderQueue) {
                            window.sendJamReorderQueue(newIds);
                        }
                    });
                    row.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        if (!draggingElement || draggingElement === row) return;
                        
                        const bounding = row.getBoundingClientRect();
                        const offset = e.clientY - bounding.top - (bounding.height / 2);
                        
                        // Clear previous indicators on other rows
                        queueContainer.querySelectorAll('.track-row').forEach(r => {
                            if (r !== row) {
                                r.classList.remove('drag-over-above', 'drag-over-below');
                            }
                        });
                        
                        if (offset > 0) {
                            row.classList.remove('drag-over-above');
                            row.classList.add('drag-over-below');
                            if (row.nextSibling !== draggingElement) {
                                row.after(draggingElement);
                            }
                        } else {
                            row.classList.remove('drag-over-below');
                            row.classList.add('drag-over-above');
                            if (row.previousSibling !== draggingElement) {
                                row.before(draggingElement);
                            }
                        }
                    });
                    row.addEventListener('dragleave', () => {
                        row.classList.remove('drag-over-above', 'drag-over-below');
                    });

                    dragHandleHTML = `
                        <button class="track-drag-handle" onclick="event.stopPropagation();" title="Drag to reorder">
                            <i class="fa-solid fa-grip-lines"></i>
                        </button>
                    `;
                    menuBtnHTML = `
                        <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${item.id}', {type: 'jam_queue'})">
                            <i class="fa-solid fa-ellipsis-vertical"></i>
                        </button>
                    `;
                }

                row.onclick = (event) => {
                    if (event.target.closest("button")) return;
                    
                    const role = window.getJamRole ? window.getJamRole() : 'listener';
                    if (role !== 'host' && role !== 'co-host') {
                        showToast("🎵 Only Host or Co-Host can change songs in Jam");
                        return;
                    }
                    
                    // Directly play and sync the song!
                    if (window.playSingleSong) {
                        window.playSingleSong(item);
                    } else if (typeof playSingleSong !== 'undefined') {
                        playSingleSong(item);
                    }
                    
                    if (window.isInsideJam && window.isInsideJam()) {
                        if (window.sendJamPlaybackUpdate) {
                            setTimeout(() => {
                                window.sendJamPlaybackUpdate(
                                    item.id,
                                    "PLAYING",
                                    0,
                                    item
                                );
                            }, 800);
                        }
                    }
                };

                row.innerHTML = `
                    <div class="track-row-art"><img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
                    <div class="track-row-info">
                        <h4 style="${active ? 'color: var(--gold);' : ''}">${escapeHTML(item.title)}</h4>
                        <p>${escapeHTML(item.artist)} • <span style="font-size:10px; color:var(--text-muted);">Added by ${escapeHTML(item.submitted_by)}</span></p>
                    </div>
                    <div class="track-row-actions">
                        <span class="track-duration-badge">${item.duration}</span>
                        ${menuBtnHTML}
                        ${dragHandleHTML}
                    </div>
                `;
                queueContainer.appendChild(row);
            });
        }
    }

    // 5. If my playback is completely empty and room has a playing song, sync it initial
    if (state.playback.current_track && state.playback.current_track.id) {
        // Render current playing song details
        // Wait, the client handles loading the song and seeking via syncLocalPlayback.
        // We trigger it initially if no song is loaded or IDs differ
        const loadedTrack = window.currentLoadedTrack;
        const audio = document.getElementById("audio-element");
        const stateMismatch = audio ? (audio.paused !== (state.playback.state === "PAUSED")) : false;
        
        if (!loadedTrack || loadedTrack.id !== state.playback.current_track.id || stateMismatch) {
            syncLocalPlayback({
                video_id: state.playback.current_track.id,
                state: state.playback.state,
                position: state.playback.position,
                track: state.playback.current_track,
                server_time: serverTime || (Date.now() + clockOffset)
            });
        }
    }
}

// co-playing alignment mechanism
function syncLocalPlayback(data) {
    const audio = document.getElementById("audio-element");
    if (!audio) return;

    const targetVideoId = data.video_id;
    const currentSong = window.currentLoadedTrack;

    // Host handles track change transitions, but skips playback state / drift adjustments.
    const isHost = (window.getJamRole && window.getJamRole() === 'host');
    if (isHost) {
        if (targetVideoId && (!currentSong || currentSong.id !== targetVideoId)) {
            showToast(`Syncing song: ${data.track.title}`);
            if (window.playSongById) {
                window.playSongById(targetVideoId, data.track, 0, data.state === "PLAYING");
            }
        } else if (!targetVideoId) {
            if (!audio.paused) audio.pause();
            if (window.onSongPlayStateChange) window.onSongPlayStateChange(false);
        }
        return;
    }
    const targetState = data.state;
    const targetPosition = parseFloat(data.position);

    // If empty track, stop playback
    if (!targetVideoId) {
        if (!audio.paused) audio.pause();
        if (window.onSongPlayStateChange) window.onSongPlayStateChange(false);
        setTargetPlaybackRate(1.0);
        return;
    }

    // Guard against buffering/seeking state
    if (audio.seeking || audio.readyState < 3) {
        console.log("Audio is buffering or seeking, skipping sync alignment.");
        return;
    }

    // 1. Calculate Latency/Drift Compensation using clockOffset and rolling Jitter Buffer
    const now = Date.now();
    const rawDelay = Math.max(0, (now + clockOffset) - data.server_time) / 1000.0;
    transmissionJitterBuffer.add(rawDelay);
    const transmissionDelay = transmissionJitterBuffer.getMedian();
    
    let compensatedTarget = targetPosition;
    if (targetState === "PLAYING") {
        compensatedTarget += transmissionDelay;
    }
    
    // Check if song needs to change
    if (!currentSong || currentSong.id !== targetVideoId) {
        showToast(`Syncing song: ${data.track.title}`);
        setTargetPlaybackRate(1.0);
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
        // drift > 0 means local is ahead (needs to slow down), drift < 0 means local is behind (needs to speed up)
        const drift = audio.currentTime - compensatedTarget;
        const absDrift = Math.abs(drift);
        
        let deadband = 0.050; // 50ms default deadband
        let maxTolerance = 1.0; // 1 second default for hard seek
        
        if (currentMedianRTT > 200) {
            deadband = 0.080;
            maxTolerance = 1.5;
        } else if (currentMedianRTT > 100) {
            deadband = 0.060;
            maxTolerance = 1.2;
        }

        if (absDrift > deadband) {
            if (absDrift > maxTolerance) {
                // Large drift: Hard seek
                console.log(`Playback drift detected (${Math.round(drift*1000)}ms). Hard seeking to ${compensatedTarget.toFixed(3)}s`);
                audio.currentTime = compensatedTarget;
                setTargetPlaybackRate(1.0);
            } else {
                // Minor drift: Perform elastic sync using target recovery window of 3 seconds
                const recoveryTime = 3.0;
                const rateOffset = -drift / recoveryTime;
                const clampedOffset = Math.max(-0.015, Math.min(0.015, rateOffset));
                const targetRate = 1.0 + clampedOffset;
                
                console.log(`Minor drift detected (${Math.round(drift * 1000)}ms). Adjusting target playbackRate to ${targetRate.toFixed(4)}`);
                setTargetPlaybackRate(targetRate);
            }
        } else {
            // Inside deadband: keep playbackRate at 1.0x
            if (targetPlaybackRate !== 1.0) {
                console.log(`Drift within deadband (${Math.round(drift * 1000)}ms). Resetting target playbackRate to 1.0`);
                setTargetPlaybackRate(1.0);
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
    
    const randomAngle = Math.random() * 60 - 30;
    element.style.cssText = `
        position: fixed;
        bottom: 120px;
        left: ${startX}vw;
        font-size: 34px;
        z-index: 10000;
        pointer-events: none;
        animation: float-emoji-up 2.5s ease-out forwards;
        --rotate-angle: ${randomAngle}deg;
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
    chatMsg.innerHTML = `<span style="font-size:10px;">${escapeHTML(text)}</span>`;
    
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
        msgCard.innerHTML = `<span>${escapeHTML(msg.message)}</span>`;
    } else {
        msgCard.innerHTML = `
            <div class="msg-meta">
                <span>${escapeHTML(msg.username)}</span>
                <span>${escapeHTML(msg.time)}</span>
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
        100% { transform: translateY(-400px) scale(0.8) rotate(var(--rotate-angle, 0deg)); opacity: 0; }
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

async function runClockSync() {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    if (clockSyncInProgress) return;
    clockSyncInProgress = true;
    
    const samples = [];
    const numRounds = 5;
    
    for (let i = 0; i < numRounds; i++) {
        if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) break;
        
        const t0 = Date.now();
        
        const sample = await new Promise((resolve) => {
            const tempListener = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "pong" && data.t0 === t0) {
                        const t3 = Date.now();
                        const t1 = parseFloat(data.t1);
                        const t2 = parseFloat(data.t2);
                        
                        const offset = ((t1 - t0) + (t2 - t3)) / 2;
                        const rtt = (t3 - t0) - (t2 - t1);
                        
                        if (jamSocket) {
                            try {
                                jamSocket.removeEventListener("message", tempListener);
                            } catch(e) {}
                        }
                        resolve({ offset, rtt });
                    }
                } catch(e) {}
            };
            
            jamSocket.addEventListener("message", tempListener);
            jamSocket.send(JSON.stringify({ type: "ping", t0: t0 }));
            
            setTimeout(() => {
                if (jamSocket) {
                    try {
                        jamSocket.removeEventListener("message", tempListener);
                    } catch(e) {}
                }
                resolve(null);
            }, 1000);
        });
        
        if (sample) {
            samples.push(sample);
        }
        
        await new Promise(r => setTimeout(r, 100));
    }
    
    clockSyncInProgress = false;
    
    if (samples.length > 0) {
        samples.sort((a, b) => a.rtt - b.rtt);
        const bestSamples = samples.slice(0, Math.ceil(samples.length / 2));
        const avgOffset = bestSamples.reduce((sum, s) => sum + s.offset, 0) / bestSamples.length;
        clockOffset = avgOffset;
        currentMedianRTT = samples[0].rtt;
        console.log(`Clock sync: offset=${Math.round(clockOffset)}ms. RTT median=${Math.round(samples[0].rtt)}ms.`);
        
        // Trigger a sync alignment check once the initial clock offset is resolved!
        if (currentJamRoomState && currentUserRole !== "host") {
            const state = currentJamRoomState;
            if (state.playback.current_track && state.playback.current_track.id) {
                syncLocalPlayback({
                    video_id: state.playback.current_track.id,
                    state: state.playback.state,
                    position: state.playback.position,
                    track: state.playback.current_track,
                    server_time: Date.now() + clockOffset
                });
            }
        }
    }
}

function startHostHeartbeat() {
    stopHostHeartbeat();
    hostHeartbeatInterval = setInterval(() => {
        if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
        if (currentUserRole !== 'host') {
            stopHostHeartbeat();
            return;
        }
        
        const audio = document.getElementById("audio-element");
        if (audio && !audio.paused && window.currentLoadedTrack) {
            // Gate local tracks from heartbeat sync
            if (window.currentLoadedTrack.id.startsWith("local_")) return;
            
            jamSocket.send(JSON.stringify({
                type: "heartbeat_sync",
                position: audio.currentTime,
                video_id: window.currentLoadedTrack.id
            }));
        }
    }, 12000);
}

function stopHostHeartbeat() {
    if (hostHeartbeatInterval) {
        clearInterval(hostHeartbeatInterval);
        hostHeartbeatInterval = null;
    }
}

function sendJamEQState(settings) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    if (currentUserRole !== "host" && currentUserRole !== "co-host") return;
    jamSocket.send(JSON.stringify({
        type: "eq_sync",
        settings: settings
    }));
}

function sendJamReorderQueue(queueIds) {
    if (!jamSocket || jamSocket.readyState !== WebSocket.OPEN) return;
    jamSocket.send(JSON.stringify({
        type: "reorder_queue",
        queue_ids: queueIds
    }));
}

// Export symbols to window
window.connectJamRoom = connectJamRoom;
window.leaveJamRoom = leaveJamRoom;
window.sendJamPlaybackUpdate = sendJamPlaybackUpdate;
window.sendJamAddQueue = sendJamAddQueue;
window.sendJamVoteQueue = sendJamVoteQueue;
window.sendJamRemoveQueue = sendJamRemoveQueue;
window.sendJamReorderQueue = sendJamReorderQueue;
window.sendJamSkipToNext = sendJamSkipToNext;
window.sendJamSkipToPrev = sendJamSkipToPrev;
window.sendJamChatMessage = sendJamChatMessage;
window.sendJamReaction = sendJamReaction;
window.sendJamSetRole = sendJamSetRole;
window.sendJamEQState = sendJamEQState;
window.isInsideJam = () => jamSocket !== null && jamSocket.readyState === WebSocket.OPEN;
window.getJamRole = () => currentUserRole;
window.getJamUsername = () => currentUsername;
window.getJamQueue = () => currentJamRoomState ? currentJamRoomState.queue : [];
window.getJamAddOnlyMode = () => currentJamRoomState ? currentJamRoomState.add_only_mode : false;

// Wire up Host Add-Only Mode toggle button
document.addEventListener("DOMContentLoaded", () => {
    const addOnlyToggle = document.getElementById("jam-add-only-toggle");
    if (addOnlyToggle) {
        addOnlyToggle.addEventListener("change", (e) => {
            if (jamSocket && jamSocket.readyState === WebSocket.OPEN) {
                jamSocket.send(JSON.stringify({
                    type: "toggle_add_only",
                    enabled: e.target.checked
                }));
            }
        });
    }
});

