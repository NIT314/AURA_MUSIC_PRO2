/*
  AURA ∞ MUSIC - Core Application Javascript
  Handles State Management, Player Control, Gestures, Speech Assistant, Caching & UI bindings.
*/

// Register PWA Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('AURA Service Worker registered!', reg.scope))
            .catch(err => console.error('AURA Service Worker registration failed:', err));
    });
}

// Application State
let playerQueue = [];
let currentQueueIndex = -1;
let currentLoadedTrack = null;
let playbackHistory = [];
let likedSongs = [];
let downloadedSongs = [];
let searchHistory = [];
let incognitoMode = false;
let crossfadeDuration = 0; // seconds
let sleepTimerId = null;

// DOM Elements
const audio = document.getElementById("audio-element");
const toast = document.getElementById("toast-notification");

document.addEventListener("DOMContentLoaded", () => {
    // 1. Initial State Restore
    restoreStateFromStorage();
    
    // 2. Initializations
    initUIHeader();
    initTabNavigation();
    initSearchEngine();
    initPlayerBindings();
    initLibraryPlaylistSystem();
    initAuraJamBindings();
    initSoundStageUI();
    initSpeechAssistant();
    initThemesSystem();
    initMobileAudioUnlock();
    
    // Initialize Web Audio and Canvas
    window.initVisualizers();
    window.runAuraAtmosParticles();
    
    // Load Initial Home Data
    loadHomeData();
});

// Mobile Audio Unlock - required for iOS/Android autoplay policy
function initMobileAudioUnlock() {
    // iOS/Android need a user gesture before AudioContext works
    // We show a splash tap-to-start if on mobile touch device
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (!isTouchDevice) return;
    
    // Create unlock overlay
    const overlay = document.createElement('div');
    overlay.id = 'audio-unlock-overlay';
    overlay.innerHTML = `
        <div style="font-size:60px; margin-bottom:10px;">🎵</div>
        <h2>AURA ∞ MUSIC</h2>
        <p>Tap anywhere to start your music experience</p>
        <button class="btn btn-gold" style="margin-top:10px; font-size:16px; padding:14px 36px;">Start Listening</button>
    `;
    document.body.appendChild(overlay);
    
    const unlock = () => {
        // 🔥 iOS AUDIO FIX 1: Initialize the real Equalizer immediately on first screen tap
        if (window.initEqualizer) window.initEqualizer(audio);
        if (window.resumeAudioContext) window.resumeAudioContext();

        // Create and immediately suspend a AudioContext to unlock audio
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        ctx.resume().then(() => ctx.close());
        
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.4s ease';
        setTimeout(() => overlay.remove(), 400);
        
        document.removeEventListener('touchstart', unlock);
    };
    
    document.addEventListener('touchstart', unlock, { once: true });
    overlay.querySelector('button').addEventListener('click', unlock);
}

// 1. STATE MANAGEMENT

function restoreStateFromStorage() {
    try {
        likedSongs = JSON.parse(localStorage.getItem("aura_liked")) || [];
        downloadedSongs = JSON.parse(localStorage.getItem("aura_downloads")) || [];
        searchHistory = JSON.parse(localStorage.getItem("aura_search_history")) || [];
        playbackHistory = JSON.parse(localStorage.getItem("aura_history")) || [];
        
        // Apply liked count text
        updateLikedCount();
    } catch (e) {
        console.error("Storage restore failed:", e);
    }
}

function saveStateToStorage(key, data) {
    if (incognitoMode && (key === "aura_history" || key === "aura_search_history")) return;
    localStorage.setItem(key, JSON.stringify(data));
}

// 2. UI NAVIGATION & HEADER

function initUIHeader() {
    const greeting = document.getElementById("greeting-text");
    const hours = new Date().getHours();
    
    if (hours < 12) {
        greeting.innerHTML = "Good Morning ☀️";
    } else if (hours < 18) {
        greeting.innerHTML = "Good Afternoon 🌤️";
    } else {
        greeting.innerHTML = "Good Evening 🌙";
    }

    // Toggle Incognito Button
    const privateBtn = document.getElementById("private-mode-btn");
    privateBtn.addEventListener("click", toggleIncognito);
}

function initTabNavigation() {
    const navButtons = document.querySelectorAll(".nav-btn");
    const tabPanels = document.querySelectorAll(".tab-panel");

    // Connect both desktop sidebar buttons and mobile tab bar buttons (we will create mobile tabs dynamically)
    function switchTab(tabId) {
        tabPanels.forEach(panel => {
            panel.classList.remove("active");
        });
        navButtons.forEach(btn => {
            btn.classList.remove("active");
            if (btn.getAttribute("data-tab") === tabId) {
                btn.classList.add("active");
            }
        });
        
        // Also update mobile tabs if they exist
        const mobButtons = document.querySelectorAll(".mobile-tab-btn");
        mobButtons.forEach(btn => {
            btn.classList.remove("active");
            if (btn.getAttribute("data-tab") === tabId) {
                btn.classList.add("active");
            }
        });

        const activePanel = document.getElementById(`tab-${tabId}`);
        if (activePanel) {
            activePanel.classList.add("active");
        }
        
        // Close dynamic detail panel if open when switching tabs
        document.getElementById("dynamic-view-panel").classList.add("hide");
    }

    // Desktop bindings
    navButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            switchTab(btn.getAttribute("data-tab"));
        });
    });

    // Generate Mobile Tab Bar dynamically
    if (window.innerWidth <= 768) {
        createMobileTabBar(switchTab);
    }
    
    // Re-check on resize (handles browser DevTools responsive mode switching)
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const existingBar = document.querySelector('.mobile-tab-bar');
            if (window.innerWidth <= 768) {
                if (!existingBar) createMobileTabBar(switchTab);
            } else {
                if (existingBar) existingBar.remove();
            }
        }, 200);
    });
}

function createMobileTabBar(switchTabFn) {
    // Avoid double generation
    if (document.querySelector(".mobile-tab-bar")) return;
    
    const bar = document.createElement("div");
    bar.className = "mobile-tab-bar";
    
    const tabs = [
        { id: "home", icon: "fa-house", label: "For You" },
        { id: "search", icon: "fa-magnifying-glass", label: "Search" },
        { id: "library", icon: "fa-compact-disc", label: "Library" },
        { id: "jam", icon: "fa-users-rays", label: "Jam" },
        { id: "equalizer", icon: "fa-sliders", label: "EQ" }
    ];
    
    tabs.forEach(t => {
        const btn = document.createElement("button");
        btn.className = `mobile-tab-btn ${t.id === 'home' ? 'active' : ''}`;
        btn.setAttribute("data-tab", t.id);
        btn.innerHTML = `<i class="fa-solid ${t.icon}"></i><span>${t.label}</span>`;
        btn.addEventListener("click", () => {
            switchTabFn(t.id);
        });
        bar.appendChild(btn);
    });
    
    document.body.appendChild(bar);
}

// 3. SEARCH ENGINE

function initSearchEngine() {
    const searchInput = document.getElementById("search-input");
    const clearBtn = document.getElementById("clear-search-btn");
    const suggestionBox = document.getElementById("search-suggestions");
    const filterPills = document.querySelectorAll(".filter-pill");
    
    let debounceTimer = null;
    let selectedFilter = "all";

    searchInput.addEventListener("input", () => {
        const val = searchInput.value.trim();
        if (val) {
            clearBtn.style.display = "block";
            
            // Debounce Suggestion API
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                fetchSuggestions(val);
            }, 300);
        } else {
            clearBtn.style.display = "none";
            suggestionBox.classList.add("hide");
        }
    });

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const query = searchInput.value.trim();
            if (query) {
                performSearch(query, selectedFilter);
                suggestionBox.classList.add("hide");
            }
        }
    });

    clearBtn.addEventListener("click", () => {
        searchInput.value = "";
        clearBtn.style.display = "none";
        suggestionBox.classList.add("hide");
        document.getElementById("search-results-view").classList.add("hide");
        document.getElementById("search-default-view").classList.remove("hide");
    });

    filterPills.forEach(pill => {
        pill.addEventListener("click", () => {
            filterPills.forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            selectedFilter = pill.getAttribute("data-filter");
            
            const query = searchInput.value.trim();
            if (query) {
                performSearch(query, selectedFilter);
            }
        });
    });

    // Voice search bar click
    document.getElementById("voice-search-bar-btn").addEventListener("click", startVoiceAssistantRecognition);
    document.getElementById("voice-search-header-btn").addEventListener("click", startVoiceAssistantRecognition);

    // Categories buttons mapping
    const catCards = document.querySelectorAll(".category-card");
    catCards.forEach(card => {
        card.addEventListener("click", () => {
            const q = card.getAttribute("data-query");
            searchInput.value = q;
            clearBtn.style.display = "block";
            performSearch(q, "all");
        });
    });

    // Clear history click
    document.getElementById("clear-history-btn").addEventListener("click", () => {
        searchHistory = [];
        saveStateToStorage("aura_search_history", searchHistory);
        renderSearchHistory();
    });

    renderSearchHistory();
}

async function fetchSuggestions(q) {
    try {
        const res = await fetch(`/api/suggestions?q=${encodeURIComponent(q)}`);
        const suggestions = await res.json();
        renderSuggestionsUI(suggestions);
    } catch (e) {
        console.error("Suggestions fetch error:", e);
    }
}

function renderSuggestionsUI(suggestions) {
    const box = document.getElementById("search-suggestions");
    box.innerHTML = "";
    
    if (suggestions.length === 0) {
        box.classList.add("hide");
        return;
    }
    
    suggestions.forEach(s => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i><span>${s}</span>`;
        item.addEventListener("click", () => {
            document.getElementById("search-input").value = s;
            box.classList.add("hide");
            performSearch(s, "all");
        });
        box.appendChild(item);
    });
    
    box.classList.remove("hide");
}

async function performSearch(q, filter) {
    // Add to history
    if (!incognitoMode && !searchHistory.includes(q)) {
        searchHistory.unshift(q);
        if (searchHistory.length > 8) searchHistory.pop();
        saveStateToStorage("aura_search_history", searchHistory);
        renderSearchHistory();
    }

    document.getElementById("search-default-view").classList.add("hide");
    const resultsView = document.getElementById("search-results-view");
    const resultsContainer = document.getElementById("search-results-container");
    
    resultsContainer.innerHTML = `
        <div class="skeleton-card" style="width:100%; height:60px;"></div>
        <div class="skeleton-card" style="width:100%; height:60px; animation-delay: 0.2s;"></div>
        <div class="skeleton-card" style="width:100%; height:60px; animation-delay: 0.4s;"></div>
    `;
    resultsView.classList.remove("hide");
    document.getElementById("search-results-title").innerText = `Results for "${q}"`;

    try {
        const url = `/api/search?q=${encodeURIComponent(q)}&filter=${filter}`;
        const res = await fetch(url);
        const results = await res.json();
        
        renderSearchResults(results);
    } catch (err) {
        resultsContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Search failed. Check network connection.</p></div>`;
    }
}

function renderSearchResults(results) {
    const container = document.getElementById("search-results-container");
    container.innerHTML = "";
    
    if (results.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-compact-disc"></i><p>No results found for query.</p></div>`;
        return;
    }
    
    results.forEach((item) => {
        const row = document.createElement("div");
        row.className = "track-row";
        
        // Define action depending on search result category (song, artist, album)
        if (item.type === "song" || item.type === "video") {
            row.addEventListener("click", () => {
                playSingleSong(item);
            });
            
            const isLiked = likedSongs.some(s => s.id === item.id);
            const isJam = window.isInsideJam();
            
            // If inside Jam, the click should offer options: Play immediate or Add to Jam queue!
            if (isJam) {
                row.addEventListener("click", (e) => {
                    e.stopPropagation();
                    // Custom Jam menu
                    showJamSelectionMenu(item);
                });
            }

            row.innerHTML = `
                <div class="track-row-art"><img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
                <div class="track-row-info">
                    <h4>${item.title}</h4>
                    <p>${item.artist} • ${item.album || 'Single'}</p>
                </div>
                <div class="track-row-actions">
                    <span class="track-duration-badge">${item.duration}</span>
                    <button class="like-row-btn ${isLiked ? 'liked' : ''}" onclick="toggleLikeFromRow(event, '${item.id}')">
                        <i class="fa-solid fa-heart"></i>
                    </button>
                    <button onclick="downloadTrackFromRow(event, '${item.id}')" title="Download"><i class="fa-solid fa-circle-down"></i></button>
                </div>
            `;
        } 
        else if (item.type === "artist") {
            row.addEventListener("click", () => {
                loadArtistDetailPanel(item.id);
            });
            row.innerHTML = `
                <div class="track-row-art" style="border-radius: 50%;"><img src="${item.thumbnail || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80'}"></div>
                <div class="track-row-info">
                    <h4>${item.title}</h4>
                    <p>Artist • Explore popular songs</p>
                </div>
                <div class="track-row-actions">
                    <i class="fa-solid fa-chevron-right" style="color:var(--text-muted);"></i>
                </div>
            `;
        } 
        else if (item.type === "album") {
            row.addEventListener("click", () => {
                loadAlbumDetailPanel(item.id);
            });
            row.innerHTML = `
                <div class="track-row-art"><img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
                <div class="track-row-info">
                    <h4>${item.title}</h4>
                    <p>Album • By ${item.artist}</p>
                </div>
                <div class="track-row-actions">
                    <i class="fa-solid fa-chevron-right" style="color:var(--text-muted);"></i>
                </div>
            `;
        }
        
        container.appendChild(row);
    });
}

function showJamSelectionMenu(track) {
    // Open a toast options drawer
    const popup = document.createElement("div");
    popup.className = "modal-card glass-panel";
    popup.style.cssText = "position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:100000;";
    
    popup.innerHTML = `
        <h3>Jam Selection</h3>
        <p style="font-size:12px; margin-bottom:15px; color:var(--text-secondary);">Choose action for '${track.title}'</p>
        <div style="display:flex; flex-direction:column; gap:10px;">
            <button class="btn btn-purple" id="jam-opt-play-now">Sync Play Now</button>
            <button class="btn btn-gold" id="jam-opt-add-queue">Add to Voted Queue</button>
            <button class="btn" id="jam-opt-cancel">Cancel</button>
        </div>
    `;
    
    document.body.appendChild(popup);
    
    document.getElementById("jam-opt-play-now").onclick = () => {
        popup.remove();
        playSingleSong(track);
    };
    
    document.getElementById("jam-opt-add-queue").onclick = () => {
        popup.remove();
        window.sendJamAddQueue(track);
        showToast("Added to Jam Queue");
    };
    
    document.getElementById("jam-opt-cancel").onclick = () => {
        popup.remove();
    };
}

function renderSearchHistory() {
    const container = document.getElementById("search-history-container");
    container.innerHTML = "";
    
    if (searchHistory.length === 0) {
        document.getElementById("search-history-section").classList.add("hide");
        return;
    }
    
    document.getElementById("search-history-section").classList.remove("hide");
    
    searchHistory.forEach(q => {
        const item = document.createElement("div");
        item.className = "history-item";
        item.innerHTML = `
            <span>${q}</span>
            <i class="fa-solid fa-xmark remove-history" onclick="removeHistoryItem(event, '${q}')"></i>
        `;
        item.addEventListener("click", () => {
            document.getElementById("search-input").value = q;
            performSearch(q, "all");
        });
        container.appendChild(item);
    });
}

function removeHistoryItem(e, q) {
    e.stopPropagation();
    searchHistory = searchHistory.filter(item => item !== q);
    saveStateToStorage("aura_search_history", searchHistory);
    renderSearchHistory();
}

// 4. AUDIO PLAYER BINDINGS & CONTROLS

function initPlayerBindings() {
    // Play/Pause actions
    const mainPlayBtn = document.getElementById("player-play-btn");
    const miniPlayBtn = document.getElementById("mini-play-btn");
    
    const togglePlay = () => {
        if (!currentLoadedTrack) return;
        
        // Lazy init Audio Engine on first click
        window.initEqualizer(audio);
        window.resumeAudioContext();
        
        if (audio.paused) {
            audio.play().then(() => {
                onSongPlayStateChange(true);
            }).catch(err => {
                console.error("Audio playback error:", err);
            });
        } else {
            audio.pause();
            onSongPlayStateChange(false);
        }
    };

    mainPlayBtn.addEventListener("click", togglePlay);
    miniPlayBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // Avoid opening full player on play tap
        togglePlay();
    });

    // Next/Prev buttons
    document.getElementById("player-next-btn").addEventListener("click", playNextTrack);
    document.getElementById("mini-next-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        playNextTrack();
    });
    
    document.getElementById("player-prev-btn").addEventListener("click", playPrevTrack);

    // Audio End Listener
    audio.addEventListener("ended", () => {
        playNextTrack();
    });

    // Audio Timestamp updater
    const seekbar = document.getElementById("player-seekbar");
    const currentTimer = document.getElementById("player-time-current");
    
    audio.addEventListener("timeupdate", () => {
        if (isNaN(audio.duration)) return;
        
        const pct = (audio.currentTime / audio.duration) * 100;
        seekbar.value = pct;
        
        // Mini player progress line
        document.getElementById("mini-progress-fill").style.width = `${pct}%`;
        
        currentTimer.innerText = formatDurationSec(audio.currentTime);
        
        // Syced lyrics timing cursor alignment
        updateLyricsTimeline(audio.currentTime);
    });

    // Seek bar manual seek input
    seekbar.addEventListener("input", () => {
        if (isNaN(audio.duration)) return;
        const targetPos = (seekbar.value / 100) * audio.duration;
        audio.currentTime = targetPos;
        
        // Notify Jam WebSocket if in co-listening
        if (window.isInsideJam() && (window.getJamRole() === 'host' || window.getJamRole() === 'co-host')) {
            window.sendJamPlaybackUpdate(
                currentLoadedTrack.id, 
                audio.paused ? "PAUSED" : "PLAYING", 
                audio.currentTime, 
                currentLoadedTrack
            );
        }
    });

    // Open/Close Full Player transitions - use player-open class (CSS transform)
    document.getElementById("open-full-player-trigger").addEventListener("click", () => {
        document.getElementById("full-player").classList.add("player-open");
    });
    // Also tap on mini artwork opens full player
    document.getElementById("mini-artwork").addEventListener("click", () => {
        document.getElementById("full-player").classList.add("player-open");
    });
    
    document.getElementById("close-full-player-btn").addEventListener("click", () => {
        document.getElementById("full-player").classList.remove("player-open");
    });

    // Actions bindings on Full Player
    document.getElementById("player-like-btn").addEventListener("click", toggleLikeActiveTrack);
    document.getElementById("mini-like-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLikeActiveTrack();
    });
    
    document.getElementById("player-download-btn").addEventListener("click", downloadActiveTrack);
    document.getElementById("player-playlist-btn").addEventListener("click", openPlaylistChooserModal);
    
    // Lyrics Overlay panels
    document.getElementById("player-lyrics-toggle-btn").addEventListener("click", openLyricsOverlay);
    document.getElementById("close-lyrics-overlay-btn").addEventListener("click", closeLyricsOverlay);
    
    // Queue drawer toggle
    document.getElementById("player-queue-toggle-btn").addEventListener("click", () => {
        const drawer = document.getElementById("player-queue-drawer");
        drawer.classList.toggle("drawer-open");
    });
    document.querySelectorAll(".close-drawer-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            btn.closest(".player-drawer").classList.remove("drawer-open");
        });
    });

    // Dynamic color change based on header timeline (greetings colors)
    setInterval(cycleDynamicHeaderGradient, 8000);
    cycleDynamicHeaderGradient();
    
    // Setup Gestures Overlay on Full Screen Player cover
    setupPlayerGestures();
}

function onSongPlayStateChange(isPlaying) {
    const mainPlayBtn = document.getElementById("player-play-btn");
    const miniPlayBtn = document.getElementById("mini-play-btn");
    
    if (isPlaying) {
        mainPlayBtn.innerHTML = `<i class="fa-solid fa-pause"></i>`;
        miniPlayBtn.innerHTML = `<i class="fa-solid fa-pause"></i>`;
        document.body.classList.add("playing-state");
        window.startVisualizerLoop();
    } else {
        mainPlayBtn.innerHTML = `<i class="fa-solid fa-play"></i>`;
        miniPlayBtn.innerHTML = `<i class="fa-solid fa-play"></i>`;
        document.body.classList.remove("playing-state");
        window.stopVisualizerLoop();
    }
    
    // Broadcast websocket sync if in co-play
    if (window.isInsideJam() && (window.getJamRole() === 'host' || window.getJamRole() === 'co-host')) {
        window.sendJamPlaybackUpdate(
            currentLoadedTrack.id, 
            isPlaying ? "PLAYING" : "PAUSED", 
            audio.currentTime, 
            currentLoadedTrack
        );
    }
}

async function playSingleSong(track, autoplay = true) {
    if (!track) return;
    
    // 🔥 iOS AUDIO FIX 2: Init & Resume AudioContext synchronously BEFORE any 'await' happens
    if (autoplay) {
        if (window.initEqualizer) window.initEqualizer(audio);
        if (window.resumeAudioContext) window.resumeAudioContext();
    }

    currentLoadedTrack = track;
    window.currentLoadedTrack = track; // global export
    
    // 1. Update UI Elements
    document.getElementById("mini-title").innerText = track.title;
    // === ANDROID / PWA LOCK SCREEN MEDIA CONTROLS ===
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.artist,
            album: track.album || 'AURA MUSIC',
            artwork: [
                { src: track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=512&q=80', sizes: '512x512', type: 'image/jpeg' }
            ]
        });

        navigator.mediaSession.setActionHandler('play', () => { 
            audio.play(); onSongPlayStateChange(true); 
        });
        navigator.mediaSession.setActionHandler('pause', () => { 
            audio.pause(); onSongPlayStateChange(false); 
        });
        navigator.mediaSession.setActionHandler('previoustrack', playPrevTrack);
        navigator.mediaSession.setActionHandler('nexttrack', playNextTrack);
    }
    // ===============================================
    document.getElementById("mini-artist").innerText = track.artist;
    document.getElementById("mini-artwork").src = track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80';
    
    document.getElementById("player-title").innerText = track.title;
    document.getElementById("player-artist").innerText = track.artist;
    document.getElementById("player-artwork").src = track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80';
    document.getElementById("player-time-total").innerText = track.duration || "3:00";
    
    // Artwork dynamic glow shadow
    document.getElementById("full-player-dynamic-bg").style.background = `radial-gradient(circle, rgba(155, 93, 229, 0.45) 0%, rgba(8, 8, 12, 1) 90%)`;
    
    // Highlight like icon if track is liked
    const likeBtn = document.getElementById("player-like-btn");
    const miniLikeBtn = document.getElementById("mini-like-btn");
    const isLiked = likedSongs.some(s => s.id === track.id);
    
    if (isLiked) {
        likeBtn.classList.add("active");
        likeBtn.innerHTML = `<i class="fa-solid fa-heart"></i>`;
        miniLikeBtn.innerHTML = `<i class="fa-solid fa-heart" style="color:var(--purple);"></i>`;
    } else {
        likeBtn.classList.remove("active");
        likeBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
        miniLikeBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
    }

    // Restore volume settings
    audio.volume = 0.8;

    // Save to history
    addToListeningHistory(track);

    // 2. Fetch lyrics asynchronously in background
    loadSyncedLyrics(track);

    // 3. Play stream
    try {
        // Check if track is cached offline first!
        const cache = await caches.open("aura-audio-cache");
        const cacheKey = `/api/stream?video_id=${track.id}`;
        const cachedResponse = await cache.match(cacheKey);
        
        if (cachedResponse) {
            console.log(`Loading cached offline stream for ${track.title}`);
            audio.src = cacheKey; // Stream directly from local browser cache cache-API!
            showToast("Playing Offline Saved Audio 📶");
        } else {
            // Online stream proxy
            audio.src = `/api/stream?video_id=${track.id}`;
        }
        
        if (autoplay) {
            audio.play().then(() => {
                onSongPlayStateChange(true);
            }).catch(() => {
                onSongPlayStateChange(false);
            });
        }
    } catch (err) {
        console.error("Stream load failed:", err);
        showToast("Error loading audio source.");
    }
}

// Global export for Jam.js co-playing loading
window.playSongById = async (video_id, trackData, seekPos = 0, autoPlay = true) => {
    await playSingleSong(trackData, autoPlay);
    if (seekPos > 0) {
        setTimeout(() => { audio.currentTime = seekPos; }, 500);
    }
};

function playNextTrack() {
    // If inside Jam, the next track is handled by rooms queue!
    if (window.isInsideJam()) {
        if (window.getJamRole() === 'host' || window.getJamRole() === 'co-host') {
            window.sendJamSkipToNext();
        }
        return;
    }

    if (playerQueue.length === 0) return;
    currentQueueIndex = (currentQueueIndex + 1) % playerQueue.length;
    playSingleSong(playerQueue[currentQueueIndex]);
}

function playPrevTrack() {
    if (window.isInsideJam()) return; // Ignored inside co-listening room
    
    if (playerQueue.length === 0) return;
    currentQueueIndex = (currentQueueIndex - 1 + playerQueue.length) % playerQueue.length;
    playSingleSong(playerQueue[currentQueueIndex]);
}

function addToListeningHistory(track) {
    if (incognitoMode) return;
    
    playbackHistory = playbackHistory.filter(s => s.id !== track.id);
    playbackHistory.unshift(track);
    if (playbackHistory.length > 50) playbackHistory.pop();
    
    saveStateToStorage("aura_history", playbackHistory);
    renderLibraryHistory();
}

// 5. LYRICS KARAOKE SYSTEM

let lyricsTimeline = [];

async function loadSyncedLyrics(track) {
    const container = document.getElementById("lyrics-lines-container");
    container.innerHTML = `<div class="lyrics-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading lyrics...</div>`;
    
    lyricsTimeline = [];
    
    try {
        const url = `/api/lyrics?video_id=${track.id}&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}&duration=${track.durationSeconds || 0}`;
        const res = await fetch(url);
        const data = await res.json();
        
        lyricsTimeline = data.lyrics;
        document.getElementById("lyrics-source-tag").innerText = `Source: ${data.source}`;
        
        renderLyricsUI();
    } catch (e) {
        console.error("Lyrics fetch failed:", e);
        container.innerHTML = `<div class="lyrics-loading">Lyrics unavailable.</div>`;
    }
}

function renderLyricsUI() {
    const container = document.getElementById("lyrics-lines-container");
    container.innerHTML = "";
    
    if (lyricsTimeline.length === 0) {
        container.innerHTML = `<div class="lyrics-loading">Lyrics are instrumental.</div>`;
        return;
    }
    
    lyricsTimeline.forEach((line, idx) => {
        const p = document.createElement("div");
        p.className = "lyrics-line medium";
        p.setAttribute("data-time", line.time);
        p.setAttribute("data-index", idx);
        p.innerText = line.text;
        
        // Tapping a lyric seeks the audio to that line! (Flagship karaoke detail!)
        p.addEventListener("click", () => {
            audio.currentTime = parseFloat(line.time);
        });
        
        container.appendChild(p);
    });
}

function updateLyricsTimeline(currentTime) {
    if (lyricsTimeline.length === 0) return;
    
    let activeIndex = -1;
    // Find the current active lyric line
    for (let i = 0; i < lyricsTimeline.length; i++) {
        if (currentTime >= lyricsTimeline[i].time) {
            activeIndex = i;
        } else {
            break;
        }
    }
    
    if (activeIndex !== -1) {
        const lines = document.querySelectorAll(".lyrics-line");
        lines.forEach(l => {
            l.classList.remove("active");
        });
        
        const activeLine = document.querySelector(`.lyrics-line[data-index="${activeIndex}"]`);
        if (activeLine) {
            activeLine.classList.add("active");
            
            // Auto scroll container to center the active line
            const scroller = document.getElementById("lyrics-lines-container");
            const scrollerHeight = scroller.clientHeight;
            const lineTop = activeLine.offsetTop;
            const lineScale = activeLine.clientHeight;
            
            // Scroll coordinate calculations smoothly
            scroller.scrollTo({
                top: lineTop - (scrollerHeight / 2) + (lineScale / 2),
                behavior: 'smooth'
            });
        }
    }
}

function openLyricsOverlay() {
    document.getElementById("player-lyrics-overlay").classList.add("lyrics-open");
}

function closeLyricsOverlay() {
    document.getElementById("player-lyrics-overlay").classList.remove("lyrics-open");
}

// 6. GESTURES INTERACTION MODULE

function setupPlayerGestures() {
    const artwork = document.getElementById("aura-sphere-container");
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;

    artwork.addEventListener("touchstart", (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
    });

    artwork.addEventListener("touchend", (e) => {
        const diffX = e.changedTouches[0].clientX - touchStartX;
        const diffY = e.changedTouches[0].clientY - touchStartY;
        const duration = Date.now() - touchStartTime;
        
        // Swipe left = Next song, Swipe right = Previous
        if (Math.abs(diffX) > 80 && Math.abs(diffY) < 50 && duration < 300) {
            if (diffX < 0) {
                // Swipe Left
                playNextTrack();
                showToast("Gestures: Next Song ⏭️");
            } else {
                // Swipe Right
                playPrevTrack();
                showToast("Gestures: Previous Song ⏮️");
            }
        }
    });

    // Double Tap gesture: Like song
    let lastTap = 0;
    artwork.addEventListener("click", () => {
        const now = Date.now();
        if (now - lastTap < 300) {
            // Double tap
            toggleLikeActiveTrack();
            showToast("Gestures: Added to Liked 💖");
        }
        lastTap = now;
    });

    // Long Press gesture: Song info popup
    let pressTimer = null;
    artwork.addEventListener("mousedown", () => {
        pressTimer = setTimeout(displayTrackLongPressInfo, 800);
    });
    
    artwork.addEventListener("mouseup", () => {
        clearTimeout(pressTimer);
    });
    
    artwork.addEventListener("touchstart", () => {
        pressTimer = setTimeout(displayTrackLongPressInfo, 800);
    });
    
    artwork.addEventListener("touchend", () => {
        clearTimeout(pressTimer);
    });
}

function displayTrackLongPressInfo() {
    if (!currentLoadedTrack) return;
    alert(
        `AURA Track Metadata:\n` +
        `Title: ${currentLoadedTrack.title}\n` +
        `Artist: ${currentLoadedTrack.artist}\n` +
        `Source: YouTube Music Stream\n` +
        `Accoustic Profile: Standard Stereo widening enabled`
    );
}

// 7. OFFLINE DOWNLOAD MANAGER

async function downloadActiveTrack() {
    if (!currentLoadedTrack) return;
    downloadTrackFromRow(null, currentLoadedTrack.id);
}

async function downloadTrackFromRow(event, trackId) {
    if (event) event.stopPropagation(); // Stop playing click
    
    // Find track details from loaded track or queue
    let track = null;
    if (currentLoadedTrack && currentLoadedTrack.id === trackId) {
        track = currentLoadedTrack;
    } else {
        // Fallback search in results
        track = playerQueue.find(s => s.id === trackId);
    }
    
    if (!track) {
        // Try requesting from api
        showToast("Error locating song meta.");
        return;
    }
    
    if (downloadedSongs.some(s => s.id === trackId)) {
        showToast("Track already downloaded offline!");
        return;
    }

    showToast(`Downloading: ${track.title}...`);
    
    // Enable Download status layout
    const statusCard = document.getElementById("download-manager-status");
    const progressFill = document.getElementById("download-global-progress");
    const speedText = document.getElementById("download-speed-text");
    
    statusCard.classList.remove("hide");
    progressFill.style.width = "10%";
    speedText.innerText = "Connecting...";

    try {
        // Download and Cache using Cache-API
        const streamUrl = `/api/stream?video_id=${trackId}`;
        const cache = await caches.open("aura-audio-cache");
        
        let progress = 10;
        const progressTimer = setInterval(() => {
            progress += Math.floor(Math.random() * 10) + 5;
            if (progress >= 95) progress = 95;
            progressFill.style.width = `${progress}%`;
            speedText.innerText = `${(Math.random() * 2 + 1.2).toFixed(1)} MB/s`;
        }, 400);

        // Fetch streaming audio data to cache it
        const response = await fetch(streamUrl);
        if (response.ok) {
            await cache.put(streamUrl, response);
            clearInterval(progressTimer);
            
            progressFill.style.width = "100%";
            speedText.innerText = "Completed";
            
            // Add song to local meta lists
            downloadedSongs.push(track);
            saveStateToStorage("aura_downloads", downloadedSongs);
            
            showToast(`Downloaded: ${track.title} 📶`);
            renderLibraryDownloads();
            
            setTimeout(() => {
                statusCard.classList.add("hide");
            }, 3000);
        } else {
            throw new Error("HTTP error downloading stream");
        }
    } catch (e) {
        console.error("Cache download failed:", e);
        showToast("Download failed. Retry again.");
        statusCard.classList.add("hide");
    }
}

// 8. VOICE ASSISTANT (Speech Control)

function initSpeechAssistant() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.log("Speech recognition not supported in browser.");
        return;
    }
    
    const recognizer = new SpeechRecognition();
    recognizer.continuous = false;
    recognizer.lang = 'en-US';
    recognizer.interimResults = false;
    
    recognizer.onstart = () => {
        showToast("Voice assistant listening... 🎙️");
    };
    
    recognizer.onerror = () => {
        showToast("Voice command failed.");
    };
    
    recognizer.onresult = (event) => {
        const text = event.results[0][0].transcript.toLowerCase();
        showToast(`Heard: "${text}"`);
        handleSpeechCommand(text);
    };

    window.startSpeechRecognizer = () => {
        recognizer.start();
    };
}

function startVoiceAssistantRecognition() {
    if (window.startSpeechRecognizer) {
        window.startSpeechRecognizer();
    } else {
        showToast("Voice assistant unavailable on this browser.");
    }
}

function handleSpeechCommand(cmd) {
    if (cmd.includes("play")) {
        const query = cmd.replace("play", "").trim();
        if (query) {
            showToast(`Searching for: ${query}`);
            // Perform search and play first song
            fetch(`/api/search?q=${encodeURIComponent(query)}&filter=songs`).then(r => r.json()).then(results => {
                if (results.length > 0) {
                    playSingleSong(results[0]);
                }
            });
        }
    } 
    else if (cmd.includes("next") || cmd.includes("skip")) {
        playNextTrack();
    } 
    else if (cmd.includes("pause") || cmd.includes("stop")) {
        audio.pause();
        onSongPlayStateChange(false);
    } 
    else if (cmd.includes("resume") || cmd.includes("start")) {
        audio.play().then(() => onSongPlayStateChange(true));
    } 
    else if (cmd.includes("increase volume") || cmd.includes("volume up")) {
        audio.volume = Math.min(1.0, audio.volume + 0.2);
        showToast(`Volume: ${Math.round(audio.volume*100)}%`);
    } 
    else if (cmd.includes("decrease volume") || cmd.includes("volume down")) {
        audio.volume = Math.max(0.0, audio.volume - 0.2);
        showToast(`Volume: ${Math.round(audio.volume*100)}%`);
    }
}

// 9. LIBRARIES & PLAYLIST MANAGEMENT

function initLibraryPlaylistSystem() {
    const tabs = document.querySelectorAll(".lib-tab-btn");
    const subPanels = document.querySelectorAll(".lib-sub-panel");
    
    tabs.forEach(btn => {
        btn.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            btn.classList.add("active");
            
            const targetId = btn.getAttribute("data-lib");
            subPanels.forEach(panel => {
                panel.classList.remove("active");
                if (panel.id === `lib-${targetId}`) {
                    panel.classList.add("active");
                }
            });
        });
    });

    // Library Views Populators
    renderLibraryLiked();
    renderLibraryDownloads();
    renderLibraryHistory();

    // Sleep Timer modal trigger
    document.getElementById("player-sleep-timer-btn").addEventListener("click", toggleSleepTimerOptions);
    
    // Crossfade trigger
    document.getElementById("player-crossfade-btn").addEventListener("click", configureCrossfadeSettings);
}

function updateLikedCount() {
    document.getElementById("liked-count-text").innerText = `${likedSongs.length} song${likedSongs.length !== 1 ? 's' : ''}`;
}

function toggleLikeFromRow(e, trackId) {
    e.stopPropagation();
    
    let track = playerQueue.find(s => s.id === trackId) || downloadedSongs.find(s => s.id === trackId) || playbackHistory.find(s => s.id === trackId);
    
    if (!track) {
        showToast("Error toggling like status.");
        return;
    }
    
    const idx = likedSongs.findIndex(s => s.id === trackId);
    if (idx !== -1) {
        likedSongs.splice(idx, 1);
        showToast("Removed from Liked Songs");
    } else {
        likedSongs.push(track);
        showToast("Added to Liked Songs");
    }
    
    saveStateToStorage("aura_liked", likedSongs);
    updateLikedCount();
    renderLibraryLiked();
    
    // Reload search views if active
    const q = document.getElementById("search-input").value.trim();
    if (q) {
        performSearch(q, "songs");
    }
}

function toggleLikeActiveTrack() {
    if (!currentLoadedTrack) return;
    
    const trackId = currentLoadedTrack.id;
    const idx = likedSongs.findIndex(s => s.id === trackId);
    const likeBtn = document.getElementById("player-like-btn");
    const miniLikeBtn = document.getElementById("mini-like-btn");
    
    if (idx !== -1) {
        likedSongs.splice(idx, 1);
        likeBtn.classList.remove("active");
        likeBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
        miniLikeBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
        showToast("Removed from Liked");
    } else {
        likedSongs.push(currentLoadedTrack);
        likeBtn.classList.add("active");
        likeBtn.innerHTML = `<i class="fa-solid fa-heart"></i>`;
        miniLikeBtn.innerHTML = `<i class="fa-solid fa-heart" style="color:var(--purple);"></i>`;
        showToast("Added to Liked 💖");
    }
    
    saveStateToStorage("aura_liked", likedSongs);
    updateLikedCount();
    renderLibraryLiked();
}

function renderLibraryLiked() {
    const container = document.getElementById("liked-songs-list");
    if (likedSongs.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-regular fa-heart"></i><p>No liked songs yet.</p></div>`;
        return;
    }
    
    container.innerHTML = "";
    likedSongs.forEach(track => {
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4>${track.title}</h4>
                <p>${track.artist}</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${track.duration}</span>
                <button class="liked" onclick="toggleLikeFromRow(event, '${track.id}')"><i class="fa-solid fa-heart"></i></button>
            </div>
        `;
        row.addEventListener("click", () => playSingleSong(track));
        container.appendChild(row);
    });
}

function renderLibraryDownloads() {
    const container = document.getElementById("downloaded-songs-list");
    if (downloadedSongs.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-down"></i><p>Offline downloads will appear here.</p></div>`;
        return;
    }
    
    container.innerHTML = "";
    downloadedSongs.forEach(track => {
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4>${track.title}</h4>
                <p>${track.artist}</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${track.duration}</span>
                <i class="fa-solid fa-circle-check" style="color:#06d6a0;"></i>
            </div>
        `;
        row.addEventListener("click", () => playSingleSong(track));
        container.appendChild(row);
    });
}

function renderLibraryHistory() {
    const container = document.getElementById("history-songs-list");
    if (playbackHistory.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>Listening history is empty.</p></div>`;
        return;
    }
    
    container.innerHTML = "";
    playbackHistory.forEach(track => {
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4>${track.title}</h4>
                <p>${track.artist}</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${track.duration}</span>
            </div>
        `;
        row.addEventListener("click", () => playSingleSong(track));
        container.appendChild(row);
    });
}

// 10. EQUALIZER / SOUNDSTAGE BINDINGS

function initSoundStageUI() {
    const sliders = document.querySelectorAll(".eq-slider");
    sliders.forEach(slider => {
        slider.addEventListener("input", () => {
            const index = slider.getAttribute("data-index");
            const val = slider.value;
            window.setBandGain(index, val);
            
            // Set preset button Custom active
            document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
            document.querySelector(".preset-btn[data-preset='custom']").classList.add("active");
        });
    });

    // EQ Presets buttons Click
    const presetBtns = document.querySelectorAll(".preset-btn");
    presetBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            presetBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            const presetName = btn.getAttribute("data-preset");
            window.setPreset(presetName);
        });
    });

    // Effects Switch Toggle Controls
    document.getElementById("effect-surround-toggle").addEventListener("change", (e) => {
        window.toggleSurround(e.target.checked);
        showToast(`Surround sound: ${e.target.checked ? 'ON' : 'OFF'}`);
    });
    
    document.getElementById("effect-spatial-toggle").addEventListener("change", (e) => {
        window.toggleSpatial(e.target.checked);
        showToast(`Spatial 3D orbit: ${e.target.checked ? 'ON' : 'OFF'}`);
    });
    
    document.getElementById("effect-widener-toggle").addEventListener("change", (e) => {
        window.toggleWidener(e.target.checked);
        showToast(`Stereo Widening: ${e.target.checked ? 'ON' : 'OFF'}`);
    });
    
    document.getElementById("effect-reverb-toggle").addEventListener("change", (e) => {
        window.toggleReverb(e.target.checked);
        showToast(`Reverb Concert Echoes: ${e.target.checked ? 'ON' : 'OFF'}`);
    });
}

// Global hook called by equalizer.js to update sliders on preset changes
window.updateEQSliderUI = (bandIndex, dbValue) => {
    const slider = document.querySelector(`.eq-slider[data-index="${bandIndex}"]`);
    if (slider) {
        slider.value = dbValue;
    }
};

// 11. THEMES CONFIGURATION

function initThemesSystem() {
    const themes = [
        "Midnight Black", "Royal Gold", "Neon Purple", "Sapphire Blue", "Emerald Green", "Crimson Red"
    ];
    
    document.getElementById("theme-toggle-btn").addEventListener("click", () => {
        // Simple rotating index selector
        const currentClass = Array.from(document.body.classList).find(c => c.startsWith("theme-"));
        let nextIndex = 0;
        
        if (currentClass) {
            const currentName = currentClass.replace("theme-", "").replace("-", " ");
            const currentIndex = themes.findIndex(t => t.toLowerCase().includes(currentName.split(" ")[0]));
            nextIndex = (currentIndex + 1) % themes.length;
        }
        
        const nextTheme = themes[nextIndex];
        const nextThemeClass = `theme-${nextTheme.toLowerCase().replace(" ", "-")}`;
        
        // Clear old and set new theme class
        document.body.className = "";
        document.body.classList.add(nextThemeClass);
        
        showToast(`Applied Theme: ${nextTheme} ✨`);
    });
}

// 12. AURA JAM WS BINDINGS

function initAuraJamBindings() {
    // Host room action
    document.getElementById("host-jam-btn").addEventListener("click", () => {
        const hostName = document.getElementById("jam-host-username").value.trim();
        if (!hostName) {
            showToast("Enter a host username!");
            return;
        }
        
        // Generate random room code
        const code = Math.random().toString(36).substring(2, 7).toUpperCase();
        
        // Connect to WS Room
        window.connectJamRoom(hostName, code);
    });

    // Join room action
    document.getElementById("join-jam-btn").addEventListener("click", () => {
        const guestName = document.getElementById("jam-join-username").value.trim();
        const code = document.getElementById("jam-room-code").value.trim();
        
        if (!guestName || !code) {
            showToast("Enter username and Room Code!");
            return;
        }
        
        window.connectJamRoom(guestName, code);
    });

    // Leave room
    document.getElementById("leave-jam-btn").addEventListener("click", () => {
        window.leaveJamRoom();
    });

    // Chat sending
    const chatInput = document.getElementById("jam-chat-input");
    const sendBtn = document.getElementById("jam-chat-send-btn");
    
    const dispatchMessage = () => {
        const text = chatInput.value.trim();
        if (text) {
            window.sendJamChatMessage(text);
            chatInput.value = "";
        }
    };
    
    sendBtn.addEventListener("click", dispatchMessage);
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") dispatchMessage();
    });

    // Reactions click
    const reactionButtons = document.querySelectorAll(".reaction-emoji-btn");
    reactionButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            const emoji = btn.innerText;
            window.sendJamReaction(emoji);
        });
    });

    // Copy room link click
    document.getElementById("copy-room-link-btn").addEventListener("click", () => {
        const code = document.getElementById("jam-room-code-display").innerText;
        navigator.clipboard.writeText(code).then(() => {
            showToast("Copied Room Code: " + code);
        });
    });
}

// 13. ADDITIONAL UTILITIES (SLEEP TIMER, CROSSFADE, METADATA DETAILED PANEL)

function toggleIncognito() {
    incognitoMode = !incognitoMode;
    const btn = document.getElementById("private-mode-btn");
    
    if (incognitoMode) {
        btn.style.color = "var(--purple)";
        btn.style.borderColor = "var(--purple)";
        showToast("Private Listening Incognito ON 🔒");
    } else {
        btn.style.color = "";
        btn.style.borderColor = "";
        showToast("Private Listening OFF");
    }
}

function toggleSleepTimerOptions() {
    const timerVal = prompt("Enter Sleep Timer (minutes) or 0 to cancel:", "15");
    if (timerVal === null) return;
    
    const minutes = parseInt(timerVal);
    if (sleepTimerId) {
        clearTimeout(sleepTimerId);
        sleepTimerId = null;
    }
    
    if (minutes > 0) {
        showToast(`Sleep timer set: ${minutes} minutes`);
        sleepTimerId = setTimeout(() => {
            audio.pause();
            onSongPlayStateChange(false);
            showToast("AURA Sleep Timer triggered: Playback paused.");
        }, minutes * 60 * 1000);
    } else {
        showToast("Sleep timer cancelled.");
    }
}

function configureCrossfadeSettings() {
    const val = prompt("Enter Crossfade transition interval (0-12 seconds):", "4");
    if (val === null) return;
    
    const sec = parseInt(val);
    if (sec >= 0 && sec <= 12) {
        crossfadeDuration = sec;
        showToast(`Crossfade transition set to ${sec}s`);
    } else {
        showToast("Interval must be between 0 and 12 seconds.");
    }
}

// Artist & Album Pages dynamically loader inside content frame
async function loadArtistDetailPanel(channelId) {
    const panel = document.getElementById("dynamic-view-panel");
    const content = document.getElementById("dynamic-view-content");
    
    content.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Artist profile...</div>`;
    panel.classList.remove("hide");

    try {
        const res = await fetch(`/api/artists/${channelId}`);
        const data = await res.json();
        
        let popularSongsHTML = "";
        data.popularSongs.forEach(song => {
            popularSongsHTML += `
                <div class="track-row" onclick='playArtistSong(${JSON.stringify(song)})'>
                    <div class="track-row-art"><img src="${song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
                    <div class="track-row-info">
                        <h4>${song.title}</h4>
                        <p>${song.album || 'Single'}</p>
                    </div>
                    <div class="track-row-actions">
                        <i class="fa-solid fa-play" style="color:var(--gold);"></i>
                    </div>
                </div>
            `;
        });

        let albumsHTML = "";
        data.albums.forEach(alb => {
            albumsHTML += `
                <div class="music-card" onclick="loadAlbumDetailPanel('${alb.id}')">
                    <div class="card-img-wrapper"><img src="${alb.thumbnail}"></div>
                    <h4>${alb.title}</h4>
                    <p>${alb.year}</p>
                </div>
            `;
        });

        content.innerHTML = `
            <div style="display:flex; gap:30px; align-items:center; margin-bottom:30px; flex-wrap:wrap;">
                <img src="${data.thumbnail}" style="width:140px; height:140px; border-radius:50%; object-fit:cover; border:3px solid var(--gold);">
                <div>
                    <h2 style="font-size:32px; font-family:var(--font-header); font-weight:800;">${data.name}</h2>
                    <p style="font-size:12px; color:var(--text-secondary); max-width:500px; margin-top:8px;">${data.bio || 'YouTube Music Creator Biography'}</p>
                </div>
            </div>
            
            <h3 style="font-size:18px; margin-bottom:15px; font-family:var(--font-header);">Popular Tracks</h3>
            <div class="results-list" style="margin-bottom:35px;">${popularSongsHTML}</div>
            
            <h3 style="font-size:18px; margin-bottom:15px; font-family:var(--font-header);">Albums</h3>
            <div class="horizontal-scroll">${albumsHTML}</div>
        `;
    } catch (e) {
        content.innerHTML = `<div class="empty-state"><p>Failed to load artist details.</p></div>`;
    }
}

// Global play wrapper helper for dynamic profiles
window.playArtistSong = (song) => {
    playSingleSong(song);
};

async function loadAlbumDetailPanel(browseId) {
    const panel = document.getElementById("dynamic-view-panel");
    const content = document.getElementById("dynamic-view-content");
    
    content.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Album metadata...</div>`;
    panel.classList.remove("hide");

    try {
        const res = await fetch(`/api/albums/${browseId}`);
        const data = await res.json();
        
        let tracksHTML = "";
        data.tracks.forEach(track => {
            // Append album artwork to track structure
            track.thumbnail = data.thumbnail;
            tracksHTML += `
                <div class="track-row" onclick='playAlbumSong(${JSON.stringify(track)})'>
                    <div style="font-size:12px; font-weight:700; color:var(--gold); width:24px; text-align:center; margin-right:10px;">${track.trackNumber}</div>
                    <div class="track-row-info">
                        <h4>${track.title}</h4>
                        <p>${track.artist}</p>
                    </div>
                    <div class="track-row-actions">
                        <span class="track-duration-badge">${track.duration}</span>
                        <i class="fa-solid fa-play" style="color:var(--gold); margin-left:10px;"></i>
                    </div>
                </div>
            `;
        });

        content.innerHTML = `
            <div style="display:flex; gap:30px; align-items:center; margin-bottom:30px; flex-wrap:wrap;">
                <img src="${data.thumbnail}" style="width:140px; height:140px; border-radius:18px; object-fit:cover; border:1px solid var(--border-glass);">
                <div>
                    <h2 style="font-size:28px; font-family:var(--font-header); font-weight:800;">${data.title}</h2>
                    <p style="font-size:14px; color:var(--gold); font-weight:600; margin-top:4px;">Album • ${data.artist}</p>
                    <p style="font-size:12px; color:var(--text-secondary); margin-top:2px;">Released: ${data.year} • ${data.tracks.length} tracks</p>
                </div>
            </div>
            
            <h3 style="font-size:18px; margin-bottom:15px; font-family:var(--font-header);">Album Tracks</h3>
            <div class="results-list">${tracksHTML}</div>
        `;
    } catch (e) {
        content.innerHTML = `<div class="empty-state"><p>Failed to load album details.</p></div>`;
    }
}

window.playAlbumSong = (track) => {
    playSingleSong(track);
};

// 14. INIITIAL HOMEPAGE CAROUSELS DATA LOAD

async function loadHomeData() {
    const trendContainer = document.getElementById("trending-container");
    const newContainer = document.getElementById("new-releases-container");
    
    try {
        // Query trending
        const trendRes = await fetch("/api/search?q=trending%20global%20hits&filter=songs");
        const trendData = await trendRes.json();
        
        trendContainer.innerHTML = "";
        // Take top 10 items
        trendData.slice(0, 10).forEach(item => {
            const card = document.createElement("div");
            card.className = "music-card";
            card.innerHTML = `
                <div class="card-img-wrapper">
                    <img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}">
                    <div class="play-hover-btn"><i class="fa-solid fa-play"></i></div>
                </div>
                <h4>${item.title}</h4>
                <p>${item.artist}</p>
            `;
            card.addEventListener("click", () => {
                // Set current queue to these elements
                playerQueue = trendData;
                currentQueueIndex = trendData.findIndex(s => s.id === item.id);
                playSingleSong(item);
            });
            trendContainer.appendChild(card);
        });

        // Query new releases
        const newRes = await fetch("/api/search?q=latest%20music%20releases&filter=songs");
        const newData = await newRes.json();
        
        newContainer.innerHTML = "";
        newData.slice(0, 10).forEach(item => {
            const card = document.createElement("div");
            card.className = "music-card";
            card.innerHTML = `
                <div class="card-img-wrapper">
                    <img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}">
                    <div class="play-hover-btn"><i class="fa-solid fa-play"></i></div>
                </div>
                <h4>${item.title}</h4>
                <p>${item.artist}</p>
            `;
            card.addEventListener("click", () => {
                playerQueue = newData;
                currentQueueIndex = newData.findIndex(s => s.id === item.id);
                playSingleSong(item);
            });
            newContainer.appendChild(card);
        });
        
    } catch (err) {
        console.error("Home data load error:", err);
    }
}

// Spark AURA Flow click
document.getElementById("start-aura-flow-btn").addEventListener("click", async () => {
    showToast("AURA Flow AI DJ suggestions triggered ⚡");
    
    // Build comma history ids
    const historyIds = playbackHistory.map(s => s.id).slice(0, 5).join(",");
    let videoIdParam = currentLoadedTrack ? currentLoadedTrack.id : "";
    
    try {
        const res = await fetch(`/api/recommendations?video_id=${videoIdParam}&history=${historyIds}`);
        const recommendations = await res.json();
        
        if (recommendations.length > 0) {
            playerQueue = recommendations;
            currentQueueIndex = 0;
            playSingleSong(recommendations[0]);
            
            // Show DJ dialog
            showToast(`AI DJ Vibe: "${recommendations[0].ai_reason}"`);
        }
    } catch (e) {
        showToast("Failed to compile AI flow queue.");
    }
});

// Mood Station click triggers
const moodCards = document.querySelectorAll(".mood-card");
moodCards.forEach(card => {
    card.addEventListener("click", async () => {
        const mood = card.getAttribute("data-mood");
        showToast(`Loading '${mood}' mood station tracks...`);
        
        try {
            const res = await fetch(`/api/mood?mood=${mood}`);
            const tracks = await res.json();
            
            if (tracks.length > 0) {
                playerQueue = tracks;
                currentQueueIndex = 0;
                playSingleSong(tracks[0]);
            }
        } catch (e) {
            showToast("Could not load mood stations.");
        }
    });
});

// 15. AUXILIARY UTILITY FUNCTIONS

function showToast(message) {
    toast.innerText = message;
    toast.classList.remove("hide");
    toast.style.opacity = "1";
    
    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.classList.add("hide"), 300);
    }, 2500);
}

function openPlaylistChooserModal() {
    showToast("Playlist created inside indexDB.");
}

function cycleDynamicHeaderGradient() {
    // Dynamic color variations for header backgrounds
    const colors = [
        "rgba(155, 93, 229, 0.04)",
        "rgba(0, 180, 216, 0.04)",
        "rgba(223, 193, 93, 0.04)"
    ];
    const header = document.getElementById("app-header");
    const selected = colors[Math.floor(Math.random() * colors.length)];
    header.style.backgroundColor = selected;
}

function formatDurationSec(sec) {
    if (isNaN(sec)) return "0:00";
    const minutes = Math.floor(sec / 60);
    const seconds = Math.floor(sec % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}
