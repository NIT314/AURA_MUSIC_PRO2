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
// Audio Mode button active state update karo
function updateModeBtnUI(modeName) {
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.mode === modeName) {
            btn.classList.add('active');
        }
    });
}
window.updateModeBtnUI = updateModeBtnUI;

// XSS Protection Helper — user data ko safe banata hai
function safe(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Application State
let playerQueue = [];
let currentQueueIndex = -1;
let currentLoadedTrack = null;
let currentAudioObjectURL = null;
let lastPreloadedTrackId = null;
let playbackHistory = [];
let skippedTracks = [];
let infiniteQueue = [];
let likedSongs = [];
let downloadedSongs = [];
let searchHistory = [];
let playlists = [];
let localSongs = [];
let currentActionMenuTrack = null;
let currentActionMenuContext = null;
let playlistTargetTrack = null;
let incognitoMode = false;
let crossfadeDuration = 0; // seconds
let sleepTimerId = null;
let homeDataCache = null;
let searchResultsCache = [];
let currentActiveLyricIndex = -1;
let crossfadeIntervalId = null;
let searchDebounceTimer = null;
let suggestionsAbortController = null;
let normalSuggestionsAbortController = null;
let hiddenTracks = [];
let excludedFromRecommendations = [];

let repeatMode = "off"; // "off" | "list" | "track"
let isShuffleOn = false;
let shuffledQueueOrder = null; // array of indices, when shuffle is active

// Lite/Pro Mode state
let auraMode = "lite";           // "pro" | "lite"
let auraBackendUrl = "";         // user-supplied backend URL
let healthCheckIntervalId = null;

// Native Capacitor state
let isPlayingNative = false;
let isNativePlaybackPlaying = false;
let nativeTrackDuration = 0;

function isNative() {
    return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform && Capacitor.isNativePlatform();
}

const AuraPlayerPlugin = (isNative() && Capacitor.Plugins) ? Capacitor.Plugins.AuraPlayerPlugin : null;

window.isPlayingNative = () => isPlayingNative;
window.getAuraPlayerPlugin = () => AuraPlayerPlugin;
window.isNativePlaybackPlaying = () => isNativePlaybackPlaying;

// DOM Elements
const audio = document.getElementById("audio-element");
if (audio) {
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
}
const toast = document.getElementById("toast-notification");

document.addEventListener("DOMContentLoaded", () => {
    // 1. Initial State Restore
    restoreStateFromStorage();
    
    // 2. Initializations
    initUIHeader();
    initUserProfile();
    initTabNavigation();
    initSearchEngine();
    initPlayerBindings();
    initLibraryPlaylistSystem();
    initAuraJamBindings();
    initSoundStageUI();
    initSpeechAssistant();
    initThemesSystem();
    initMobileAudioUnlock();
    setupKeyboardShortcuts(); // 🔥 Keyboard shortcuts initialize karega
    initPlaybackOptionsDropdown();
    
    // Initialize Web Audio and Canvas
    window.initVisualizers();
    window.runAuraAtmosParticles();
    
    // Load Initial Home Data
    loadHomeData();
    
    // Initialize Lite/Pro mode detection
    initModeSystem();
    
    // Check if a track was shared
    checkSharedTrack();
});

function checkSharedTrack() {
    const urlParams = new URLSearchParams(window.location.search);
    const playTitle = urlParams.get('playTitle');
    const playArtist = urlParams.get('playArtist');
    const playId = urlParams.get('playId');
    if (playTitle && playId) {
        const sharedTrack = {
            id: playId,
            title: playTitle,
            artist: playArtist || 'Unknown Artist',
            thumbnail: urlParams.get('playThumb') || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80',
            duration: urlParams.get('playDuration') || '3:00'
        };
        setTimeout(() => {
            playSingleSong(sharedTrack);
            showToast(`Playing shared song: ${sharedTrack.title}`);
        }, 1500);
    }
}

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

// ==========================================
// INDEXEDDB BINARY STORAGE & UTILITY MODULE
// ==========================================
const dbName = "aura_music_db";
const storeName = "local_songs";

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 2);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName, { keyPath: "id" });
            }
            // v2: key-value config store for backend URL etc.
            if (!db.objectStoreNames.contains("config")) {
                db.createObjectStore("config", { keyPath: "key" });
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveLocalSongToDB(songMeta, fileBlob) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const data = {
            id: songMeta.id,
            meta: songMeta,
            file: fileBlob
        };
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

async function getLocalSongFileFromDB(id) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.get(id);
        request.onsuccess = (e) => {
            if (e.target.result) {
                resolve(e.target.result.file);
            } else {
                resolve(null);
            }
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function getAllLocalSongsFromDB() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = (e) => {
            const list = e.target.result || [];
            resolve(list.map(item => item.meta));
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function deleteLocalSongFromDB(id) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

// IndexedDB config store helpers
async function getConfigValue(key) {
    try {
        const db = await initDB();
        return new Promise((resolve) => {
            const tx = db.transaction("config", "readonly");
            const store = tx.objectStore("config");
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result ? req.result.value : null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function setConfigValue(key, value) {
    try {
        const db = await initDB();
        return new Promise((resolve) => {
            const tx = db.transaction("config", "readwrite");
            const store = tx.objectStore("config");
            store.put({ key, value });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch { return false; }
}

async function deleteConfigValue(key) {
    try {
        const db = await initDB();
        return new Promise((resolve) => {
            const tx = db.transaction("config", "readwrite");
            const store = tx.objectStore("config");
            store.delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch { return false; }
}

// 1. STATE MANAGEMENT

function restoreStateFromStorage() {
    try {
        likedSongs = JSON.parse(localStorage.getItem("aura_liked")) || [];
    } catch (e) {
        console.error("Storage restore failed for likedSongs:", e);
        likedSongs = [];
    }
    try {
        downloadedSongs = JSON.parse(localStorage.getItem("aura_downloads")) || [];
    } catch (e) {
        console.error("Storage restore failed for downloadedSongs:", e);
        downloadedSongs = [];
    }
    try {
        searchHistory = JSON.parse(localStorage.getItem("aura_search_history")) || [];
    } catch (e) {
        console.error("Storage restore failed for searchHistory:", e);
        searchHistory = [];
    }
    try {
        playbackHistory = JSON.parse(localStorage.getItem("aura_history")) || [];
    } catch (e) {
        console.error("Storage restore failed for playbackHistory:", e);
        playbackHistory = [];
    }
    try {
        playlists = JSON.parse(localStorage.getItem("aura_my_playlists")) || [];
    } catch (e) {
        console.error("Storage restore failed for playlists:", e);
        playlists = [];
    }
    try {
        getAllLocalSongsFromDB().then(songs => {
            localSongs = songs || [];
            renderLocalSongs();
        }).catch(err => {
            console.error("Failed to load local songs from IndexedDB:", err);
        });
    } catch (e) {
        console.error("IndexedDB load invocation failed:", e);
    }
    try {
        // Apply liked count text
        updateLikedCount();
    } catch (e) {
        console.error("Storage restore updateLikedCount failed:", e);
    }
    try {
        excludedFromRecommendations = JSON.parse(localStorage.getItem("aura_excluded_taste")) || [];
    } catch (e) {
        console.error("Storage restore failed for excludedFromRecommendations:", e);
        excludedFromRecommendations = [];
    }
    try {
        skippedTracks = JSON.parse(localStorage.getItem("aura_skipped_tracks")) || [];
    } catch (e) {
        console.error("Storage restore failed for skippedTracks:", e);
        skippedTracks = [];
    }
    try {
        repeatMode = localStorage.getItem("aura_repeat_mode") || "off";
        if (repeatMode !== "off" && repeatMode !== "list" && repeatMode !== "track") {
            repeatMode = "off";
        }
    } catch (e) {
        console.error("Storage restore failed for repeatMode:", e);
        repeatMode = "off";
    }
    try {
        isShuffleOn = localStorage.getItem("aura_shuffle_on") === "true";
    } catch (e) {
        console.error("Storage restore failed for isShuffleOn:", e);
        isShuffleOn = false;
    }
    // Update player control buttons UI on load
    if (typeof updatePlayerControlsUI === "function") {
        updatePlayerControlsUI();
    }
}

function saveStateToStorage(key, data) {
    if (incognitoMode && (key === "aura_history" || key === "aura_search_history")) return;
    localStorage.setItem(key, JSON.stringify(data));
}

// 2. UI NAVIGATION & HEADER

function initUIHeader() {
    updateGreetingText();

    // Toggle Incognito Button
    const privateBtn = document.getElementById("private-mode-btn");
    if (privateBtn) {
        privateBtn.addEventListener("click", toggleIncognito);
    }
}

function updateGreetingText() {
    const greeting = document.getElementById("greeting-text");
    if (!greeting) return;
    
    const hours = new Date().getHours();
    const name = localStorage.getItem("aura_user_name") || "";
    const nameStr = name ? `, ${name}` : "";
    
    if (hours < 12) {
        greeting.innerHTML = `Good Morning${nameStr} ☀️`;
    } else if (hours < 18) {
        greeting.innerHTML = `Good Afternoon${nameStr} 🌤️`;
    } else {
        greeting.innerHTML = `Good Evening${nameStr} 🌙`;
    }
}

function initUserProfile() {
    const userProfileBtn = document.querySelector(".user-profile");
    if (userProfileBtn) {
        userProfileBtn.addEventListener("click", openProfileModal);
    }
    
    const closeProfileBtn = document.getElementById("close-profile-modal-btn");
    const saveProfileBtn = document.getElementById("save-profile-btn");
    
    if (closeProfileBtn) {
        closeProfileBtn.addEventListener("click", () => {
            document.getElementById("modal-container").classList.add("hide");
            document.getElementById("profile-modal").classList.add("hide");
        });
    }
    
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener("click", () => {
            const nameInput = document.getElementById("profile-name-input");
            const photoInput = document.getElementById("profile-photo-input");
            
            const newName = nameInput ? nameInput.value.trim() : "";
            const newPhoto = photoInput ? photoInput.value.trim() : "";
            
            if (newName) {
                localStorage.setItem("aura_user_name", newName);
            } else {
                localStorage.removeItem("aura_user_name");
            }
            
            if (newPhoto) {
                localStorage.setItem("aura_user_photo", newPhoto);
            } else {
                localStorage.removeItem("aura_user_photo");
            }
            
            updateUserProfileUI();
            
            document.getElementById("modal-container").classList.add("hide");
            document.getElementById("profile-modal").classList.add("hide");
            showToast("Profile updated successfully! ✨");
        });
    }
    
    updateUserProfileUI();
}

function openProfileModal() {
    const modalContainer = document.getElementById("modal-container");
    const playlistModal = document.getElementById("playlist-modal");
    const profileModal = document.getElementById("profile-modal");
    
    const nameInput = document.getElementById("profile-name-input");
    const photoInput = document.getElementById("profile-photo-input");
    
    if (nameInput) nameInput.value = localStorage.getItem("aura_user_name") || "";
    if (photoInput) photoInput.value = localStorage.getItem("aura_user_photo") || "";
    
    if (playlistModal) playlistModal.classList.add("hide");
    if (profileModal) profileModal.classList.remove("hide");
    if (modalContainer) modalContainer.classList.remove("hide");
}

function updateUserProfileUI() {
    const savedPhoto = localStorage.getItem("aura_user_photo");
    
    // Update avatar image
    const avatar = document.getElementById("user-avatar");
    if (avatar) {
        avatar.src = savedPhoto || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80";
    }
    
    // Update Greeting
    updateGreetingText();
}

function initTabNavigation() {
    const navButtons = document.querySelectorAll(".nav-btn");
    const tabPanels = document.querySelectorAll(".tab-panel");

    // Connect both desktop sidebar buttons and mobile tab bar buttons (we will create mobile tabs dynamically)
function switchTab(tabId) {
         if (auraMode === "lite" && tabId === "jam") {
             showToast(`AURA JAM is only available in Pro Mode.`);
             return;
         }
         if (auraMode === "lite" && currentLoadedTrack && currentLoadedTrack.isLocal !== true && tabId === "equalizer") {
             showToast(`Equalizer is only available for local files in Lite Mode.`);
             return;
         }
        const fullPlayer = document.getElementById("full-player");
        if (fullPlayer && fullPlayer.classList.contains("player-open")) {
            fullPlayer.classList.remove("player-open");
        }

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

    // Close dynamic view on back button click
    const closeDynamicBtn = document.getElementById("close-dynamic-view-btn");
    if (closeDynamicBtn) {
        closeDynamicBtn.addEventListener("click", () => {
            document.getElementById("dynamic-view-panel").classList.add("hide");
        });
    }

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
        { id: "equalizer", icon: "fa-sliders", label: "EQ" },
        { id: "stats", icon: "fa-chart-simple", label: "Stats" }
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
    
    let selectedFilter = "all";

    searchInput.addEventListener("input", () => {
        const val = searchInput.value.trim();
        clearTimeout(searchDebounceTimer);
        
        if (val) {
            clearBtn.style.display = "block";
            
            // Debounce Suggestion API
            searchDebounceTimer = setTimeout(() => {
                fetchSuggestions(val);
            }, 300);
        } else {
            clearBtn.style.display = "none";
            suggestionBox.classList.add("hide");
            if (suggestionsAbortController) suggestionsAbortController.abort();
            if (normalSuggestionsAbortController) normalSuggestionsAbortController.abort();
        }
    });

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const query = searchInput.value.trim();
            if (query) {
                clearTimeout(searchDebounceTimer);
                if (suggestionsAbortController) suggestionsAbortController.abort();
                if (normalSuggestionsAbortController) normalSuggestionsAbortController.abort();
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

    // Render Browse Categories dynamically
    renderCategories();

    // Clear history click
    document.getElementById("clear-history-btn").addEventListener("click", () => {
        searchHistory = [];
        saveStateToStorage("aura_search_history", searchHistory);
        renderSearchHistory();
    });

    renderSearchHistory();
}

function renderCategories() {
    const container = document.getElementById("category-grid-container");
    if (!container) return;
    
    container.innerHTML = "";
    
    const PREMIUM_CATEGORIES = [
        { name: 'Bollywood Hits', color: 'c1', icon: 'fa-music' },
        { name: 'Global Pop', color: 'c2', icon: 'fa-globe' },
        { name: 'Chill Vibes', color: 'c3', icon: 'fa-cloud' },
        { name: 'Workout', color: 'c4', icon: 'fa-dumbbell' },
        { name: 'Indie & Folk', color: 'c5', icon: 'fa-guitar' },
        { name: 'Jazz & Blues', color: 'c6', icon: 'fa-record-vinyl' },
        { name: 'Electronic', color: 'c1', icon: 'fa-bolt' },
        { name: 'Hip Hop', color: 'c2', icon: 'fa-microphone' },
        { name: 'Classical', color: 'c3', icon: 'fa-music' },
        { name: 'Rock', color: 'c4', icon: 'fa-fire' },
        { name: 'Focus', color: 'c5', icon: 'fa-brain' },
        { name: 'Party', color: 'c6', icon: 'fa-champagne-glasses' }
    ];
    
    PREMIUM_CATEGORIES.forEach(cat => {
        const card = document.createElement("div");
        card.className = `category-card ${cat.color}`;
        card.setAttribute("data-query", cat.name);
        card.innerHTML = `
            <span>${cat.name}</span>
            <i class="fa-solid ${cat.icon}" style="position: absolute; bottom: 15px; right: 15px; font-size: 24px; opacity: 0.15; transform: rotate(15deg);"></i>
        `;
        card.addEventListener("click", () => {
            const searchInput = document.getElementById("search-input");
            const clearBtn = document.getElementById("clear-search-btn");
            if (searchInput) searchInput.value = cat.name;
            if (clearBtn) clearBtn.style.display = "block";
            performSearch(cat.name, "all");
        });
        container.appendChild(card);
    });
}

async function fetchSuggestions(q) {
    if (auraMode === "lite") {
        return fetchSuggestionsLite(q);
    }
    
    if (normalSuggestionsAbortController) {
        normalSuggestionsAbortController.abort();
    }
    normalSuggestionsAbortController = new AbortController();
    const signal = normalSuggestionsAbortController.signal;
    
    try {
        const res = await fetch(`/api/suggestions?q=${encodeURIComponent(q)}`, { signal });
        const suggestions = await res.json();
        if (!signal.aborted) {
            renderSuggestionsUI(suggestions);
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error("Suggestions fetch error:", e);
        }
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
            clearTimeout(searchDebounceTimer);
            if (suggestionsAbortController) suggestionsAbortController.abort();
            if (normalSuggestionsAbortController) normalSuggestionsAbortController.abort();
            document.getElementById("search-input").value = s;
            box.classList.add("hide");
            performSearch(s, "all");
        });
        box.appendChild(item);
    });
    
    box.classList.remove("hide");
}

async function performSearch(q, filter) {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
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

    if (auraMode === "lite") {
        return performSearchLite(q, filter, resultsContainer);
    }

    try {
        const url = `/api/search?q=${encodeURIComponent(q)}&filter=${filter}`;
        const res = await fetch(url);
        const results = await res.json();
        searchResultsCache = results;
        renderSearchResults(results);
    } catch (err) {
        resultsContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Search failed. Check network connection.</p></div>`;
    }
}

function renderSearchResults(results) {
    const container = document.getElementById("search-results-container");
    container.innerHTML = "";
    
    const filteredResults = results.filter(item => !hiddenTracks.includes(item.id));
    if (filteredResults.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-compact-disc"></i><p>No results found for query.</p></div>`;
        return;
    }
    
    filteredResults.forEach((item) => {
        const row = document.createElement("div");
        row.className = "track-row";
        
        // Define action depending on search result category (song, artist, album)
        if (item.type === "song" || item.type === "video") {
            const isLiked = likedSongs.some(s => s.id === item.id);

            // Single click handler — Jam mode mein menu, warna seedha play
            row.addEventListener("click", (e) => {
                if (e.target.closest('button')) return;
                if (window.isInsideJam()) {
                    showJamSelectionMenu(item);
                } else {
                    playSingleSong(item);
                }
            });

            row.innerHTML = `
                <div class="track-row-art"><img src="${safe(item.thumbnail) || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}">
                </div>
                <div class="track-row-info">
                    <h4>${safe(item.title)}</h4>
                    <p>${safe(item.artist)} • ${safe(item.album) || 'Single'}</p>
                </div>
                <div class="track-row-actions">
                    <span class="track-duration-badge">${safe(item.duration)}</span>
                    <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(item.id)}', {type: 'none'})"><i class="fa-solid fa-ellipsis-vertical"></i></button>
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
    if (track && track.id && String(track.id).startsWith("local_")) {
        showToast("Local files cannot be shared in a Jam session ⚠️");
        return;
    }

    const isListener = window.getJamRole && window.getJamRole() === 'listener';
    const addOnlyMode = window.getJamAddOnlyMode && window.getJamAddOnlyMode();
    const canAdd = !isListener || addOnlyMode;

    if (isListener && !canAdd) {
        showToast("🎵 Listeners cannot add songs when Add-Only Mode is OFF");
        return;
    }

    // Prevent duplicates/stacking
    const existing = document.getElementById("jam-selection-popup-wrapper");
    if (existing) existing.remove();

    // Create wrapper for backdrop and click outside detection
    const wrapper = document.createElement("div");
    wrapper.id = "jam-selection-popup-wrapper";
    wrapper.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:99999; display:flex; align-items:center; justify-content:center;";

    // Open a toast options drawer
    const popup = document.createElement("div");
    popup.className = "modal-card glass-panel";
    popup.style.cssText = "position:relative; z-index:100000; width:90%; max-width:400px; padding:20px; border-radius:12px;";
    
    popup.innerHTML = `
        <h3>Jam Selection</h3>
        <p style="font-size:12px; margin-bottom:15px; color:var(--text-secondary);">Choose action for '${safe(track.title)}'</p>
        <div style="display:flex; flex-direction:column; gap:10px;">
            ${isListener ? '' : '<button class="btn btn-purple" id="jam-opt-play-now">Sync Play Now</button>'}
            ${canAdd ? '<button class="btn btn-gold" id="jam-opt-add-queue">Add to Jam Queue</button>' : ''}
            <button class="btn" id="jam-opt-cancel">Cancel</button>
        </div>
    `;
    
    wrapper.appendChild(popup);
    document.body.appendChild(wrapper);
    
    // Close on outside click
    wrapper.onclick = (e) => {
        if (e.target === wrapper) {
            wrapper.remove();
        }
    };
    
    if (!isListener) {
        document.getElementById("jam-opt-play-now").onclick = () => {
            wrapper.remove();
            
            playSingleSong(track);
            // Jam mein sabko broadcast karo
            if (window.isInsideJam && window.isInsideJam()) {
                setTimeout(() => {
                    window.sendJamPlaybackUpdate(
                        track.id,
                        "PLAYING",
                        0,
                        track
                    );
                }, 800); // Stream load hone ke baad broadcast karo
            }
        };
    }
    
    if (canAdd) {
        document.getElementById("jam-opt-add-queue").onclick = () => {
            wrapper.remove();
            window.sendJamAddQueue(track);
            showToast("Added to Jam Queue");
        };
    }
    
    document.getElementById("jam-opt-cancel").onclick = () => {
        wrapper.remove();
    };
}
window.showJamSelectionMenu = showJamSelectionMenu;

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
        
        if (window.isInsideJam && window.isInsideJam()) {
            const role = window.getJamRole ? window.getJamRole() : 'listener';
            if (role !== 'host' && role !== 'co-host') {
                showToast("🎵 Only Host or Co-Host can control playback in Jam");
                return;
            }
        }
        
        // Lazy init Audio Engine on first click
        window.initEqualizer(audio);
        window.resumeAudioContext();
        
        if (isNative() && isPlayingNative && AuraPlayerPlugin) {
            if (isNativePlaybackPlaying) {
                AuraPlayerPlugin.pause().catch(err => console.error("Native pause failed:", err));
            } else {
                AuraPlayerPlugin.resume().catch(err => console.error("Native resume failed:", err));
            }
        } else {
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
        }
    };

    mainPlayBtn.addEventListener("click", togglePlay);
    miniPlayBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // Avoid opening full player on play tap
        togglePlay();
    });

    // Next/Prev buttons
    document.getElementById("player-next-btn").addEventListener("click", () => playNextTrack(true));
    document.getElementById("mini-next-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        playNextTrack(true);
    });
    
    document.getElementById("player-prev-btn").addEventListener("click", playPrevTrack);

    // Audio End Listener
    audio.addEventListener("ended", () => {
        playNextTrack(false);
    });

    // Audio Timestamp updater
    const seekbar = document.getElementById("player-seekbar");
    const currentTimer = document.getElementById("player-time-current");
    
    audio.addEventListener("timeupdate", () => {
        if (isNaN(audio.duration)) return;
        
        const pct = (audio.currentTime / audio.duration) * 100;
        seekbar.value = pct;
        
        // Update seekbar background gradient fill visually
        seekbar.style.background = `linear-gradient(to right, var(--gold) ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
        
        // Mini player progress line
        document.getElementById("mini-progress-fill").style.width = `${pct}%`;
        
        currentTimer.innerText = formatDurationSec(audio.currentTime);

        // Preload next track if remaining time is less than 20 seconds
        checkPreloadNextTrack();
        
        // Syced lyrics timing cursor alignment
        updateLyricsTimeline(audio.currentTime);
    });

    // Seek bar manual seek input (updates UI gradient fill only, checks role permission)
    seekbar.addEventListener("input", (e) => {
        if (window.isInsideJam && window.isInsideJam()) {
            const role = window.getJamRole ? window.getJamRole() : 'listener';
            if (role !== 'host' && role !== 'co-host') {
                showToast("🎵 Only Host or Co-Host can control playback in Jam");
                // Reset seekbar value to current position pct
                const duration = (isNative() && isPlayingNative) ? nativeTrackDuration : audio.duration;
                const currentPos = audio.currentTime;
                const pct = (currentPos / duration) * 100;
                seekbar.value = isNaN(pct) ? 0 : pct;
                seekbar.style.background = `linear-gradient(to right, var(--gold) ${seekbar.value}%, rgba(255,255,255,0.1) ${seekbar.value}%)`;
                return;
            }
        }
        seekbar.style.background = `linear-gradient(to right, var(--gold) ${seekbar.value}%, rgba(255,255,255,0.1) ${seekbar.value}%)`;
    });

    // Seek bar manual seek release (performs seek and broadcasts changes)
    seekbar.addEventListener("change", () => {
        if (window.isInsideJam && window.isInsideJam()) {
            const role = window.getJamRole ? window.getJamRole() : 'listener';
            if (role !== 'host' && role !== 'co-host') {
                return;
            }
        }

        if (isNative() && isPlayingNative && AuraPlayerPlugin) {
            if (nativeTrackDuration > 0) {
                const targetPos = (seekbar.value / 100) * nativeTrackDuration;
                AuraPlayerPlugin.seek({ position: targetPos }).catch(err => console.error("Native seek failed:", err));
                
                // Notify Jam WebSocket if in co-listening
                if (window.isInsideJam() && (window.getJamRole() === 'host' || window.getJamRole() === 'co-host')) {
                    window.sendJamPlaybackUpdate(
                        currentLoadedTrack.id, 
                        isNativePlaybackPlaying ? "PLAYING" : "PAUSED", 
                        targetPos, 
                        currentLoadedTrack
                    );
                }
            }
            return;
        }

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

    // Wire Player 3-Dot settings button to open action sheet menu
    const settingsBtn = document.getElementById("player-settings-btn");
    if (settingsBtn) {
        settingsBtn.addEventListener("click", (event) => {
            if (currentLoadedTrack) {
                openTrackActionMenu(event, currentLoadedTrack.id, {type: 'none'});
            } else {
                showToast("No song currently loaded.");
            }
        });
    }

    // Actions bindings on Full Player
    document.getElementById("player-like-btn").addEventListener("click", toggleLikeActiveTrack);
    document.getElementById("mini-like-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLikeActiveTrack();
    });
    
    document.getElementById("player-download-btn").addEventListener("click", downloadActiveTrack);
    document.getElementById("player-playlist-btn").addEventListener("click", openPlaylistChooserModal);
    
    // Queue drawer toggle
    document.getElementById("player-queue-toggle-btn").addEventListener("click", () => {
        const drawer = document.getElementById("player-queue-drawer");
        drawer.classList.toggle("drawer-open");
        const backdrop = document.getElementById("player-drawer-backdrop");
        if (drawer.classList.contains("drawer-open")) {
            if (backdrop) backdrop.classList.remove("hide");
            renderQueueDrawer();
        } else {
            drawer.classList.remove("drawer-expanded");
            if (backdrop) backdrop.classList.add("hide");
        }
    });
    document.querySelectorAll(".close-drawer-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const drawer = btn.closest(".player-drawer");
            drawer.classList.remove("drawer-open", "drawer-expanded");
            const backdrop = document.getElementById("player-drawer-backdrop");
            if (backdrop) backdrop.classList.add("hide");
        });
    });

    // Dynamic color change based on header timeline (greetings colors)
    setInterval(cycleDynamicHeaderGradient, 8000);
    cycleDynamicHeaderGradient();
    
    // Setup Gestures Overlay on Full Screen Player cover
    setupPlayerGestures();

    // Initialize Song/Lyrics view toggle pill (Round B1)
    initViewTogglePill();

    // Native Player State Change Event Listener
    if (isNative() && AuraPlayerPlugin) {
        AuraPlayerPlugin.addListener('onStateChange', (info) => {
            console.log("Native player state change event:", info);
            
            // 1. Check queue skip controls from lockscreen/headset
            if (info.action === "next") {
                playNextTrack(true); // Reuse existing next track logic
                return;
            }
            if (info.action === "prev") {
                playPrevTrack(); // Reuse existing prev track logic
                return;
            }
            
            // Update native player states
            isNativePlaybackPlaying = info.isPlaying;
            onSongPlayStateChange(info.isPlaying);
            
            if (info.duration > 0) {
                nativeTrackDuration = info.duration;
                const pct = (info.currentPosition / info.duration) * 100;
                const seekbar = document.getElementById("player-seekbar");
                const currentTimer = document.getElementById("player-time-current");
                const miniProgressFill = document.getElementById("mini-progress-fill");
                
                if (seekbar) {
                    seekbar.value = pct;
                    seekbar.style.background = `linear-gradient(to right, var(--gold) ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
                }
                if (miniProgressFill) {
                    miniProgressFill.style.width = `${pct}%`;
                }
                if (currentTimer) {
                    currentTimer.innerText = formatDurationSec(info.currentPosition);
                }
                
                // Sync internal audio.currentTime for visualizers and Jam broadcasts
                try {
                    audio.currentTime = info.currentPosition;
                } catch (e) {
                    // Suppress if audio element is not initialized/loaded
                }
                
                // Update lyrics timeline cursor
                updateLyricsTimeline(info.currentPosition);
            }
            
            if (info.error) {
                showToast(`Native player error: ${info.error}`);
            }
        });
    }
}

function initViewTogglePill() {
    const toggle = document.getElementById("player-view-toggle");
    if (!toggle) return;
    const buttons = toggle.querySelectorAll(".view-toggle-btn");
    const leftStage = document.querySelector(".player-left-stage");
    
    buttons.forEach(btn => {
        btn.addEventListener("click", () => {
            buttons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            const view = btn.dataset.view;
            if (view === "lyrics") {
                leftStage.classList.add("lyrics-mode");
                // Sync scroll position of lyrics immediately on switch
                if (currentActiveLyricIndex !== -1) {
                    const activeLine = document.querySelector(`#lyrics-lines-container .lyrics-line[data-index="${currentActiveLyricIndex}"]`);
                    if (activeLine) {
                        const scroller = document.getElementById("lyrics-lines-container");
                        setTimeout(() => {
                            const scrollerHeight = scroller.clientHeight;
                            const lineTop = activeLine.offsetTop;
                            const lineScale = activeLine.clientHeight;
                            scroller.scrollTo({
                                top: lineTop - (scrollerHeight * 0.4) + (lineScale / 2),
                                behavior: 'auto'
                            });
                        }, 50);
                    }
                }
            } else {
                leftStage.classList.remove("lyrics-mode");
            }
        });
    });
}

// 🔥 KEYBOARD SHORTCUTS ENGINE
function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
        // Agar user search ya chat input mein type kar raha hai, toh shortcut ignore karo
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

        if (e.code === "Space") {
            e.preventDefault(); // Space dabane par page scroll hone se rokega
            const mainPlayBtn = document.getElementById("player-play-btn");
            if (mainPlayBtn) mainPlayBtn.click(); // Play/Pause trigger
        } else if (e.code === "ArrowRight") {
            playNextTrack(true);
            showToast("Next Track ⏭️");
        } else if (e.code === "ArrowLeft") {
            playPrevTrack();
            showToast("Previous Track ⏮️");
        }
    });
}

function onSongPlayStateChange(isPlaying) {
    const mainPlayBtn = document.getElementById("player-play-btn");
    const miniPlayBtn = document.getElementById("mini-play-btn");
    const playerArtwork = document.getElementById("player-artwork");
    
    if (isPlaying) {
        mainPlayBtn.innerHTML = `<i class="fa-solid fa-pause"></i>`;
        miniPlayBtn.innerHTML = `<i class="fa-solid fa-pause"></i>`;
        document.body.classList.add("playing-state");
        if (playerArtwork) playerArtwork.classList.add("spinning");
        window.startVisualizerLoop();
    } else {
        mainPlayBtn.innerHTML = `<i class="fa-solid fa-play"></i>`;
        miniPlayBtn.innerHTML = `<i class="fa-solid fa-play"></i>`;
        document.body.classList.remove("playing-state");
        if (playerArtwork) playerArtwork.classList.remove("spinning");
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

window.playSingleSong = playSingleSong;
async function playSingleSong(track, autoplay = true, fromJamSync = false, keepInfiniteQueue = false) {
    if (!track) return;

    if (!keepInfiniteQueue) {
        infiniteQueue = [];
    }

    // Update currentQueueIndex if the played track is not the one at currentQueueIndex in playerQueue
    if (currentQueueIndex === -1 || !playerQueue[currentQueueIndex] || playerQueue[currentQueueIndex].id !== track.id) {
        const qIdx = playerQueue.findIndex(t => t.id === track.id);
        if (qIdx !== -1) {
            currentQueueIndex = qIdx;
        } else {
            currentQueueIndex = -1;
        }
    }

    // Check if the previous song was skipped (played for less than 10 seconds and not ended naturally)
    if (currentLoadedTrack && audio.currentTime < 10 && !audio.ended && track.id !== currentLoadedTrack.id) {
        if (!skippedTracks.includes(currentLoadedTrack.id)) {
            skippedTracks.unshift(currentLoadedTrack.id);
            if (skippedTracks.length > 50) {
                skippedTracks.pop();
            }
            saveStateToStorage("aura_skipped_tracks", skippedTracks);
        }
    }

    // Reset playback rate in case it was modified by Jam mode sync
    audio.playbackRate = 1.0;

    // Jam mein sirf host/co-host song change kar sakta hai
    // fromJamSync = true matlab jam.js se sync aa raha hai — allow karo
    if (window.isInsideJam() && !fromJamSync) {
        const role = window.getJamRole ? window.getJamRole() : 'listener';
        if (role !== 'host' && role !== 'co-host') {
            showToast("🎵 Only Host or Co-Host can change songs in Jam");
            return;
        }
    }
    
    // Clear any active crossfade interval if playing a song manually
    if (crossfadeIntervalId) {
        clearInterval(crossfadeIntervalId);
        crossfadeIntervalId = null;
        audio.volume = 0.8;
    }
    
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
            if (window.resumeAudioContext) window.resumeAudioContext();
            audio.play(); onSongPlayStateChange(true); 
        });
        navigator.mediaSession.setActionHandler('pause', () => { 
            audio.pause(); onSongPlayStateChange(false); 
        });
        const inJam = window.isInsideJam && window.isInsideJam();
        const canPrev = inJam || playerQueue.length > 0;
        const canNext = inJam || playerQueue.length > 0;
        navigator.mediaSession.setActionHandler('previoustrack', canPrev ? playPrevTrack : null);
        navigator.mediaSession.setActionHandler('nexttrack', canNext ? () => playNextTrack(true) : null);
    }
    // ===============================================
    document.getElementById("mini-artist").innerText = track.artist;
    document.getElementById("mini-artwork").src = track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80';
    
    document.getElementById("player-title").innerText = track.title;
    document.getElementById("player-artist").innerText = track.artist;
    document.getElementById("player-artwork").src = track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80';
    document.getElementById("player-time-total").innerText = track.duration || "3:00";
    
    // Reset view toggle state to Song (headphone) mode on fresh play (Round B1)
    const leftStage = document.querySelector(".player-left-stage");
    if (leftStage) {
        leftStage.classList.remove("lyrics-mode");
    }
    const viewButtons = document.querySelectorAll("#player-view-toggle .view-toggle-btn");
    viewButtons.forEach(btn => {
        if (btn.dataset.view === "song") {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
    
    // Artwork dynamic glow shadow
    if (track.thumbnail) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = track.thumbnail;
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = 10;
                canvas.height = 10;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, 10, 10);
                const imgData = ctx.getImageData(0, 0, 10, 10).data;
                
                let rSum = 0, gSum = 0, bSum = 0, count = 0;
                for (let i = 0; i < imgData.length; i += 4) {
                    rSum += imgData[i];
                    gSum += imgData[i+1];
                    bSum += imgData[i+2];
                    count++;
                }
                const r = Math.round(rSum / count);
                const g = Math.round(gSum / count);
                const b = Math.round(bSum / count);
                
                document.getElementById("full-player-dynamic-bg").style.background = `radial-gradient(circle, rgba(${r}, ${g}, ${b}, 0.45) 0%, rgba(8, 8, 12, 1) 90%)`;
            } catch (err) {
                // Fallback on CORS/Canvas errors
                document.getElementById("full-player-dynamic-bg").style.background = `radial-gradient(circle, rgba(155, 93, 229, 0.45) 0%, rgba(8, 8, 12, 1) 90%)`;
            }
        };
        img.onerror = () => {
            document.getElementById("full-player-dynamic-bg").style.background = `radial-gradient(circle, rgba(155, 93, 229, 0.45) 0%, rgba(8, 8, 12, 1) 90%)`;
        };
    } else {
        document.getElementById("full-player-dynamic-bg").style.background = `radial-gradient(circle, rgba(155, 93, 229, 0.45) 0%, rgba(8, 8, 12, 1) 90%)`;
    }
    
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
        // Pehle purana audio properly band karo
        audio.pause();

        // Reset seekbar and timer UI to 0
        const seekbar = document.getElementById("player-seekbar");
        const currentTimer = document.getElementById("player-time-current");
        const miniProgressFill = document.getElementById("mini-progress-fill");
        if (seekbar) {
            seekbar.value = 0;
            seekbar.style.background = `linear-gradient(to right, var(--gold) 0%, rgba(255,255,255,0.1) 0%)`;
        }
        if (currentTimer) {
            currentTimer.innerText = "0:00";
        }
        if (miniProgressFill) {
            miniProgressFill.style.width = "0%";
        }

        if (currentAudioObjectURL) {
            URL.revokeObjectURL(currentAudioObjectURL);
            currentAudioObjectURL = null;
        }
        audio.src = "";
        audio.load();

        if (isNative() && AuraPlayerPlugin) {
            // Stop any current native playback
            AuraPlayerPlugin.stop().catch(() => {});
        }

        if (track.isLocal) {
            isPlayingNative = false;
            console.log(`Retrieving local song file from IndexedDB: ${track.title}`);
            const fileBlob = await getLocalSongFileFromDB(track.id);
            if (fileBlob) {
                const objectUrl = URL.createObjectURL(fileBlob);
                currentAudioObjectURL = objectUrl;
                audio.src = objectUrl;
            } else {
                showToast("Local file not found in database. 🎙️❌");
                return;
            }
        } else {
            // Check if track is cached offline first!
            const cache = await caches.open("aura-audio-cache");
            const cacheKey = `/api/stream?video_id=${track.id}`;
            const cachedResponse = await cache.match(cacheKey);

            if (cachedResponse) {
                isPlayingNative = false;
                console.log(`Loading cached offline stream for ${track.title}`);
                const audioBlob = await cachedResponse.blob();
                const objectUrl = URL.createObjectURL(audioBlob);
                currentAudioObjectURL = objectUrl;
                audio.src = objectUrl;
                showToast("Playing Offline Saved Audio 📶");
            } else {
                // Online stream proxy
                if (auraMode === "lite" && !(window.isInsideJam && window.isInsideJam())) {
                    showToast("Pro Mode Server connection required to stream this song.");
                    return;
                }
                
                if (isNative() && AuraPlayerPlugin) {
                    isPlayingNative = true;
                    // Mute/Pause HTML5 audio player
                    audio.pause();
                    audio.src = "";
                    audio.load();
                    
                    const streamUrl = `${auraBackendUrl}/api/stream?video_id=${track.id}`;
                    const artworkUrl = track.thumbnail || '';
                    
                    AuraPlayerPlugin.play({
                        url: streamUrl,
                        title: track.title,
                        artist: track.artist,
                        artwork: artworkUrl,
                        trackId: track.id
                    }).then(() => {
                        console.log("Native player playing:", track.title);
                    }).catch(err => {
                        console.error("Native play failed:", err);
                        showToast("Failed to play natively");
                    });
                    return; // Early return to bypass HTML5 audio.load() and autoplay block below
                } else {
                    isPlayingNative = false;
                    const baseUrl = (auraBackendUrl && auraBackendUrl.startsWith("http")) 
                                    ? auraBackendUrl 
                                    : window.location.origin; // Fallback to page origin for Jam listeners
                    audio.src = `${baseUrl}/api/stream?video_id=${track.id}`;
                }
            }
        }

        // Naya source load karo
        audio.load();
            
        if (autoplay) {
            const onCanPlay = () => {
                audio.play().then(() => {
                    onSongPlayStateChange(true);
                }).catch((err) => {
                    console.error("Playback load notice:", err);
                    onSongPlayStateChange(false);
                    if (err.name !== 'AbortError') {
                        showToast("Buffering... Press Play again if it stops.");
                    }
                });
            };

            // Clean up old handler if any to prevent duplicate calls
            if (audio._onCanPlayHandler) {
                audio.removeEventListener("canplay", audio._onCanPlayHandler);
            }
            audio._onCanPlayHandler = onCanPlay;
            audio.addEventListener("canplay", onCanPlay, { once: true });
        } else {
            if (audio._onCanPlayHandler) {
                audio.removeEventListener("canplay", audio._onCanPlayHandler);
                audio._onCanPlayHandler = null;
            }
        }
    } catch (err) {
        console.error("Stream load failed:", err);
        showToast("Error loading audio source.");
    }
}

function checkPreloadNextTrack() {
    if (!audio || audio.paused || isNaN(audio.duration)) return;
    
    const remaining = audio.duration - audio.currentTime;
    if (remaining < 20 && remaining > 5) {
        let nextTrack = null;
        if (window.isInsideJam && window.isInsideJam()) {
            const queue = window.getJamQueue ? window.getJamQueue() : [];
            const currentTrack = window.currentLoadedTrack;
            if (currentTrack && queue.length > 0) {
                const idx = queue.findIndex(t => t.id === currentTrack.id);
                if (idx !== -1 && idx + 1 < queue.length) {
                    nextTrack = queue[idx + 1];
                }
            }
        } else {
            // Local player queue next track
            if (playerQueue && playerQueue.length > 0) {
                const nextIdx = getNextTrackIndex(false);
                if (nextIdx !== -1 && nextIdx !== currentQueueIndex) {
                    nextTrack = playerQueue[nextIdx];
                }
            }
        }
        
        if (nextTrack && !nextTrack.isLocal && lastPreloadedTrackId !== nextTrack.id) {
            lastPreloadedTrackId = nextTrack.id;
            console.log(`Preloading next track stream: ${nextTrack.title}`);
            const link = document.createElement("link");
            link.rel = "prefetch";
            link.as = "audio";
            const baseUrl = (auraBackendUrl && auraBackendUrl.startsWith("http")) 
                            ? auraBackendUrl 
                            : window.location.origin;
            link.href = `${baseUrl}/api/stream?video_id=${nextTrack.id}`;
            document.head.appendChild(link);
        }
    }
}

window.playSongById = async (video_id, trackData, seekPos = 0, autoPlay = true) => {
    // fromJamSync = true — jam.js se aa raha hai, listener block mat ho
    await playSingleSong(trackData, autoPlay, true);
    if (seekPos > 0) {
        const waitForLoad = () => {
            if (audio.readyState >= 2) {
                audio.currentTime = seekPos;
            } else {
                setTimeout(waitForLoad, 300);
            }
        };
        setTimeout(waitForLoad, 500);
    }
};

window.onSongPlayStateChange = onSongPlayStateChange;

function regenerateShuffleOrder() {
    if (!playerQueue || playerQueue.length === 0) {
        shuffledQueueOrder = null;
        return;
    }
    const len = playerQueue.length;
    const indices = [];
    for (let i = 0; i < len; i++) {
        indices.push(i);
    }
    
    let currentIdx = currentQueueIndex;
    if (currentIdx < 0 || currentIdx >= len) {
        currentIdx = 0;
    }
    
    const remaining = indices.filter(idx => idx !== currentIdx);
    
    // Fisher-Yates shuffle
    for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = remaining[i];
        remaining[i] = remaining[j];
        remaining[j] = temp;
    }
    
    shuffledQueueOrder = [currentIdx, ...remaining];
}

function checkShuffleOrder() {
    if (isShuffleOn) {
        if (!shuffledQueueOrder || shuffledQueueOrder.length !== playerQueue.length) {
            regenerateShuffleOrder();
        }
    } else {
        shuffledQueueOrder = null;
    }
}

function getNextTrackIndex(isManualSkip) {
    if (playerQueue.length === 0) return null;
    
    if (isShuffleOn) {
        checkShuffleOrder();
        let currentPos = shuffledQueueOrder.indexOf(currentQueueIndex);
        if (currentPos === -1) currentPos = 0;
        
        let nextPos = currentPos + 1;
        if (nextPos >= shuffledQueueOrder.length) {
            if (repeatMode === "off" && !isManualSkip) {
                return null; // Stop playback
            } else {
                nextPos = 0; // Wrap around
            }
        }
        return shuffledQueueOrder[nextPos];
    } else {
        let nextIndex = currentQueueIndex + 1;
        if (nextIndex >= playerQueue.length) {
            if (repeatMode === "off" && !isManualSkip) {
                return null; // Stop playback
            } else {
                nextIndex = 0; // Wrap around
            }
        }
        return nextIndex;
    }
}

function playNextTrack(isManualSkip = false) {
    // If inside Jam, the next track is handled by rooms queue!
    if (window.isInsideJam()) {
        if (window.getJamRole() === 'host' || window.getJamRole() === 'co-host') {
            window.sendJamSkipToNext();
        }
        return;
    }

    // Repeat Track behavior (only on natural ended, not manual skip)
    if (repeatMode === "track" && !isManualSkip) {
        audio.currentTime = 0;
        audio.play().then(() => {
            onSongPlayStateChange(true);
        }).catch(err => console.error("Replay error:", err));
        return;
    }

    let nextIndex = null;
    if (playerQueue.length > 0) {
        nextIndex = getNextTrackIndex(isManualSkip);
    }

    if (nextIndex !== null) {
        if (crossfadeDuration > 0) {
            fadeOutAndPlayNext(nextIndex);
        } else {
            currentQueueIndex = nextIndex;
            playSingleSong(playerQueue[currentQueueIndex]);
        }
    } else {
        playInfiniteNextTrack();
    }
}

async function playInfiniteNextTrack() {
    currentQueueIndex = -1;

    let nextTrack = null;
    if (infiniteQueue && infiniteQueue.length > 0) {
        nextTrack = infiniteQueue.shift();
    } else {
        if (auraMode === "lite") {
            showToast("Infinite autoplay requires Pro Mode server.");
            audio.pause();
            onSongPlayStateChange(false);
            return;
        }
        try {
            showToast("Fetching infinite recommendations... ⚡");
            const profile = {
                current_video_id: currentLoadedTrack ? currentLoadedTrack.id : "",
                session_history: playbackHistory.slice(0, 10).map(s => ({ id: s.id, artistId: s.artistId || "" })),
                global_history: playbackHistory.map(s => ({ id: s.id, artistId: s.artistId || "" })),
                skipped_tracks: skippedTracks,
                excluded_tracks: excludedFromRecommendations
            };
            const res = await fetch(`/api/recommendations?profile=${encodeURIComponent(JSON.stringify(profile))}`);
            let recommendations = await res.json();
            
            if (Array.isArray(recommendations)) {
                recommendations = recommendations.filter(track => !excludedFromRecommendations.includes(track.id));
            }

            if (recommendations && recommendations.length > 0) {
                nextTrack = recommendations[0];
                if (recommendations.length > 1) {
                    infiniteQueue = recommendations.slice(1);
                } else {
                    infiniteQueue = [];
                }
            }
        } catch (e) {
            console.error("Failed to load infinite recommendations:", e);
        }
    }

    if (nextTrack) {
        if (crossfadeDuration > 0) {
            fadeOutAndPlayNext(nextTrack);
        } else {
            playSingleSong(nextTrack, true, false, true);
        }
    } else {
        showToast("No further recommendations available.");
        audio.pause();
        onSongPlayStateChange(false);
    }
}

function fadeOutAndPlayNext(targetTrackOrIndex) {
    if (crossfadeIntervalId) {
        clearInterval(crossfadeIntervalId);
        crossfadeIntervalId = null;
        audio.volume = 0.8;
    }
    
    // Check if the track has naturally ended or is extremely close to ending
    if (audio.ended || audio.currentTime === 0 || audio.currentTime >= audio.duration - 0.5) {
        let nextTrack;
        let isInfinite = false;
        if (typeof targetTrackOrIndex === "number") {
            currentQueueIndex = targetTrackOrIndex;
            nextTrack = playerQueue[currentQueueIndex];
        } else {
            currentQueueIndex = -1;
            nextTrack = targetTrackOrIndex;
            isInfinite = true;
        }
        
        audio.volume = 0;
        playSingleSong(nextTrack, true, false, isInfinite);
        
        let fadeInterval = (crossfadeDuration * 1000) / 10;
        crossfadeIntervalId = setInterval(() => {
            if (audio.volume < 0.8) {
                audio.volume = Math.min(0.8, audio.volume + 0.1);
            } else {
                clearInterval(crossfadeIntervalId);
                crossfadeIntervalId = null;
            }
        }, fadeInterval);
        return;
    }

    let fadeInterval = (crossfadeDuration * 1000) / 10;
    crossfadeIntervalId = setInterval(() => {
        if (audio.volume > 0.1) {
            audio.volume -= 0.1;
        } else {
            clearInterval(crossfadeIntervalId);
            crossfadeIntervalId = null;
            audio.volume = 0.8; // Reset volume for next song
            
            let nextTrack;
            let isInfinite = false;
            if (typeof targetTrackOrIndex === "number") {
                currentQueueIndex = targetTrackOrIndex;
                nextTrack = playerQueue[currentQueueIndex];
            } else {
                currentQueueIndex = -1;
                nextTrack = targetTrackOrIndex;
                isInfinite = true;
            }
            playSingleSong(nextTrack, true, false, isInfinite);
        }
    }, fadeInterval);
}

function playPrevTrack() {
    // If inside Jam, the prev track is handled by room's queue!
    if (window.isInsideJam()) {
        if (window.getJamRole() === 'host' || window.getJamRole() === 'co-host') {
            window.sendJamSkipToPrev();
        }
        return;
    }
    
    if (playerQueue.length > 0 && currentQueueIndex !== -1) {
        let prevIndex;
        if (isShuffleOn) {
            checkShuffleOrder();
            let currentPos = shuffledQueueOrder.indexOf(currentQueueIndex);
            if (currentPos === -1) currentPos = 0;
            
            let prevPos = currentPos - 1;
            if (prevPos < 0) {
                prevPos = shuffledQueueOrder.length - 1;
            }
            prevIndex = shuffledQueueOrder[prevPos];
        } else {
            prevIndex = currentQueueIndex - 1;
            if (prevIndex < 0) {
                prevIndex = playerQueue.length - 1;
            }
        }
        
        currentQueueIndex = prevIndex;
        playSingleSong(playerQueue[currentQueueIndex]);
    } else {
        // Fallback to playbackHistory if explicit queue is empty or not in use
        if (playbackHistory.length > 1) {
            let historyIndex = playbackHistory.findIndex(s => s.id === (currentLoadedTrack ? currentLoadedTrack.id : ""));
            if (historyIndex === -1) historyIndex = 0;
            const prevTrack = playbackHistory[historyIndex + 1];
            if (prevTrack) {
                playSingleSong(prevTrack);
            } else {
                showToast("No previous tracks in history.");
            }
        } else {
            showToast("No previous tracks in history.");
        }
    }
}

function reverseQueueOrder() {
    if (!playerQueue || playerQueue.length === 0) return;
    
    playerQueue.reverse();
    
    // Update currentQueueIndex to match the currently-playing track
    if (currentLoadedTrack) {
        const newIndex = playerQueue.findIndex(t => t.id === currentLoadedTrack.id);
        if (newIndex !== -1) {
            currentQueueIndex = newIndex;
        }
    }
    
    // Discard/regenerate shuffle order
    if (isShuffleOn) {
        regenerateShuffleOrder();
    }
    
    // Re-render queue list UI if queue drawer is open
    const queueDrawer = document.getElementById("player-queue-drawer");
    if (queueDrawer && queueDrawer.classList.contains("drawer-open")) {
        if (typeof renderQueueDrawer === "function") {
            renderQueueDrawer();
        }
    }
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
    if (auraMode === "lite") {
        return loadSyncedLyricsLite(track);
    }
    const container = document.getElementById("lyrics-lines-container");
    container.innerHTML = `<div class="lyrics-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading lyrics...</div>`;
    
    lyricsTimeline = [];
    currentActiveLyricIndex = -1; // Reset active index
    
    try {
        const url = `/api/lyrics?video_id=${track.id}&title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}&duration=${track.durationSeconds || 0}`;
        const res = await fetch(url);
        
        // Guard against race conditions when user skips tracks rapidly
        if (currentLoadedTrack && currentLoadedTrack.id !== track.id) {
            return;
        }
        
        const data = await res.json();
        
        // Guard check again after reading json
        if (currentLoadedTrack && currentLoadedTrack.id !== track.id) {
            return;
        }
        
        lyricsTimeline = data.lyrics;
        const sourceTag = document.getElementById("lyrics-source-tag");
        if (sourceTag) {
            sourceTag.innerText = `Source: ${data.source}`;
        }
        
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
        p.className = "lyrics-line";
        p.setAttribute("data-time", line.time);
        p.setAttribute("data-index", idx);
        p.innerText = line.text;
        p.addEventListener("click", (e) => {
            e.stopPropagation();
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
    
    if (activeIndex !== -1 && activeIndex !== currentActiveLyricIndex) {
        currentActiveLyricIndex = activeIndex;
        
        const lines = document.querySelectorAll("#lyrics-lines-container .lyrics-line");
        lines.forEach(l => {
            l.classList.remove("active");
        });
        
        const activeLine = document.querySelector(`#lyrics-lines-container .lyrics-line[data-index="${activeIndex}"]`);
        if (activeLine) {
            activeLine.classList.add("active");
            
            // Auto scroll container to center the active line
            const scroller = document.getElementById("lyrics-lines-container");
            if (scroller) {
                const scrollerHeight = scroller.clientHeight;
                const lineTop = activeLine.offsetTop;
                const lineScale = activeLine.clientHeight;
                
                scroller.scrollTo({
                    top: lineTop - (scrollerHeight * 0.4) + (lineScale / 2),
                    behavior: 'smooth'
                });
            }
        }
    }
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
                playNextTrack(true);
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
    
    // Bottom-sheet gestures initialization
    setupQueueDrawerGestures();
    setupFullPlayerMinimizeGesture();
}

function setupQueueDrawerGestures() {
    const drawer = document.getElementById("player-queue-drawer");
    const handle = drawer.querySelector(".drawer-drag-handle");
    const backdrop = document.getElementById("player-drawer-backdrop");
    if (!drawer || !handle) return;

    // Handle backdrop click to close
    if (backdrop) {
        backdrop.addEventListener("click", () => {
            drawer.classList.remove("drawer-open", "drawer-expanded");
            backdrop.classList.add("hide");
        });
    }

    handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();

        handle.setPointerCapture(e.pointerId);

        const startY = e.clientY;
        const rect = drawer.getBoundingClientRect();
        const startTop = rect.top;
        const wasExpanded = drawer.classList.contains("drawer-expanded");
        let isDragging = false;

        drawer.style.transition = "none";

        const onPointerMove = (moveEvent) => {
            const deltaY = moveEvent.clientY - startY;
            
            if (!isDragging) {
                if (Math.abs(deltaY) > 8) {
                    isDragging = true;
                }
            }

            if (isDragging) {
                const newTop = startTop + deltaY;
                const clampedTop = Math.max(60, newTop);
                drawer.style.transform = `translateY(${clampedTop - 60}px)`;
            }
        };

        const onPointerUp = (upEvent) => {
            try {
                handle.releasePointerCapture(upEvent.pointerId);
            } catch (err) {}

            handle.removeEventListener("pointermove", onPointerMove);
            handle.removeEventListener("pointerup", onPointerUp);
            handle.removeEventListener("pointercancel", onPointerUp);

            if (isDragging) {
                const deltaY = upEvent.clientY - startY;
                const isMobile = window.innerWidth <= 768;
                const partialHeightPercent = isMobile ? 0.7 : 0.6;
                const partialTop = window.innerHeight - partialHeightPercent * window.innerHeight;
                
                const currentTop = startTop + deltaY;
                const clampedTop = Math.max(60, currentTop);
                
                const distToFull = Math.abs(clampedTop - 60);
                const distToPartial = Math.abs(clampedTop - partialTop);
                const distToClosed = Math.abs(clampedTop - window.innerHeight);

                const closeThreshold = 120;
                const expandThreshold = 60;

                let finalState = wasExpanded ? "full" : "partial";

                if (deltaY > closeThreshold) {
                    finalState = "closed";
                } else if (deltaY < -expandThreshold) {
                    finalState = "full";
                } else {
                    // Check proximity
                    if (distToClosed < distToPartial && distToClosed < distToFull) {
                        finalState = "closed";
                    } else if (distToFull < distToPartial) {
                        finalState = "full";
                    } else {
                        finalState = "partial";
                    }
                }

                // Apply final state classes
                drawer.style.transition = "";
                drawer.offsetHeight; // force reflow
                drawer.style.transform = "";

                if (finalState === "closed") {
                    drawer.classList.remove("drawer-open", "drawer-expanded");
                    if (backdrop) backdrop.classList.add("hide");
                } else if (finalState === "partial") {
                    drawer.classList.add("drawer-open");
                    drawer.classList.remove("drawer-expanded");
                    if (backdrop) backdrop.classList.remove("hide");
                } else {
                    drawer.classList.add("drawer-open", "drawer-expanded");
                    if (backdrop) backdrop.classList.remove("hide");
                }
            } else {
                drawer.style.transition = "";
                drawer.style.transform = "";
            }
        };

        handle.addEventListener("pointermove", onPointerMove);
        handle.addEventListener("pointerup", onPointerUp);
        handle.addEventListener("pointercancel", onPointerUp);
    });
}

function setupFullPlayerMinimizeGesture() {
    const fullPlayer = document.getElementById("full-player");
    const content = document.querySelector(".full-player-content");
    if (!fullPlayer || !content) return;

    content.addEventListener("pointerdown", (e) => {
        const target = e.target;
        
        // Exclude interactive elements
        if (target.closest("button") || 
            target.closest("input") || 
            target.closest("a") || 
            target.closest(".view-toggle-pill") ||
            target.closest("#aura-sphere-container") ||
            target.closest("#lyrics-lines-container") ||
            target.closest(".player-action-pills") ||
            target.closest(".player-seekbar-wrapper") ||
            target.closest(".player-utilities-row") ||
            target.closest(".player-drawer") ||
            target.closest(".action-sheet") ||
            target.closest(".modal-card") ||
            target.closest(".track-row") ||
            target.closest(".playback-options-dropdown")
        ) {
            return;
        }

        // Verify if it's the header area or general background space
        const isHeaderArea = target.closest(".full-player-header") && !target.closest("button");
        const isBackgroundArea = target.classList.contains("full-player-content") || 
                                 target.classList.contains("full-player-body") || 
                                 target.classList.contains("player-left-stage") || 
                                 target.classList.contains("player-right-stage") || 
                                 target.classList.contains("player-details-and-actions") || 
                                 target.classList.contains("track-metadata") || 
                                 target.id === "player-playing-from-text" ||
                                 target.id === "player-title";

        if (!isHeaderArea && !isBackgroundArea) {
            return;
        }

        // Only allow background drag down if scrolled to the top
        if (!isHeaderArea && content.scrollTop > 0) {
            return;
        }

        e.preventDefault();
        content.setPointerCapture(e.pointerId);

        const startY = e.clientY;
        const startX = e.clientX;
        let isDragging = false;

        const onPointerMove = (moveEvent) => {
            const deltaY = moveEvent.clientY - startY;
            const deltaX = moveEvent.clientX - startX;

            if (!isDragging) {
                // Drag down only
                if (deltaY > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
                    isDragging = true;
                    fullPlayer.style.transition = "none";
                }
            }

            if (isDragging) {
                const dragY = Math.max(0, deltaY);
                const scale = Math.max(0.9, 1 - (dragY / window.innerHeight) * 0.12);
                const opacity = Math.max(0.6, 1 - (dragY / window.innerHeight) * 0.4);

                fullPlayer.style.transform = `translateY(${dragY}px) scale(${scale})`;
                fullPlayer.style.opacity = opacity;
            }
        };

        const onPointerUp = (upEvent) => {
            try {
                content.releasePointerCapture(upEvent.pointerId);
            } catch (err) {}

            content.removeEventListener("pointermove", onPointerMove);
            content.removeEventListener("pointerup", onPointerUp);
            content.removeEventListener("pointercancel", onPointerUp);

            if (isDragging) {
                const deltaY = upEvent.clientY - startY;
                const threshold = Math.min(150, window.innerHeight * 0.2);

                if (deltaY > threshold) {
                    // Minimize
                    fullPlayer.style.transition = "transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease";
                    fullPlayer.offsetHeight; // trigger reflow
                    fullPlayer.style.transform = "translateY(100%) scale(0.9)";
                    fullPlayer.style.opacity = "0";
                    fullPlayer.classList.remove("player-open");

                    setTimeout(() => {
                        fullPlayer.style.transition = "";
                        fullPlayer.style.transform = "";
                        fullPlayer.style.opacity = "";
                    }, 400);
                } else {
                    // Snap back
                    fullPlayer.style.transition = "transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease";
                    fullPlayer.offsetHeight; // trigger reflow
                    fullPlayer.style.transform = "translateY(0) scale(1)";
                    fullPlayer.style.opacity = "1";

                    setTimeout(() => {
                        fullPlayer.style.transition = "";
                        fullPlayer.style.transform = "";
                        fullPlayer.style.opacity = "";
                    }, 300);
                }
            }
        };

        content.addEventListener("pointermove", onPointerMove);
        content.addEventListener("pointerup", onPointerUp);
        content.addEventListener("pointercancel", onPointerUp);
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
    
    if (auraMode === "lite") {
        showToast("Downloads require a Pro Mode server connection.");
        return;
    }
    
    // Find track details from loaded track or queue
    let track = null;
    if (currentLoadedTrack && currentLoadedTrack.id === trackId) {
        track = currentLoadedTrack;
    } else {
        // Fallback search in all global memory lists
        track = playerQueue.find(s => s.id === trackId) || 
                searchResultsCache.find(s => s.id === trackId) || 
                downloadedSongs.find(s => s.id === trackId) || 
                playbackHistory.find(s => s.id === trackId) || 
                likedSongs.find(s => s.id === trackId);
    }

    if (!track) {
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
        showToast("Listening... 🎙️");
    };
    
    recognizer.onerror = (event) => {
        console.error("Speech recognition error:", event);
        if (event && event.error === 'not-allowed') {
            showToast("Microphone permission denied. Enable microphone access in settings. 🎙️❌");
        } else {
            showToast("Voice search failed or timed out.");
        }
    };
    
    recognizer.onresult = (event) => {
        const text = event.results[0][0].transcript;
        showToast(`Heard: "${text}"`);
        
        const searchInput = document.getElementById("search-input");
        if (searchInput) {
            searchInput.value = text;
            const clearBtn = document.getElementById("clear-search-btn");
            if (clearBtn) clearBtn.style.display = "block";
        }
        
        // Open search tab if on another tab
        const searchTabBtn = document.querySelector('.nav-btn[data-tab="search"]') || document.querySelector('.mobile-tab-btn[data-tab="search"]');
        if (searchTabBtn) {
            searchTabBtn.click();
        }
        
        // Execute search
        performSearch(text, "all");
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
        playNextTrack(true);
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
    renderHiddenSongs();

    // Sleep Timer modal trigger
    document.getElementById("player-sleep-timer-btn").addEventListener("click", toggleSleepTimerOptions);
    
    // Crossfade trigger
    document.getElementById("player-crossfade-btn").addEventListener("click", configureCrossfadeSettings);

    // Playlists & Local Songs
    loadPlaylists();
    loadLocalSongs();
    
    // Upload Local Songs bindings
    const uploadBtn = document.getElementById("upload-local-btn");
    const fileInput = document.getElementById("local-file-input");
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", handleLocalFilesUpload);
    }
    
    // Playlist Modal Actions
    const createPlBtn = document.getElementById("create-playlist-btn");
    if (createPlBtn) {
        createPlBtn.addEventListener("click", () => {
            playlistTargetTrack = null;
            openCreatePlaylistModal();
        });
    }
    
    const shortcutBtn = document.getElementById("modal-create-playlist-shortcut");
    if (shortcutBtn) {
        shortcutBtn.addEventListener("click", () => {
            document.getElementById("playlist-modal").classList.add("hide");
            openCreatePlaylistModal();
        });
    }
    
    const closeCreatePlBtn = document.getElementById("close-create-playlist-btn");
    if (closeCreatePlBtn) {
        closeCreatePlBtn.addEventListener("click", () => {
            document.getElementById("create-playlist-modal").classList.add("hide");
            if (playlistTargetTrack) {
                document.getElementById("playlist-modal").classList.remove("hide");
            } else {
                document.getElementById("modal-container").classList.add("hide");
            }
        });
    }
    
    const savePlaylistSubmitBtn = document.getElementById("save-playlist-btn-submit");
    if (savePlaylistSubmitBtn) {
        savePlaylistSubmitBtn.addEventListener("click", submitCreatePlaylist);
    }
    
    const closeModalBtn = document.getElementById("close-modal-btn");
    if (closeModalBtn) {
        closeModalBtn.addEventListener("click", () => {
            document.getElementById("modal-container").classList.add("hide");
        });
    }

    // Close song credits modal
    const closeCreditsBtn = document.getElementById("close-credits-btn");
    if (closeCreditsBtn) {
        closeCreditsBtn.addEventListener("click", () => {
            document.getElementById("song-credits-modal").classList.add("hide");
            document.getElementById("modal-container").classList.add("hide");
        });
    }

    // Initialize sleep timer & crossfade modal button bindings
    initSleepTimerModal();
    initCrossfadeModal();
    
    // Universal Action Menu drawer bindings
    initActionSheetBindings();
}

function updateLikedCount() {
    document.getElementById("liked-count-text").innerText = `${likedSongs.length} song${likedSongs.length !== 1 ? 's' : ''}`;
}

function toggleLikeFromRow(e, trackId) {
    e.stopPropagation();
    
    // Defensive Lookup: Har jagah dhoondho, agar nahi mile toh user ko inform karo
    let track = playerQueue.find(s => s.id === trackId) || 
                downloadedSongs.find(s => s.id === trackId) || 
                playbackHistory.find(s => s.id === trackId) ||
                likedSongs.find(s => s.id === trackId) ||
                searchResultsCache.find(s => s.id === trackId); // Likes aur search results mein bhi check karo
    
    if (!track) {
        console.warn("Track not found in memory, attempting partial recovery...");
        // Agar track load nahi hua, toh user ko batane ke bajaye fail-safe rakho
        showToast("Could not find track details to like.");
        return;
    }
    
    const idx = likedSongs.findIndex(s => s.id === trackId);
    const isNowLiked = idx === -1;
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
    
    // Update player heart icon if currently playing this track
    if (currentLoadedTrack && currentLoadedTrack.id === trackId) {
        const likeBtn = document.getElementById("player-like-btn");
        const miniLikeBtn = document.getElementById("mini-like-btn");
        if (likeBtn) {
            if (isNowLiked) {
                likeBtn.classList.add("active");
                likeBtn.innerHTML = `<i class="fa-solid fa-heart"></i>`;
            } else {
                likeBtn.classList.remove("active");
                likeBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
            }
        }
        if (miniLikeBtn) {
            if (isNowLiked) {
                miniLikeBtn.innerHTML = `<i class="fa-solid fa-heart" style="color:var(--purple);"></i>`;
            } else {
                miniLikeBtn.innerHTML = `<i class="fa-regular fa-heart"></i>`;
            }
        }
    }
    
    // Update action sheet like item directly if currently open for this track
    const likeItem = document.querySelector('.action-item[data-action="like"]');
    if (likeItem && currentActionMenuTrack && currentActionMenuTrack.id === trackId) {
        if (isNowLiked) {
            likeItem.innerHTML = `<i class="fa-solid fa-heart" style="color:var(--purple);"></i> Remove from Liked Songs`;
        } else {
            likeItem.innerHTML = `<i class="fa-regular fa-heart"></i> Add to Liked Songs`;
        }
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
    if (!container) return;

    const visibleLiked = likedSongs.filter(track => !hiddenTracks.includes(track.id));
    if (visibleLiked.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fa-regular fa-heart"></i>
                <p>No liked songs yet. Double tap on a track to like it!</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = "";
    visibleLiked.forEach(track => {
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4>${safe(track.title)}</h4>
                <p>${safe(track.artist)}</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${safe(track.duration)}</span>
                <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(track.id)}', {type: 'none'})"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            </div>
        `;
        row.addEventListener("click", (e) => {
            if (e.target.closest('button')) return;
            if (window.isInsideJam && window.isInsideJam()) {
                showJamSelectionMenu(track);
            } else {
                playSingleSong(track);
            }
        });
        container.appendChild(row);
    });
}

function renderLibraryDownloads() {
    const container = document.getElementById("downloaded-songs-list");
    if (!container) return;
    
    const visibleDownloads = downloadedSongs.filter(track => !hiddenTracks.includes(track.id));
    if (visibleDownloads.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-down"></i><p>Offline downloads will appear here.</p></div>`;
        return;
    }
    
    container.innerHTML = "";
    visibleDownloads.forEach(track => {
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4>${safe(track.title)}</h4>
                <p>${safe(track.artist)}</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${safe(track.duration)}</span>
                <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(track.id)}', {type: 'none'})"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            </div>
        `;
        row.addEventListener("click", (e) => {
            if (e.target.closest('button')) return;
            if (window.isInsideJam && window.isInsideJam()) {
                showJamSelectionMenu(track);
            } else {
                playSingleSong(track);
            }
        });
        container.appendChild(row);
    });
}

function renderLibraryHistory() {
    const container = document.getElementById("history-songs-list");
    if (!container) return;
    
    const visibleHistory = playbackHistory.filter(track => !hiddenTracks.includes(track.id));
    if (visibleHistory.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>Listening history is empty.</p></div>`;
        return;
    }
    
    container.innerHTML = "";
    visibleHistory.forEach(track => {
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4>${safe(track.title)}</h4>
                <p>${safe(track.artist)}</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${safe(track.duration)}</span>
                <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(track.id)}', {type: 'none'})"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            </div>
        `;
        row.addEventListener("click", (e) => {
            if (e.target.closest('button')) return;
            if (window.isInsideJam && window.isInsideJam()) {
                showJamSelectionMenu(track);
            } else {
                playSingleSong(track);
            }
        });
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

const themes = [
    { name: "Midnight Black", classSuffix: "midnight", color: "#dfc15d" },
    { name: "Royal Gold", classSuffix: "royal-gold", color: "#d4af37" },
    { name: "Neon Purple", classSuffix: "neon-purple", color: "#b5179e" },
    { name: "Sapphire Blue", classSuffix: "sapphire-blue", color: "#00b4d8" },
    { name: "Emerald Green", classSuffix: "emerald-green", color: "#40916c" },
    { name: "Crimson Red", classSuffix: "crimson-red", color: "#e5383b" },
    { name: "Obsidian Rose", classSuffix: "obsidian-rose", color: "#b76e79" },
    { name: "Arctic Frost", classSuffix: "arctic-frost", color: "#a9d6e5" },
    { name: "Velvet Wine", classSuffix: "velvet-wine", color: "#ffc300" }
];

let openedFromProfile = false;

function renderThemeGrid() {
    const gridContainer = document.getElementById("theme-grid-container");
    if (!gridContainer) return;
    
    gridContainer.innerHTML = "";
    
    const currentClass = Array.from(document.body.classList).find(c => c.startsWith("theme-")) || "theme-midnight";
    
    themes.forEach(theme => {
        const isCurrentlyActive = (theme.classSuffix === "midnight" && currentClass === "theme-midnight") || 
                                  (currentClass === `theme-${theme.classSuffix}`);
        
        const card = document.createElement("div");
        card.className = `theme-swatch-card${isCurrentlyActive ? ' active' : ''}`;
        card.innerHTML = `
            <div class="theme-swatch-preview" style="background-color: ${theme.color};"></div>
            <span class="theme-swatch-name">${theme.name}</span>
            <div class="theme-swatch-active-indicator"><i class="fa-solid fa-circle-check"></i></div>
        `;
        
        card.addEventListener("click", () => {
            // Apply theme
            document.body.className = "";
            document.body.classList.add(`theme-${theme.classSuffix}`);
            
            // Re-render the grid
            renderThemeGrid();
            
            // Close modal (and go back to profile or close container)
            document.getElementById("theme-select-modal").classList.add("hide");
            if (openedFromProfile) {
                document.getElementById("profile-modal").classList.remove("hide");
            } else {
                document.getElementById("modal-container").classList.add("hide");
            }
            
            showToast(`Applied Theme: ${theme.name} ✨`);
        });
        
        gridContainer.appendChild(card);
    });
}

function initThemesSystem() {
    // Open theme selection modal from Profile modal
    const openThemeModalBtn = document.getElementById("open-theme-modal-btn");
    if (openThemeModalBtn) {
        openThemeModalBtn.addEventListener("click", () => {
            openedFromProfile = true;
            document.getElementById("profile-modal").classList.add("hide");
            document.getElementById("theme-select-modal").classList.remove("hide");
            document.getElementById("modal-container").classList.remove("hide");
            renderThemeGrid();
        });
    }
    
    // Open theme selection modal from Desktop Sidebar
    const themeToggleBtn = document.getElementById("theme-toggle-btn");
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener("click", () => {
            openedFromProfile = false;
            document.getElementById("profile-modal").classList.add("hide");
            document.getElementById("playlist-modal").classList.add("hide");
            document.getElementById("create-playlist-modal").classList.add("hide");
            document.getElementById("theme-select-modal").classList.remove("hide");
            document.getElementById("modal-container").classList.remove("hide");
            renderThemeGrid();
        });
    }
    
    // Close theme modal
    const closeThemeModalBtn = document.getElementById("close-theme-modal-btn");
    if (closeThemeModalBtn) {
        closeThemeModalBtn.addEventListener("click", () => {
            document.getElementById("theme-select-modal").classList.add("hide");
            if (openedFromProfile) {
                document.getElementById("profile-modal").classList.remove("hide");
            } else {
                document.getElementById("modal-container").classList.add("hide");
            }
        });
    }
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

function openSleepTimerModal() {
    // Hide other modals
    document.getElementById("playlist-modal").classList.add("hide");
    document.getElementById("create-playlist-modal").classList.add("hide");
    document.getElementById("profile-modal").classList.add("hide");
    document.getElementById("theme-select-modal").classList.add("hide");
    document.getElementById("song-credits-modal").classList.add("hide");
    document.getElementById("crossfade-modal").classList.add("hide");

    // Clear input
    const customInput = document.getElementById("custom-sleep-input");
    if (customInput) customInput.value = "";

    document.getElementById("sleep-timer-modal").classList.remove("hide");
    document.getElementById("modal-container").classList.remove("hide");
}

function initSleepTimerModal() {
    // Presets
    document.querySelectorAll(".btn-preset-sleep").forEach(btn => {
        btn.addEventListener("click", () => {
            const mins = parseInt(btn.getAttribute("data-minutes"));
            setSleepTimer(mins);
            document.getElementById("sleep-timer-modal").classList.add("hide");
            document.getElementById("modal-container").classList.add("hide");
        });
    });

    // Custom
    const applyBtn = document.getElementById("apply-custom-sleep");
    if (applyBtn) {
        applyBtn.addEventListener("click", () => {
            const val = document.getElementById("custom-sleep-input").value;
            const mins = parseInt(val);
            if (isNaN(mins) || mins <= 0) {
                showToast("Please enter a valid number of minutes.");
                return;
            }
            setSleepTimer(mins);
            document.getElementById("sleep-timer-modal").classList.add("hide");
            document.getElementById("modal-container").classList.add("hide");
        });
    }

    // Stop timer
    const stopBtn = document.getElementById("stop-sleep-timer");
    if (stopBtn) {
        stopBtn.addEventListener("click", () => {
            if (sleepTimerId) {
                clearTimeout(sleepTimerId);
                sleepTimerId = null;
                showToast("Sleep timer cancelled.");
            } else {
                showToast("No active sleep timer.");
            }
            document.getElementById("sleep-timer-modal").classList.add("hide");
            document.getElementById("modal-container").classList.add("hide");
        });
    }

    // Close
    const closeBtn = document.getElementById("close-sleep-timer-btn");
    if (closeBtn) {
        closeBtn.addEventListener("click", () => {
            document.getElementById("sleep-timer-modal").classList.add("hide");
            document.getElementById("modal-container").classList.add("hide");
        });
    }
}

function setSleepTimer(minutes) {
    if (sleepTimerId) {
        clearTimeout(sleepTimerId);
        sleepTimerId = null;
    }
    
    showToast(`Sleep timer set: ${minutes} minutes`);
    sleepTimerId = setTimeout(() => {
        audio.pause();
        onSongPlayStateChange(false);
        showToast("AURA Sleep Timer triggered: Playback paused.");
    }, minutes * 60 * 1000);
}

function toggleSleepTimerOptions() {
    openSleepTimerModal();
}

function openCrossfadeModal() {
    // Hide other modals
    document.getElementById("playlist-modal").classList.add("hide");
    document.getElementById("create-playlist-modal").classList.add("hide");
    document.getElementById("profile-modal").classList.add("hide");
    document.getElementById("theme-select-modal").classList.add("hide");
    document.getElementById("song-credits-modal").classList.add("hide");
    document.getElementById("sleep-timer-modal").classList.add("hide");

    // Sync slider and label
    const slider = document.getElementById("crossfade-slider");
    const valLabel = document.getElementById("crossfade-duration-val");
    if (slider) slider.value = crossfadeDuration;
    if (valLabel) valLabel.innerText = `${crossfadeDuration}s`;

    document.getElementById("crossfade-modal").classList.remove("hide");
    document.getElementById("modal-container").classList.remove("hide");
}

function initCrossfadeModal() {
    // Presets
    document.querySelectorAll(".btn-preset-crossfade").forEach(btn => {
        btn.addEventListener("click", () => {
            const sec = parseInt(btn.getAttribute("data-seconds"));
            crossfadeDuration = sec;
            
            const slider = document.getElementById("crossfade-slider");
            const valLabel = document.getElementById("crossfade-duration-val");
            if (slider) slider.value = sec;
            if (valLabel) valLabel.innerText = `${sec}s`;

            if (sec > 0) {
                showToast(`Crossfade transition set to ${sec}s`);
            } else {
                showToast("Crossfade transition disabled.");
            }
            
            document.getElementById("crossfade-modal").classList.add("hide");
            document.getElementById("modal-container").classList.add("hide");
        });
    });

    // Slider
    const slider = document.getElementById("crossfade-slider");
    if (slider) {
        slider.addEventListener("input", (e) => {
            const sec = parseInt(e.target.value);
            crossfadeDuration = sec;
            const valLabel = document.getElementById("crossfade-duration-val");
            if (valLabel) valLabel.innerText = `${sec}s`;
        });
    }

    // Done button
    const doneBtn = document.getElementById("close-crossfade-btn");
    if (doneBtn) {
        doneBtn.addEventListener("click", () => {
            if (crossfadeDuration > 0) {
                showToast(`Crossfade transition set to ${crossfadeDuration}s`);
            } else {
                showToast("Crossfade transition disabled.");
            }
            document.getElementById("crossfade-modal").classList.add("hide");
            document.getElementById("modal-container").classList.add("hide");
        });
    }
}

function configureCrossfadeSettings() {
    openCrossfadeModal();
}

// Artist & Album Pages dynamically loader inside content frame
async function loadArtistDetailPanel(channelId) {
    const fullPlayer = document.getElementById("full-player");
    if (fullPlayer && fullPlayer.classList.contains("player-open")) {
        fullPlayer.classList.remove("player-open");
    }

    const panel = document.getElementById("dynamic-view-panel");
    const content = document.getElementById("dynamic-view-content");
    
    content.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Artist profile...</div>`;
    panel.classList.remove("hide");

    try {
        const res = await fetch(`/api/artists/${channelId}`);
        const data = await res.json();
        
        // Cache popular songs in searchResultsCache
        if (data.popularSongs) {
            data.popularSongs.forEach(song => {
                song.type = "song";
                if (!searchResultsCache.some(s => s.id === song.id)) {
                    searchResultsCache.push(song);
                }
            });
        }

        let popularSongsHTML = "";
        const visibleSongs = data.popularSongs ? data.popularSongs.filter(song => !hiddenTracks.includes(song.id)) : [];
        visibleSongs.forEach(song => {
            popularSongsHTML += `
                <div class="track-row" onclick='if (event.target.closest("button")) return; playArtistSong(${JSON.stringify(song).replace(/'/g, "&#039;")})'>
                    <div class="track-row-art"><img src="${song.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
                    <div class="track-row-info">
                        <h4>${safe(song.title)}</h4>
                        <p>${safe(song.album || 'Single')}</p>
                    </div>
                    <div class="track-row-actions">
                        <span class="track-duration-badge">${safe(song.duration)}</span>
                        <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(song.id)}', {type: 'none'})"><i class="fa-solid fa-ellipsis-vertical"></i></button>
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
    if (window.isInsideJam && window.isInsideJam()) {
        showJamSelectionMenu(song);
    } else {
        playSingleSong(song);
    }
};

async function loadAlbumDetailPanel(browseId) {
    const fullPlayer = document.getElementById("full-player");
    if (fullPlayer && fullPlayer.classList.contains("player-open")) {
        fullPlayer.classList.remove("player-open");
    }

    const panel = document.getElementById("dynamic-view-panel");
    const content = document.getElementById("dynamic-view-content");
    
    content.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Album metadata...</div>`;
    panel.classList.remove("hide");

    try {
        const res = await fetch(`/api/albums/${browseId}`);
        const data = await res.json();
        
        // Cache album tracks in searchResultsCache
        if (data.tracks) {
            data.tracks.forEach(track => {
                track.thumbnail = data.thumbnail;
                track.type = "song";
                if (!searchResultsCache.some(s => s.id === track.id)) {
                    searchResultsCache.push(track);
                }
            });
        }

        let tracksHTML = "";
        const visibleTracks = data.tracks ? data.tracks.filter(track => !hiddenTracks.includes(track.id)) : [];
        visibleTracks.forEach(track => {
            // Append album artwork to track structure
            track.thumbnail = data.thumbnail;
            tracksHTML += `
                <div class="track-row" onclick='if (event.target.closest("button")) return; playAlbumSong(${JSON.stringify(track).replace(/'/g, "&#039;")})'>
                    <div style="font-size:12px; font-weight:700; color:var(--gold); width:24px; text-align:center; margin-right:10px;">${track.trackNumber}</div>
                    <div class="track-row-info">
                        <h4>${safe(track.title)}</h4>
                        <p>${safe(track.artist)}</p>
                    </div>
                    <div class="track-row-actions">
                        <span class="track-duration-badge">${safe(track.duration)}</span>
                        <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(track.id)}', {type: 'none'})"><i class="fa-solid fa-ellipsis-vertical"></i></button>
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
    if (window.isInsideJam && window.isInsideJam()) {
        showJamSelectionMenu(track);
    } else {
        playSingleSong(track);
    }
};

// 14. INIITIAL HOMEPAGE CAROUSELS DATA LOAD

async function loadHomeData() {
    const trendContainer = document.getElementById("trending-container");
    const newContainer = document.getElementById("new-releases-container");

    // 30 minute cache check karo pehle
    const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    if (auraMode === "lite") {
        return loadHomeDataLite(trendContainer, newContainer, CACHE_DURATION, now);
    }

    try {
        const cachedTrend = localStorage.getItem("aura_home_trending");
        const cachedNew = localStorage.getItem("aura_home_new");
        const cachedTime = localStorage.getItem("aura_home_cache_time");

        // Agar cache fresh hai toh seedha use karo — API call mat karo
        if (cachedTrend && cachedNew && cachedTime && (now - parseInt(cachedTime)) < CACHE_DURATION) {
            console.log("Home data loaded from cache!");
            renderHomeCards(JSON.parse(cachedTrend), trendContainer);
            renderHomeCards(JSON.parse(cachedNew), newContainer);
            return;
        }

        // Query trending
        const trendRes = await fetch("/api/search?q=trending%20global%20hits&filter=songs");
        const trendData = await trendRes.json();

        // Cache mein save karo
        localStorage.setItem("aura_home_trending", JSON.stringify(trendData));
        localStorage.setItem("aura_home_cache_time", now.toString());
        
        trendContainer.innerHTML = "";
        trendData.forEach(item => {
            const card = document.createElement("div");
            card.className = "music-card";
            card.innerHTML = `
                <div class="card-img-wrapper">
                    <img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}" loading="lazy">
                    <div class="play-hover-btn"><i class="fa-solid fa-play"></i></div>
                </div>
                <h4>${item.title}</h4>
                <p>${item.artist}</p>
            `;
            card.addEventListener("click", () => {
                if (window.isInsideJam && window.isInsideJam()) {
                    showJamSelectionMenu(item);
                } else {
                    playSingleSong(item);
                }
            });
            trendContainer.appendChild(card);
        });

        // Query new releases
        const newRes = await fetch("/api/search?q=latest%20music%20releases&filter=songs");
        const newData = await newRes.json();

        // Cache mein save karo
        localStorage.setItem("aura_home_new", JSON.stringify(newData));

        newContainer.innerHTML = "";
        newData.forEach(item => {
            const card = document.createElement("div");
            card.className = "music-card";
            card.innerHTML = `
                <div class="card-img-wrapper">
                    <img src="${item.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}" loading="lazy">
                    <div class="play-hover-btn"><i class="fa-solid fa-play"></i></div>
                </div>
                <h4>${item.title}</h4>
                <p>${item.artist}</p>
            `;
            card.addEventListener("click", () => {
                if (window.isInsideJam && window.isInsideJam()) {
                    showJamSelectionMenu(item);
                } else {
                    playSingleSong(item);
                }
            });
            newContainer.appendChild(card);
        });
        
    } catch (err) {
        console.error("Home data load error:", err);
    }
}

// Home cards render karne ka helper function
function renderHomeCards(data, container) {
    container.innerHTML = "";
    data.forEach(item => {
        const card = document.createElement("div");
        card.className = "music-card";
        card.innerHTML = `
            <div class="card-img-wrapper">
                <img src="${safe(item.thumbnail) || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}" loading="lazy">
                <div class="play-hover-btn"><i class="fa-solid fa-play"></i></div>
            </div>
            <h4>${safe(item.title)}</h4>
            <p>${safe(item.artist)}</p>
        `;
        card.addEventListener("click", () => {
            if (window.isInsideJam && window.isInsideJam()) {
                showJamSelectionMenu(item);
            } else {
                playSingleSong(item);
            }
        });
        container.appendChild(card);
    });
}

// Spark AURA Flow click
document.getElementById("start-aura-flow-btn").addEventListener("click", async () => {
    if (auraMode === "lite") {
        showToast("AURA Flow AI DJ requires a Pro Mode server connection.");
        return;
    }
    showToast("AURA Flow AI DJ suggestions triggered ⚡");
    
    try {
        // Build taste profile payload
        const profile = {
            current_video_id: currentLoadedTrack ? currentLoadedTrack.id : "",
            session_history: playbackHistory.slice(0, 10).map(s => ({ id: s.id, artistId: s.artistId || "" })),
            global_history: playbackHistory.map(s => ({ id: s.id, artistId: s.artistId || "" })),
            skipped_tracks: skippedTracks,
            excluded_tracks: excludedFromRecommendations
        };
        const res = await fetch(`/api/recommendations?profile=${encodeURIComponent(JSON.stringify(profile))}`);
        let recommendations = await res.json();
        
        // Filter out excluded tracks
        if (Array.isArray(recommendations)) {
            recommendations = recommendations.filter(track => !excludedFromRecommendations.includes(track.id));
        }
        
        if (recommendations && recommendations.length > 0) {
            if (window.isInsideJam && window.isInsideJam()) {
                const role = window.getJamRole ? window.getJamRole() : 'listener';
                if (role !== 'host' && role !== 'co-host') {
                    showToast("Only Host or Co-Host can trigger AURA Flow in Jam ⚠️");
                    return;
                }
                const firstTrack = recommendations[0];
                playSingleSong(firstTrack);
                setTimeout(() => {
                    window.sendJamPlaybackUpdate(firstTrack.id, "PLAYING", 0, firstTrack);
                }, 800);
                
                if (recommendations.length > 1) {
                    recommendations.slice(1).forEach(track => {
                        window.sendJamAddQueue(track);
                    });
                    showToast(`AURA Flow started. Queued ${recommendations.length - 1} recommendations! 🎶`);
                }
            } else {
                currentQueueIndex = -1;
                playSingleSong(recommendations[0], true, false, true);
                infiniteQueue = recommendations.slice(1);
            }
            
            // Show DJ dialog
            showToast(`AI DJ Vibe: "${recommendations[0].ai_reason}"`);
        } else {
            showToast("No recommendation options available after exclusions.");
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
            let tracks = await res.json();
            
            if (Array.isArray(tracks)) {
                tracks = tracks.filter(track => !excludedFromRecommendations.includes(track.id));
            }
            
            if (Array.isArray(tracks) && tracks.length > 0) {
                if (window.isInsideJam && window.isInsideJam()) {
                    const role = window.getJamRole ? window.getJamRole() : 'listener';
                    if (role !== 'host' && role !== 'co-host') {
                        showToast("Only Host or Co-Host can start Mood Stations in Jam ⚠️");
                        return;
                    }
                    const firstTrack = tracks[0];
                    playSingleSong(firstTrack);
                    setTimeout(() => {
                        window.sendJamPlaybackUpdate(firstTrack.id, "PLAYING", 0, firstTrack);
                    }, 800);
                    
                    if (tracks.length > 1) {
                        tracks.slice(1).forEach(track => {
                            window.sendJamAddQueue(track);
                        });
                        showToast(`Started Mood Station. Queued ${tracks.length - 1} tracks! 🎶`);
                    }
                } else {
                    currentQueueIndex = -1;
                    playSingleSong(tracks[0], true, false, true);
                    infiniteQueue = tracks.slice(1);
                }
            } else {
                showToast(`No tracks found for mood '${mood}' after exclusions.`);
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
    if (currentLoadedTrack) {
        openPlaylistChooserForTrack(currentLoadedTrack);
    } else {
        showToast("No song currently playing");
    }
}

// ==========================================================================
// PLAYLISTS, LOCAL SONGS (INDEXEDDB), AND ACTION MENU HANDLERS
// ==========================================================================

// Playlists engine
function loadPlaylists() {
    try {
        playlists = JSON.parse(localStorage.getItem("aura_my_playlists")) || [];
    } catch (e) {
        console.error("Failed to load playlists from storage:", e);
        playlists = [];
    }
    renderPlaylists();
}

function savePlaylists() {
    localStorage.setItem("aura_my_playlists", JSON.stringify(playlists));
    renderPlaylists();
}

function renderPlaylists() {
    const container = document.getElementById("playlists-container");
    if (!container) return;
    
    container.innerHTML = `
        <div class="playlist-card Liked-playlist" id="liked-playlist-card">
            <div class="playlist-cover liked-cover">
                <i class="fa-solid fa-heart"></i>
            </div>
            <div class="playlist-info">
                <h4>Liked Songs</h4>
                <p id="liked-count-text">${likedSongs.length} song${likedSongs.length !== 1 ? 's' : ''}</p>
            </div>
        </div>
    `;
    
    const likedCard = document.getElementById("liked-playlist-card");
    if (likedCard) {
        likedCard.addEventListener("click", () => {
            const likedTabBtn = document.querySelector('.lib-tab-btn[data-lib="liked"]');
            if (likedTabBtn) likedTabBtn.click();
        });
    }
    
    playlists.forEach(pl => {
        const card = document.createElement("div");
        card.className = "playlist-card";
        card.innerHTML = `
            <div class="playlist-cover" style="background: linear-gradient(135deg, var(--purple) 0%, var(--blue) 100%); color: #fff; font-size: 32px; display: flex; align-items: center; justify-content: center;">
                <i class="fa-solid fa-music"></i>
            </div>
            <div class="playlist-info">
                <h4>${safe(pl.name)}</h4>
                <p>${pl.tracks.length} song${pl.tracks.length !== 1 ? 's' : ''}</p>
            </div>
        `;
        card.addEventListener("click", () => {
            loadPlaylistDetailPanel(pl);
        });
        container.appendChild(card);
    });
}

function loadPlaylistDetailPanel(pl) {
    window.currentPlaylistDetailId = pl.id;
    const panel = document.getElementById("dynamic-view-panel");
    const content = document.getElementById("dynamic-view-content");
    if (!panel || !content) return;
    
    panel.classList.remove("hide");
    
    let tracksHTML = "";
    const visiblePlaylistTracks = pl.tracks ? pl.tracks.filter(track => !hiddenTracks.includes(track.id)) : [];
    if (visiblePlaylistTracks.length === 0) {
        tracksHTML = `<div class="empty-state"><p>No songs in this playlist yet. Add songs from Search using 3-dot menu.</p></div>`;
    } else {
        visiblePlaylistTracks.forEach((track) => {
            const originalIndex = pl.tracks.indexOf(track);
            tracksHTML += `
                <div class="track-row" onclick="if (event.target.closest('button')) return; playPlaylistTrack('${pl.id}', ${originalIndex})">
                    <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
                    <div class="track-row-info">
                        <h4>${safe(track.title)}</h4>
                        <p>${safe(track.artist)}</p>
                    </div>
                    <div class="track-row-actions">
                        <span class="track-duration-badge">${safe(track.duration)}</span>
                        <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(track.id)}', {type: 'playlist', playlistId: '${safe(pl.id)}'})">
                            <i class="fa-solid fa-ellipsis-vertical"></i>
                        </button>
                    </div>
                </div>
            `;
        });
    }
    
    const insideJam = window.isInsideJam && window.isInsideJam();
    
    content.innerHTML = `
        <div style="display:flex; gap:30px; align-items:center; margin-bottom:30px; flex-wrap:wrap;">
            <div style="width:140px; height:140px; border-radius:18px; background: linear-gradient(135deg, var(--purple) 0%, var(--blue) 100%); display:flex; align-items:center; justify-content:center; font-size:64px; color:#fff;">
                <i class="fa-solid fa-compact-disc"></i>
            </div>
            <div>
                <h2 style="font-size:28px; font-family:var(--font-header); font-weight:800;">${safe(pl.name)}</h2>
                <p style="font-size:14px; color:var(--gold); font-weight:600; margin-top:4px;">Custom Playlist</p>
                <p style="font-size:12px; color:var(--text-secondary); margin-top:2px;">${pl.tracks.length} tracks</p>
                <div style="display:flex; gap:10px; margin-top:15px; flex-wrap:wrap;">
                    <button class="btn btn-gold btn-sm" onclick="playPlaylist('${pl.id}')" ${pl.tracks.length === 0 ? 'disabled' : ''}>
                        <i class="fa-solid fa-play"></i> Play All
                    </button>
                    ${insideJam ? `
                    <button class="btn btn-purple btn-sm" onclick="bulkAddPlaylistToJam('${pl.id}')" ${pl.tracks.length === 0 ? 'disabled' : ''}>
                        <i class="fa-solid fa-list-ol"></i> Add to Jam Queue
                    </button>
                    ` : ''}
                    <button class="btn btn-red btn-sm" onclick="deletePlaylist('${pl.id}')">
                        <i class="fa-solid fa-trash"></i> Delete Playlist
                    </button>
                </div>
            </div>
        </div>
        
        <h3 style="font-size:18px; margin-bottom:15px; font-family:var(--font-header);">Songs</h3>
        <div class="results-list">${tracksHTML}</div>
    `;
}

window.playPlaylistTrack = (playlistId, index) => {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl || pl.tracks.length === 0) return;
    if (window.isInsideJam && window.isInsideJam()) {
        showJamSelectionMenu(pl.tracks[index]);
    } else {
        playerQueue = [...pl.tracks];
        currentQueueIndex = index;
        playSingleSong(pl.tracks[index]);
    }
};

window.bulkAddPlaylistToJam = (playlistId) => {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl || !pl.tracks || pl.tracks.length === 0) return;
    
    let addedCount = 0;
    let localCount = 0;
    pl.tracks.forEach(track => {
        if (track && track.id && String(track.id).startsWith("local_")) {
            localCount++;
        } else {
            window.sendJamAddQueue(track);
            addedCount++;
        }
    });
    
    if (localCount > 0) {
        showToast(`Added ${addedCount} tracks. Skipped ${localCount} local files ⚠️`);
    } else {
        showToast(`Added ${addedCount} tracks to Jam Queue! 🎶`);
    }
};

window.playPlaylist = (playlistId) => {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl || pl.tracks.length === 0) return;
    
    if (window.isInsideJam && window.isInsideJam()) {
        const role = window.getJamRole ? window.getJamRole() : 'listener';
        if (role !== 'host' && role !== 'co-host') {
            showToast("Only Host or Co-Host can change songs in Jam ⚠️");
            return;
        }
        
        // Play the first track and broadcast it
        const firstTrack = pl.tracks[0];
        if (firstTrack.id && String(firstTrack.id).startsWith("local_")) {
            showToast("Local files cannot be shared in a Jam session ⚠️");
            return;
        }
        
        playSingleSong(firstTrack);
        setTimeout(() => {
            window.sendJamPlaybackUpdate(firstTrack.id, "PLAYING", 0, firstTrack);
        }, 800);
        
        // Add the rest of the tracks to the queue
        if (pl.tracks.length > 1) {
            let addedCount = 0;
            let localCount = 0;
            pl.tracks.slice(1).forEach(track => {
                if (track && track.id && String(track.id).startsWith("local_")) {
                    localCount++;
                } else {
                    window.sendJamAddQueue(track);
                    addedCount++;
                }
            });
            if (localCount > 0) {
                showToast(`Playing first track. Queued ${addedCount} tracks, skipped ${localCount} local files ⚠️`);
            } else {
                showToast(`Playing first track. Queued remaining ${addedCount} tracks! 🎶`);
            }
        }
    } else {
        playerQueue = [...pl.tracks];
        currentQueueIndex = 0;
        playSingleSong(pl.tracks[0]);
    }
};

window.deletePlaylist = (playlistId) => {
    if (confirm("Are you sure you want to delete this playlist?")) {
        playlists = playlists.filter(p => p.id !== playlistId);
        savePlaylists();
        document.getElementById("dynamic-view-panel").classList.add("hide");
        showToast("Playlist deleted");
    }
};

// Local files engine
function loadLocalSongs() {
    // Stored metas inside localStorage, actual binary inside IndexedDB
    try {
        localSongs = JSON.parse(localStorage.getItem("aura_local_songs")) || [];
    } catch (e) {
        console.error("Failed to load local songs meta:", e);
        localSongs = [];
    }
    renderLocalSongs();
}

function saveLocalSongs() {
    localStorage.setItem("aura_local_songs", JSON.stringify(localSongs));
    renderLocalSongs();
}

function renderLocalSongs() {
    const container = document.getElementById("local-songs-list");
    if (!container) return;
    
    const visibleLocal = localSongs.filter(track => !hiddenTracks.includes(track.id));
    if (visibleLocal.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-file-audio"></i>
                <p>No local files uploaded yet. Add audio files from your device!</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = "";
    visibleLocal.forEach(track => {
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art">
                <img src="${track.thumbnail || 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=100&q=80'}">
            </div>
            <div class="track-row-info">
                <h4>${safe(track.title)}</h4>
                <p>${safe(track.artist)} • Local File</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${safe(track.duration)}</span>
                <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(track.id)}', {type: 'none'})">
                    <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
            </div>
        `;
        
        row.addEventListener("click", (e) => {
            if (e.target.closest('.track-menu-btn')) return;
            if (window.isInsideJam && window.isInsideJam()) {
                showJamSelectionMenu(track);
            } else {
                playSingleSong(track);
            }
        });
        
        container.appendChild(row);
    });
}

// Metadata tag parser & IndexedDB loader
async function handleLocalFilesUpload(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    showToast(`Parsing tags for ${files.length} song(s)... 🎙️`);
    let addedCount = 0;
    
    let parseBlob = null;
    try {
        const musicMetadata = await import('https://cdn.jsdelivr.net/npm/music-metadata@11.12.1/+esm');
        parseBlob = musicMetadata.parseBlob;
    } catch (err) {
        console.error("Failed to load music-metadata via ESM, using fallback name parser:", err);
    }
    
    for (const file of files) {
        let title = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
        let artist = "Unknown Artist";
        let album = "Local Upload";
        let thumbnail = "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=100&q=80";
        
        if (parseBlob) {
            try {
                const metadata = await parseBlob(file);
                if (metadata.common.title) title = metadata.common.title;
                if (metadata.common.artist) artist = metadata.common.artist;
                if (metadata.common.album) album = metadata.common.album;
                
                if (metadata.common.picture && metadata.common.picture.length > 0) {
                    const pic = metadata.common.picture[0];
                    const artworkBlob = new Blob([pic.data], { type: pic.format });
                    thumbnail = URL.createObjectURL(artworkBlob);
                }
            } catch (metadataErr) {
                console.warn("Failed to parse metadata tags for " + file.name + ", using filename parsing:", metadataErr);
                if (title.includes(" - ")) {
                    const parts = title.split(" - ");
                    artist = parts[0].trim();
                    title = parts[1].trim();
                }
            }
        } else {
            if (title.includes(" - ")) {
                const parts = title.split(" - ");
                artist = parts[0].trim();
                title = parts[1].trim();
            }
        }
        
        const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        const songMeta = {
            id: localId,
            title: title,
            artist: artist,
            album: album,
            thumbnail: thumbnail,
            duration: "Local",
            isLocal: true
        };
        
        try {
            await saveLocalSongToDB(songMeta, file);
            localSongs.push(songMeta);
            addedCount++;
        } catch (dbErr) {
            console.error("Failed to store file in IndexedDB:", dbErr);
        }
    }
    
    if (addedCount > 0) {
        saveLocalSongs();
        showToast(`Stored ${addedCount} song(s) locally in IndexedDB! 🎵`);
    } else {
        showToast("No files could be stored.");
    }
    e.target.value = "";
}

// Track Finder robust fallback
function findTrackById(trackId) {
    let track = playerQueue.find(s => s.id === trackId) || 
                (typeof infiniteQueue !== 'undefined' && infiniteQueue.find(s => s.id === trackId)) ||
                searchResultsCache.find(s => s.id === trackId) || 
                downloadedSongs.find(s => s.id === trackId) || 
                likedSongs.find(s => s.id === trackId) ||
                localSongs.find(s => s.id === trackId) ||
                playbackHistory.find(s => s.id === trackId);
                
    if (!track && playlists) {
        for (const pl of playlists) {
            const t = pl.tracks.find(s => s.id === trackId);
            if (t) {
                track = t;
                break;
            }
        }
    }
    if (!track && window.getJamQueue) {
        const jq = window.getJamQueue();
        const t = jq.find(s => s.id === trackId);
        if (t) track = t;
    }
    // Fallback: check currently loaded track directly
    if (!track && currentLoadedTrack && currentLoadedTrack.id === trackId) {
        track = currentLoadedTrack;
    }
    return track;
}

// Action sheet drawer launchers
function openTrackActionMenu(event, trackId, context = {type: 'none'}) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const track = findTrackById(trackId);
    if (!track) {
        showToast("Error locating song details.");
        return;
    }
    
    currentActionMenuTrack = track;
    currentActionMenuContext = context;
    
    const art = document.getElementById("action-sheet-art");
    if (art) art.src = track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80';
    
    const title = document.getElementById("action-sheet-title");
    if (title) title.innerText = track.title;
    
    const artist = document.getElementById("action-sheet-artist");
    if (artist) artist.innerText = track.artist;
    
    const isLiked = likedSongs.some(s => s.id === track.id);
    const likeItem = document.querySelector('.action-item[data-action="like"]');
    if (likeItem) {
        if (isLiked) {
            likeItem.innerHTML = `<i class="fa-solid fa-heart" style="color:var(--purple);"></i> Remove from Liked Songs`;
        } else {
            likeItem.innerHTML = `<i class="fa-regular fa-heart"></i> Add to Liked Songs`;
        }
    }
    
    const removeBtn = document.getElementById("action-item-remove");
    if (removeBtn) {
        if (context && context.type === "playlist") {
            removeBtn.classList.remove("hide");
            removeBtn.innerHTML = `<i class="fa-solid fa-trash"></i> Remove from Playlist`;
        } else if (context && (context.type === "queue" || context.type === "jam_queue")) {
            removeBtn.classList.remove("hide");
            removeBtn.innerHTML = `<i class="fa-solid fa-trash"></i> Remove from Queue`;
        } else {
            removeBtn.classList.add("hide");
        }
    }
    
    const overlay = document.getElementById("action-sheet-overlay");
    if (overlay) {
        overlay.classList.remove("hide");
        overlay.offsetHeight;
        overlay.classList.add("active");
    }
}

function initActionSheetBindings() {
    const overlay = document.getElementById("action-sheet-overlay");
    const closeBtn = document.getElementById("close-action-sheet-btn");
    
    if (overlay) {
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) {
                closeActionSheet(true);
            }
        });
    }
    
    if (closeBtn) {
        closeBtn.addEventListener("click", () => closeActionSheet(true));
    }
    
    const actionItems = document.querySelectorAll(".action-item");
    actionItems.forEach(item => {
        item.addEventListener("click", () => {
            const action = item.getAttribute("data-action");
            handleActionSheetAction(action);
            closeActionSheet(true);
        });
    });
}

function openCreatePlaylistModal() {
    const modalContainer = document.getElementById("modal-container");
    const playlistModal = document.getElementById("playlist-modal");
    const profileModal = document.getElementById("profile-modal");
    const createPlaylistModal = document.getElementById("create-playlist-modal");
    
    if (playlistModal) playlistModal.classList.add("hide");
    if (profileModal) profileModal.classList.add("hide");
    if (createPlaylistModal) createPlaylistModal.classList.remove("hide");
    if (modalContainer) modalContainer.classList.remove("hide");
    
    const nameInput = document.getElementById("playlist-name-input");
    if (nameInput) {
        nameInput.value = "";
        nameInput.focus();
    }
}

function submitCreatePlaylist() {
    const nameInput = document.getElementById("playlist-name-input");
    const name = nameInput ? nameInput.value.trim() : "";
    if (!name) {
        showToast("Playlist name cannot be empty.");
        return;
    }
    
    const newPlaylist = {
        id: "pl_" + Date.now(),
        name: name,
        tracks: []
    };
    
    playlists.push(newPlaylist);
    savePlaylists();
    
    const createPlaylistModal = document.getElementById("create-playlist-modal");
    if (createPlaylistModal) createPlaylistModal.classList.add("hide");
    
    if (playlistTargetTrack) {
        toggleTrackInPlaylist(newPlaylist.id, playlistTargetTrack, true);
        playlistTargetTrack = null;
        document.getElementById("modal-container").classList.add("hide");
    } else {
        document.getElementById("modal-container").classList.add("hide");
        showToast(`Created playlist "${name}"`);
    }
}

function closeActionSheet(immediate = false) {
    const overlay = document.getElementById("action-sheet-overlay");
    if (overlay) {
        overlay.classList.remove("active");
        if (immediate) {
            overlay.classList.add("hide");
        } else {
            setTimeout(() => {
                overlay.classList.add("hide");
            }, 300);
        }
    }
}

async function handleActionSheetAction(action) {
    const track = currentActionMenuTrack;
    if (!track) return;
    
    switch (action) {
        case "share":
            const shareUrl = `${window.location.origin}/?playTitle=${encodeURIComponent(track.title)}&playArtist=${encodeURIComponent(track.artist)}&playId=${track.id}&playThumb=${encodeURIComponent(track.thumbnail || '')}&playDuration=${encodeURIComponent(track.duration || '')}`;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(shareUrl).then(() => {
                    showToast("Song link copied to clipboard! 🔗");
                }).catch(() => {
                    showToast("Failed to copy link.");
                });
            } else {
                showToast(`Song Link: ${shareUrl}`);
            }
            break;
            
        case "like":
            const fakeEvent = { stopPropagation: () => {} };
            toggleLikeFromRow(fakeEvent, track.id);
            break;
            
        case "playlist":
            openPlaylistChooserForTrack(track);
            break;
            
        case "hide":
            hiddenTracks.push(track.id);
            showToast(`"${track.title}" hidden in this session.`);
            const resultsView = document.getElementById("search-results-view");
            if (resultsView && !resultsView.classList.contains("hide") && searchResultsCache) {
                renderSearchResults(searchResultsCache);
            }
            renderPlaylists();
            renderLibraryLiked();
            renderLibraryDownloads();
            renderLibraryHistory();
            renderLocalSongs();
            renderQueueDrawer();
            renderHiddenSongs();
            break;
            
        case "queue_add":
            if (!playerQueue.some(t => t.id === track.id)) {
                playerQueue.push(track);
                showToast(`Added "${track.title}" to Queue ⏭️`);
                renderQueueDrawer();
            } else {
                showToast(`"${track.title}" is already in Queue.`);
            }
            break;
            
        case "queue_go":
            document.getElementById("full-player").classList.add("player-open");
            document.getElementById("player-queue-drawer").classList.add("drawer-open");
            const backdrop = document.getElementById("player-drawer-backdrop");
            if (backdrop) backdrop.classList.remove("hide");
            renderQueueDrawer();
            break;
            
        case "album": {
            const fullPlAlbum = document.getElementById("full-player");
            if (fullPlAlbum && fullPlAlbum.classList.contains("player-open")) {
                fullPlAlbum.classList.remove("player-open");
            }
            if (track.albumId) {
                loadAlbumDetailPanel(track.albumId);
            } else {
                const query = track.album || track.title + " album";
                document.getElementById("search-input").value = query;
                performSearch(query, "albums");
                const tabBtn = document.querySelector('.nav-btn[data-tab="search"]') || document.querySelector('.mobile-tab-btn[data-tab="search"]');
                if (tabBtn) tabBtn.click();
                showToast(`Searching for album: ${query}`);
            }
            break;
        }
            
        case "artist": {
            const fullPlArtist = document.getElementById("full-player");
            if (fullPlArtist && fullPlArtist.classList.contains("player-open")) {
                fullPlArtist.classList.remove("player-open");
            }
            if (track.artistId) {
                loadArtistDetailPanel(track.artistId);
            } else {
                const query = track.artist;
                document.getElementById("search-input").value = query;
                performSearch(query, "artists");
                const tabBtn = document.querySelector('.nav-btn[data-tab="search"]') || document.querySelector('.mobile-tab-btn[data-tab="search"]');
                if (tabBtn) tabBtn.click();
                showToast(`Searching for artist: ${query}`);
            }
            break;
        }
            
        case "jam":
            if (auraMode === "lite") {
                showToast("AURA JAM requires a Pro Mode server connection.");
                return;
            }
            if (window.isInsideJam && window.isInsideJam()) {
                const role = window.getJamRole ? window.getJamRole() : 'listener';
                const addOnlyMode = window.getJamAddOnlyMode && window.getJamAddOnlyMode();
                const canAdd = (role === 'host' || role === 'co-host' || role === 'moderator' || role === 'contributor' || addOnlyMode);
                if (canAdd) {
                    showJamSelectionMenu(track);
                } else {
                    showToast("🎵 You do not have permission to add songs in this Jam");
                }
            } else {
                const jamTabBtn = document.querySelector('.nav-btn[data-tab="jam"]') || document.querySelector('.mobile-tab-btn[data-tab="jam"]');
                if (jamTabBtn) jamTabBtn.click();
                showToast("Configure your AURA JAM room to sync play!");
            }
            break;
            
        case "taste":
            if (track && !excludedFromRecommendations.includes(track.id)) {
                excludedFromRecommendations.push(track.id);
                saveStateToStorage("aura_excluded_taste", excludedFromRecommendations);
            }
            showToast(`Excluded "${track.title}" from future recommendations.`);
            break;
            
        case "radio":
            if (auraMode === "lite") {
                showToast("Song Radio requires a Pro Mode server connection.");
                return;
            }
            showToast(`Starting song radio for "${track.title}"... ⚡`);
            try {
                const res = await fetch(`/api/recommendations?video_id=${track.id}`);
                let recommendations = await res.json();
                
                if (Array.isArray(recommendations)) {
                    recommendations = recommendations.filter(t => !excludedFromRecommendations.includes(t.id));
                }
                
                if (recommendations && recommendations.length > 0) {
                    currentQueueIndex = -1;
                    playSingleSong(recommendations[0], true, false, true);
                    infiniteQueue = recommendations.slice(1);
                } else {
                    showToast("No recommendations available for radio after exclusions.");
                }
            } catch (e) {
                console.error("Radio start failed:", e);
                showToast("Failed to start song radio.");
            }
            break;
            
        case "credits":
            // Populate credits modal details
            document.getElementById("credits-title").innerText = track.title;
            document.getElementById("credits-artist").innerText = track.artist;
            document.getElementById("credits-album").innerText = track.album || 'Single';
            
            // Hide other modals and display credits modal
            document.getElementById("playlist-modal").classList.add("hide");
            document.getElementById("create-playlist-modal").classList.add("hide");
            document.getElementById("profile-modal").classList.add("hide");
            document.getElementById("theme-select-modal").classList.add("hide");
            document.getElementById("sleep-timer-modal").classList.add("hide");
            document.getElementById("crossfade-modal").classList.add("hide");
            
            document.getElementById("song-credits-modal").classList.remove("hide");
            document.getElementById("modal-container").classList.remove("hide");
            break;
            
        case "remove_context":
            if (currentActionMenuContext) {
                if (currentActionMenuContext.type === "playlist") {
                    toggleTrackInPlaylist(currentActionMenuContext.playlistId, track, false);
                    
                    const activePlaylistPanel = document.getElementById("dynamic-view-panel");
                    if (activePlaylistPanel && !activePlaylistPanel.classList.contains("hide")) {
                        const pl = playlists.find(p => p.id === currentActionMenuContext.playlistId);
                        if (pl) {
                            loadPlaylistDetailPanel(pl);
                        }
                    }
                    renderPlaylists();
                } else if (currentActionMenuContext.type === "queue") {
                    const removedIndex = playerQueue.findIndex(t => t.id === track.id);
                    playerQueue = playerQueue.filter(t => t.id !== track.id);
                    shuffledQueueOrder = null;
                    
                    if (currentLoadedTrack) {
                        if (track.id === currentLoadedTrack.id) {
                            if (playerQueue.length > 0) {
                                currentQueueIndex = Math.min(removedIndex, playerQueue.length - 1);
                            } else {
                                currentQueueIndex = -1;
                            }
                        } else {
                            currentQueueIndex = playerQueue.findIndex(t => t.id === currentLoadedTrack.id);
                        }
                    } else {
                        currentQueueIndex = -1;
                    }
                    
                    showToast(`Removed "${track.title}" from queue 🗑️`);
                    renderQueueDrawer();
                } else if (currentActionMenuContext.type === "jam_queue") {
                    if (window.isInsideJam && window.isInsideJam()) {
                        if (window.sendJamRemoveQueue) {
                            window.sendJamRemoveQueue(track.id);
                        }
                    }
                }
            }
            break;
    }
}

function openPlaylistChooserForTrack(track) {
    playlistTargetTrack = track;
    
    const modalContainer = document.getElementById("modal-container");
    const playlistModal = document.getElementById("playlist-modal");
    const profileModal = document.getElementById("profile-modal");
    const createPlaylistModal = document.getElementById("create-playlist-modal");
    
    if (profileModal) profileModal.classList.add("hide");
    if (createPlaylistModal) createPlaylistModal.classList.add("hide");
    playlistModal.classList.remove("hide");
    modalContainer.classList.remove("hide");
    
    const listContainer = document.getElementById("playlist-modal-list");
    if (!listContainer) return;
    
    if (playlists.length === 0) {
        listContainer.innerHTML = `<p style="font-size:12px; color:var(--text-secondary); text-align:center; padding:10px 0;">No playlists created yet.</p>`;
        return;
    }
    
    listContainer.innerHTML = "";
    playlists.forEach(pl => {
        const hasTrack = pl.tracks.some(t => t.id === track.id);
        const item = document.createElement("div");
        item.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:10px; background:rgba(255,255,255,0.02); border-radius:8px; cursor:pointer;";
        item.innerHTML = `
            <span style="font-size:14px; font-weight:600;">${safe(pl.name)}</span>
            <input type="checkbox" ${hasTrack ? 'checked' : ''} style="accent-color:var(--gold); width:18px; height:18px;">
        `;
        item.addEventListener("click", (e) => {
            const checkbox = item.querySelector('input');
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
            }
            toggleTrackInPlaylist(pl.id, track, checkbox.checked);
        });
        listContainer.appendChild(item);
    });
}

function toggleTrackInPlaylist(playlistId, track, shouldAdd) {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    
    if (shouldAdd) {
        if (!pl.tracks.some(t => t.id === track.id)) {
            pl.tracks.push(track);
            showToast(`Added to "${pl.name}"`);
        }
    } else {
        pl.tracks = pl.tracks.filter(t => t.id !== track.id);
        showToast(`Removed from "${pl.name}"`);
    }
    savePlaylists();
    if (window.currentPlaylistDetailId === playlistId) {
        const activePlaylistPanel = document.getElementById("dynamic-view-panel");
        if (activePlaylistPanel && !activePlaylistPanel.classList.contains("hide")) {
            loadPlaylistDetailPanel(pl);
        }
    }
}

function renderQueueDrawer() {
    const container = document.getElementById("player-queue-list-container");
    if (!container) return;
    const visibleQueue = playerQueue.filter(track => !hiddenTracks.includes(track.id));
    if (visibleQueue.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>Queue is empty</p></div>`;
        return;
    }
    container.innerHTML = "";
    visibleQueue.forEach((track) => {
        const isActive = currentLoadedTrack && track.id === currentLoadedTrack.id;
        const row = document.createElement("div");
        row.className = `track-row ${isActive ? 'active-track' : ''}`;
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4 style="${isActive ? 'color: var(--gold);' : ''}">${safe(track.title)}</h4>
                <p>${safe(track.artist)}</p>
            </div>
            <div class="track-row-actions">
                <span class="track-duration-badge">${safe(track.duration)}</span>
                <button class="track-menu-btn" onclick="openTrackActionMenu(event, '${safe(track.id)}', {type: 'queue'})">
                    <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
                <button class="track-drag-handle" onclick="event.stopPropagation();" title="Drag to reorder">
                    <i class="fa-solid fa-grip-lines"></i>
                </button>
            </div>
        `;
        row.addEventListener("click", (e) => {
            if (e.target.closest('.track-menu-btn') || e.target.closest('.track-drag-handle')) return;
            if (window.isDraggingQueue) return;
            const originalIndex = playerQueue.findIndex(t => t.id === track.id);
            if (originalIndex !== -1) {
                currentQueueIndex = originalIndex;
            }
            playSingleSong(track);
        });

        // Add Pointer Drag-and-Drop functionality
        const dragHandle = row.querySelector('.track-drag-handle');
        if (dragHandle) {
            // Prevent browser touch scroll behavior on mobile touch down
            dragHandle.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
            
            dragHandle.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const activeRow = row;
                const activeIndex = Array.from(container.querySelectorAll('.track-row')).indexOf(activeRow);
                if (activeIndex === -1) return;
                
                dragHandle.setPointerCapture(e.pointerId);
                
                let startY = e.clientY;
                let isDragging = false;
                let hoverIndex = activeIndex;
                
                const rows = Array.from(container.querySelectorAll('.track-row'));
                const rowHeight = activeRow.offsetHeight;
                const gap = 8; // from .drawer-body CSS gap
                const shiftDistance = rowHeight + gap;
                
                // Pre-calculate middle coordinates of all rows
                const rowMidpoints = rows.map(r => {
                    const rect = r.getBoundingClientRect();
                    return rect.top + rect.height / 2;
                });
                
                const onPointerMove = (moveEvent) => {
                    const deltaY = moveEvent.clientY - startY;
                    
                    if (!isDragging) {
                        if (Math.abs(deltaY) > 8) {
                            isDragging = true;
                            container.classList.add("queue-dragging-active");
                            activeRow.classList.add("row-dragging");
                        }
                    }
                    
                    if (isDragging) {
                        activeRow.style.transform = `translateY(${deltaY}px)`;
                        
                        const currentMidpoint = rowMidpoints[activeIndex] + deltaY;
                        let newHoverIndex = activeIndex;
                        
                        for (let i = 0; i < rows.length; i++) {
                            if (i === activeIndex) continue;
                            const siblingMidpoint = rowMidpoints[i];
                            if (deltaY > 0) { // Dragging down
                                if (i > activeIndex && currentMidpoint > siblingMidpoint) {
                                    newHoverIndex = Math.max(newHoverIndex, i);
                                }
                            } else if (deltaY < 0) { // Dragging up
                                if (i < activeIndex && currentMidpoint < siblingMidpoint) {
                                    newHoverIndex = Math.min(newHoverIndex, i);
                                }
                            }
                        }
                        
                        if (newHoverIndex !== hoverIndex) {
                            hoverIndex = newHoverIndex;
                            
                            rows.forEach((sibling, i) => {
                                if (i === activeIndex) return;
                                
                                let translation = 0;
                                if (activeIndex < hoverIndex) {
                                    if (i > activeIndex && i <= hoverIndex) {
                                        translation = -shiftDistance;
                                    }
                                } else if (activeIndex > hoverIndex) {
                                    if (i < activeIndex && i >= hoverIndex) {
                                        translation = shiftDistance;
                                    }
                                }
                                sibling.style.transform = translation ? `translateY(${translation}px)` : '';
                            });
                        }
                    }
                };
                
                const onPointerUp = (upEvent) => {
                    try {
                        dragHandle.releasePointerCapture(upEvent.pointerId);
                    } catch (err) {}
                    
                    dragHandle.removeEventListener('pointermove', onPointerMove);
                    dragHandle.removeEventListener('pointerup', onPointerUp);
                    dragHandle.removeEventListener('pointercancel', onPointerUp);
                    
                    if (isDragging) {
                        window.isDraggingQueue = true;
                        setTimeout(() => {
                            window.isDraggingQueue = false;
                        }, 50);
                        
                        container.classList.remove("queue-dragging-active");
                        activeRow.classList.remove("row-dragging");
                        
                        rows.forEach(r => r.style.transform = '');
                        
                        if (hoverIndex !== activeIndex) {
                            const visibleQueue = playerQueue.filter(track => !hiddenTracks.includes(track.id));
                            const activeTrack = visibleQueue[activeIndex];
                            const hoverTrack = visibleQueue[hoverIndex];
                            
                            if (activeTrack && hoverTrack) {
                                const originalActiveIndex = playerQueue.findIndex(t => t.id === activeTrack.id);
                                const originalHoverIndex = playerQueue.findIndex(t => t.id === hoverTrack.id);
                                
                                if (originalActiveIndex !== -1 && originalHoverIndex !== -1) {
                                    const [removed] = playerQueue.splice(originalActiveIndex, 1);
                                    playerQueue.splice(originalHoverIndex, 0, removed);
                                    
                                    // Invalidate shuffle order
                                    shuffledQueueOrder = null;
                                    
                                    // Recalculate currentQueueIndex to align with playing track
                                    if (currentLoadedTrack) {
                                        currentQueueIndex = playerQueue.findIndex(t => t.id === currentLoadedTrack.id);
                                    }
                                }
                            }
                        }
                        
                        renderQueueDrawer();
                    }
                };
                
                dragHandle.addEventListener('pointermove', onPointerMove);
                dragHandle.addEventListener('pointerup', onPointerUp);
                dragHandle.addEventListener('pointercancel', onPointerUp);
            });
        }

        container.appendChild(row);
    });
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

function showPlaybackOptionsDropdown(triggerEl) {
    const dropdown = document.getElementById("playback-options-dropdown");
    if (!dropdown) return;
    
    // Toggle if clicking the same trigger and dropdown is already open
    if (!dropdown.classList.contains("hide") && dropdown.dataset.trigger === triggerEl.id) {
        hidePlaybackOptionsDropdown();
        return;
    }
    
    dropdown.dataset.trigger = triggerEl.id;
    dropdown.classList.remove("hide");
    
    // Get positioning after removing hide so offsetWidth/Height are non-zero
    const rect = triggerEl.getBoundingClientRect();
    const parentRect = triggerEl.offsetParent.getBoundingClientRect();
    
    let left = rect.left - parentRect.left + (rect.width / 2) - (dropdown.offsetWidth / 2);
    const top = rect.top - parentRect.top - dropdown.offsetHeight - 10;
    
    // Keep the dropdown fully visible on the screen by bounding its position
    const safetyMargin = 16;
    const maxLeft = parentRect.width - dropdown.offsetWidth - safetyMargin;
    if (left > maxLeft) {
        left = maxLeft;
    }
    if (left < safetyMargin) {
        left = safetyMargin;
    }
    
    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${top}px`;
    
    updateDropdownVisualStates();
}

function hidePlaybackOptionsDropdown() {
    const dropdown = document.getElementById("playback-options-dropdown");
    if (dropdown) {
        dropdown.classList.add("hide");
        delete dropdown.dataset.trigger;
    }
}

function updateDropdownVisualStates() {
    const dropdown = document.getElementById("playback-options-dropdown");
    if (!dropdown) return;
    
    const items = dropdown.querySelectorAll(".dropdown-item");
    items.forEach(item => {
        const option = item.getAttribute("data-option");
        item.classList.remove("active");
        
        if (option === "repeat-track" && repeatMode === "track") {
            item.classList.add("active");
        } else if (option === "repeat-list" && repeatMode === "list") {
            item.classList.add("active");
        } else if (option === "shuffle" && isShuffleOn) {
            item.classList.add("active");
        }
    });
}

function updatePlayerControlsUI() {
    const repeatBtn = document.getElementById("player-repeat-btn");
    const shuffleBtn = document.getElementById("player-shuffle-btn");
    
    if (repeatBtn) {
        if (repeatMode === "track") {
            repeatBtn.classList.add("active-blue");
            repeatBtn.title = "Repeat Track";
            repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i><span style="font-size: 9px; position: absolute; margin-top: 6px; margin-left: 10px; font-weight: bold; background: #08080c; border-radius: 50%; padding: 0 2px; line-height: 1;">1</span>`;
        } else if (repeatMode === "list") {
            repeatBtn.classList.add("active-blue");
            repeatBtn.title = "Repeat List";
            repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i>`;
        } else {
            repeatBtn.classList.remove("active-blue");
            repeatBtn.title = "Repeat Off";
            repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i>`;
        }
    }
    
    if (shuffleBtn) {
        if (isShuffleOn) {
            shuffleBtn.classList.add("active-blue");
            shuffleBtn.title = "Shuffle On";
        } else {
            shuffleBtn.classList.remove("active-blue");
            shuffleBtn.title = "Shuffle Off";
        }
    }
}

function initPlaybackOptionsDropdown() {
    const dropdown = document.getElementById("playback-options-dropdown");
    if (!dropdown) return;
    
    const repeatBtn = document.getElementById("player-repeat-btn");
    const shuffleBtn = document.getElementById("player-shuffle-btn");
    
    if (repeatBtn) {
        repeatBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            showPlaybackOptionsDropdown(repeatBtn);
        });
    }
    
    if (shuffleBtn) {
        shuffleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            showPlaybackOptionsDropdown(shuffleBtn);
        });
    }
    
    dropdown.querySelectorAll(".dropdown-item").forEach(item => {
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            const option = item.getAttribute("data-option");
            
            if (option === "repeat-track") {
                repeatMode = repeatMode === "track" ? "off" : "track";
                localStorage.setItem("aura_repeat_mode", repeatMode);
                updatePlayerControlsUI();
                updateDropdownVisualStates();
                showToast(repeatMode === "track" ? "Repeat Track Enabled 🔂" : "Repeat Disabled ➡️");
            } 
            else if (option === "repeat-list") {
                repeatMode = repeatMode === "list" ? "off" : "list";
                localStorage.setItem("aura_repeat_mode", repeatMode);
                updatePlayerControlsUI();
                updateDropdownVisualStates();
                showToast(repeatMode === "list" ? "Repeat List Enabled 🔁" : "Repeat Disabled ➡️");
            } 
            else if (option === "shuffle") {
                isShuffleOn = !isShuffleOn;
                localStorage.setItem("aura_shuffle_on", isShuffleOn ? "true" : "false");
                if (isShuffleOn) {
                    regenerateShuffleOrder();
                    showToast("Shuffle Enabled 🔀");
                } else {
                    shuffledQueueOrder = null;
                    showToast("Shuffle Disabled ➡️");
                }
                updatePlayerControlsUI();
                updateDropdownVisualStates();
            } 
            else if (option === "reverse") {
                reverseQueueOrder();
                showToast("Queue Order Reversed 🔄");
                hidePlaybackOptionsDropdown();
            }
        });
    });
    
    document.addEventListener("click", (e) => {
        const repBtn = document.getElementById("player-repeat-btn");
        const shufBtn = document.getElementById("player-shuffle-btn");
        
        if (repBtn && repBtn.contains(e.target)) return;
        if (shufBtn && shufBtn.contains(e.target)) return;
        if (dropdown.contains(e.target)) return;
        
        hidePlaybackOptionsDropdown();
    });
}

function renderHiddenSongs() {
    const container = document.getElementById("hidden-songs-list");
    if (!container) return;
    
    if (hiddenTracks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-eye-slash"></i>
                <p>No hidden songs in this session.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = "";
    hiddenTracks.forEach(trackId => {
        const track = findTrackById(trackId);
        if (!track) return;
        
        const row = document.createElement("div");
        row.className = "track-row";
        row.innerHTML = `
            <div class="track-row-art"><img src="${track.thumbnail || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80'}"></div>
            <div class="track-row-info">
                <h4>${safe(track.title)}</h4>
                <p>${safe(track.artist)}</p>
            </div>
            <div class="track-row-actions">
                <button class="btn btn-gold btn-sm" onclick="unhideTrack('${safe(track.id)}')">
                    <i class="fa-solid fa-eye"></i> Unhide
                </button>
            </div>
        `;
        container.appendChild(row);
    });
}

window.unhideTrack = (trackId) => {
    hiddenTracks = hiddenTracks.filter(id => id !== trackId);
    renderHiddenSongs();
    
    // Refresh search results if active
    const resultsView = document.getElementById("search-results-view");
    if (resultsView && !resultsView.classList.contains("hide") && searchResultsCache) {
        renderSearchResults(searchResultsCache);
    }
    
    // Refresh library tab sub-panels
    renderPlaylists();
    renderLibraryLiked();
    renderLibraryDownloads();
    renderLibraryHistory();
    renderLocalSongs();
    renderQueueDrawer();
    
    showToast("Song unhidden");
};

// ==========================================================================
// LITE/PRO MODE SYSTEM — Connection detection, health checks, UI
// ==========================================================================

const HEALTH_CHECK_TIMEOUT_MS = 3500;
const HEALTH_CHECK_INTERVAL_MS = 45000;
let hasShownOfflineToast = false;

async function initModeSystem() {
    // Inject mode dot into header (visible on both desktop + mobile)
    const headerActions = document.querySelector(".header-actions");
    if (headerActions && !document.getElementById("header-mode-btn")) {
        const modeBtn = document.createElement("button");
        modeBtn.id = "header-mode-btn";
        modeBtn.className = "mode-status-header-btn";
        modeBtn.title = "Connection Mode";
        modeBtn.innerHTML = `<span class="mode-dot lite"></span>`;
        modeBtn.addEventListener("click", openModeDropdown);
        headerActions.insertBefore(modeBtn, headerActions.firstChild);
    }

    // Desktop sidebar button
    const sidebarBtn = document.getElementById("mode-toggle-btn");
    if (sidebarBtn) sidebarBtn.addEventListener("click", openModeDropdown);

    // Manual Retry connection buttons
    document.getElementById("mode-retry-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        handleManualRetry();
    });
    document.getElementById("mode-dropdown-retry-btn")?.addEventListener("click", handleManualRetry);

    // Dropdown close handlers
    const closeBtn = document.getElementById("close-mode-dropdown-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeModeDropdown);

    const overlay = document.getElementById("mode-dropdown-overlay");
    if (overlay) {
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) closeModeDropdown();
        });
    }

    // Option click handlers
    document.getElementById("mode-opt-lite")?.addEventListener("click", () => {
        // Lite selection — don't clear URL, just switch view focus
        closeModeDropdown();
    });

    document.getElementById("mode-opt-pro")?.addEventListener("click", () => {
        if (auraBackendUrl) {
            // URL exists — show connection status section
            _showConnectedSection();
        } else {
            // No URL — show input
            _showUrlInputSection();
        }
    });

    // Connect button
    document.getElementById("connect-backend-btn")?.addEventListener("click", _handleConnectClick);

    // Allow Enter key in URL input
    document.getElementById("backend-url-input")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") _handleConnectClick();
    });

    // Change link button
    document.getElementById("change-backend-url-btn")?.addEventListener("click", () => {
        const urlInput = document.getElementById("backend-url-input");
        if (urlInput) urlInput.value = auraBackendUrl;
        _showUrlInputSection();
    });

    // Disconnect button
    document.getElementById("disconnect-backend-btn")?.addEventListener("click", async () => {
        await clearBackendUrl();
        closeModeDropdown();
        showToast("Disconnected — Lite Mode active");
    });

    // Load saved URL and run initial health check
    try {
        const savedUrl = await getConfigValue("backend_url");
        if (savedUrl && typeof savedUrl === "string" && savedUrl.startsWith("http")) {
            auraBackendUrl = savedUrl;
            const isAlive = await checkBackendHealth();
            setMode(isAlive ? "pro" : "lite");
            if (!isAlive) {
                if (!hasShownOfflineToast) {
                    showToast("Server offline, Lite Mode mein chal rahe ho.");
                    hasShownOfflineToast = true;
                }
            } else {
                hasShownOfflineToast = false;
            }
        } else {
            setMode("lite");
        }
    } catch (e) {
        console.error("Mode init failed:", e);
        setMode("lite");
    }

    // Start periodic health checks
    _startHealthCheckLoop();
}

async function checkBackendHealth() {
    if (!auraBackendUrl) return false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
        const res = await fetch(`${auraBackendUrl}/api/health`, {
            signal: controller.signal,
            mode: "cors",
            cache: "no-store"
        });
        clearTimeout(timeoutId);
        if (!res.ok) return false;
        const data = await res.json();
        return data.status === "ok";
    } catch {
        clearTimeout(timeoutId);
        return false;
    }
}

async function handleManualRetry() {
    if (!auraBackendUrl) {
        showToast("No server URL configured.");
        return;
    }
    
    const retryBtns = [
        document.getElementById("mode-retry-btn"),
        document.getElementById("mode-dropdown-retry-btn")
    ];
    retryBtns.forEach(btn => {
        if (btn) {
            btn.disabled = true;
            const icon = btn.querySelector("i");
            if (icon) icon.classList.add("fa-spin");
        }
    });
    
    const isAlive = await checkBackendHealth();
    
    retryBtns.forEach(btn => {
        if (btn) {
            btn.disabled = false;
            const icon = btn.querySelector("i");
            if (icon) icon.classList.remove("fa-spin");
        }
    });
    
    if (isAlive) {
        setMode("pro");
        hasShownOfflineToast = false;
    } else {
        showToast("Server still unreachable");
    }
}

function setMode(newMode) {
    const changed = auraMode !== newMode;
    auraMode = newMode;
    updateModeUI();
    if (changed) {
        window.dispatchEvent(new CustomEvent("aura-mode-change", {
            detail: { mode: newMode, backendUrl: auraBackendUrl }
        }));
    }
}

function updateModeUI() {
    const isPro = auraMode === "pro";
    const dotClass = isPro ? "pro" : "lite";
    const labelText = isPro ? "Pro Mode" : "Lite Mode";

    // Update ALL mode dots in the DOM
    document.querySelectorAll(".mode-dot").forEach(dot => {
        // Skip dots inside the option buttons (they have fixed classes)
        if (dot.closest(".mode-option") || dot.id === "mode-connected-dot") return;
        dot.className = `mode-dot ${dotClass}`;
    });

    // Sidebar label
    const sidebarLabel = document.querySelector("#mode-toggle-btn .mode-label");
    if (sidebarLabel) sidebarLabel.textContent = labelText;

    // Dropdown option highlights
    const litOpt = document.getElementById("mode-opt-lite");
    const proOpt = document.getElementById("mode-opt-pro");
    if (litOpt) litOpt.classList.toggle("active", !isPro);
    if (proOpt) proOpt.classList.toggle("active", isPro);

    // Connected dot in dropdown
    const connDot = document.getElementById("mode-connected-dot");
    if (connDot) connDot.className = `mode-dot ${dotClass}`;
}

function _startHealthCheckLoop() {
    if (healthCheckIntervalId) clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = setInterval(async () => {
        if (!auraBackendUrl) return; // No URL saved, nothing to check
        const isAlive = await checkBackendHealth();
        if (auraMode === "pro" && !isAlive) {
            setMode("lite");
            if (!hasShownOfflineToast) {
                showToast("Server offline, Lite Mode mein chal rahe ho.");
                hasShownOfflineToast = true;
            }
        } else if (isAlive) {
            hasShownOfflineToast = false;
            if (auraMode === "lite") {
                setMode("pro");
                showToast("Server reconnected, Pro Mode ⚡");
            }
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}

async function saveBackendUrl(rawUrl) {
    // Normalize: trim, strip trailing slash, validate protocol
    let url = rawUrl.trim().replace(/\/+$/, "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
    }
    auraBackendUrl = url;
    await setConfigValue("backend_url", url);
    return url;
}

async function clearBackendUrl() {
    auraBackendUrl = "";
    await deleteConfigValue("backend_url");
    setMode("lite");
}

// --- Dropdown UI helpers ---

function openModeDropdown() {
    const overlay = document.getElementById("mode-dropdown-overlay");
    if (!overlay) return;
    overlay.classList.remove("hide");

    // Reset sub-sections visibility based on current state
    const urlSection = document.getElementById("mode-url-section");
    const connSection = document.getElementById("mode-connected-section");
    const statusEl = document.getElementById("mode-connection-status");

    if (urlSection) urlSection.classList.add("hide");
    if (connSection) connSection.classList.add("hide");
    if (statusEl) { statusEl.textContent = ""; statusEl.className = "mode-connection-status"; }

    // If we have a saved URL, show the connected section by default
    if (auraBackendUrl) {
        _showConnectedSection();
    }

    updateModeUI();
}

function closeModeDropdown() {
    const overlay = document.getElementById("mode-dropdown-overlay");
    if (overlay) overlay.classList.add("hide");
}

function _showUrlInputSection() {
    const urlSection = document.getElementById("mode-url-section");
    const connSection = document.getElementById("mode-connected-section");
    if (urlSection) urlSection.classList.remove("hide");
    if (connSection) connSection.classList.add("hide");
    // Focus the input
    setTimeout(() => {
        document.getElementById("backend-url-input")?.focus();
    }, 100);
}

function _showConnectedSection() {
    const urlSection = document.getElementById("mode-url-section");
    const connSection = document.getElementById("mode-connected-section");
    const urlDisplay = document.getElementById("mode-connected-url");

    if (urlSection) urlSection.classList.add("hide");
    if (connSection) connSection.classList.remove("hide");

    if (urlDisplay) {
        // Show truncated URL for readability
        try {
            const parsed = new URL(auraBackendUrl);
            urlDisplay.textContent = parsed.hostname;
        } catch {
            urlDisplay.textContent = auraBackendUrl;
        }
    }

    // Update connected dot
    const connDot = document.getElementById("mode-connected-dot");
    if (connDot) connDot.className = `mode-dot ${auraMode === "pro" ? "pro" : "lite"}`;
}

async function _handleConnectClick() {
    const urlInput = document.getElementById("backend-url-input");
    const statusEl = document.getElementById("mode-connection-status");
    const rawUrl = urlInput?.value?.trim();

    if (!rawUrl) {
        if (statusEl) {
            statusEl.textContent = "Please enter a URL";
            statusEl.className = "mode-connection-status error";
        }
        return;
    }

    // Show checking state
    if (statusEl) {
        statusEl.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Checking connection...`;
        statusEl.className = "mode-connection-status checking";
    }

    const url = await saveBackendUrl(rawUrl);
    const isAlive = await checkBackendHealth();

    if (isAlive) {
        setMode("pro");
        if (statusEl) {
            statusEl.innerHTML = `<i class="fa-solid fa-check-circle"></i> Connected!`;
            statusEl.className = "mode-connection-status success";
        }
        showToast("Pro Mode activated ⚡");
        // Auto-close dropdown after success
        setTimeout(closeModeDropdown, 800);
    } else {
        // Don't clear URL — user might want to retry or fix
        setMode("lite");
        if (statusEl) {
            statusEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Server unreachable (timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s)`;
            statusEl.className = "mode-connection-status error";
        }
    }
}

// Expose mode state for Phase 2+ consumption
window.getAuraMode = () => auraMode;
window.getAuraBackendUrl = () => auraBackendUrl;

// ==========================================================================
// PIPED API ROTATOR & LITE MODE SEARCH / BROWSE ENGINE
// ==========================================================================

const PIPED_INSTANCES = [
    "https://api.piped.private.coffee"
];

async function fetchFromPiped(endpoint, params = {}, timeoutMs = 5000, signal = null) {
    const urlParams = new URLSearchParams(params).toString();
    const queryPath = urlParams ? `${endpoint}?${urlParams}` : endpoint;
    
    let preferredInstance = localStorage.getItem("preferred_piped_instance");
    let instances = [...PIPED_INSTANCES];
    if (preferredInstance && instances.includes(preferredInstance)) {
        instances = [preferredInstance, ...instances.filter(x => x !== preferredInstance)];
    }
    
    const chunkSize = 3;
    for (let i = 0; i < instances.length; i += chunkSize) {
        if (signal && signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
        }
        const chunk = instances.slice(i, i + chunkSize);
        const controllers = [];
        
        const onAbort = () => {
            controllers.forEach(c => c.abort());
        };
        if (signal) {
            signal.addEventListener("abort", onAbort);
        }
        
        const promises = chunk.map(instance => {
            const controller = new AbortController();
            controllers.push(controller);
            const url = `${instance}${queryPath}`;
            
            return new Promise(async (resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    controller.abort();
                    reject(new Error("Timeout"));
                }, timeoutMs);
                
                const cleanUpSignal = () => {
                    clearTimeout(timeoutId);
                    if (signal) signal.removeEventListener("abort", onAbort);
                };
                
                try {
                    if (signal && signal.aborted) {
                        cleanUpSignal();
                        reject(new DOMException("Aborted", "AbortError"));
                        return;
                    }
                    if (isNative() && Capacitor.Plugins && Capacitor.Plugins.CapacitorHttp) {
                        console.log(`Native parallel request to: ${url}`);
                        const response = await Capacitor.Plugins.CapacitorHttp.get({
                            url: url,
                            headers: { "Accept": "application/json" },
                            connectTimeout: timeoutMs,
                            readTimeout: timeoutMs
                        });
                        cleanUpSignal();
                        if (response.status >= 200 && response.status < 300) {
                            const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                            localStorage.setItem("preferred_piped_instance", instance);
                            resolve(data);
                        } else {
                            reject(new Error(`Status: ${response.status}`));
                        }
                    } else {
                        console.log(`Browser parallel request to: ${url}`);
                        const res = await fetch(url, {
                            signal: controller.signal,
                            headers: { "Accept": "application/json" }
                        });
                        cleanUpSignal();
                        if (res.ok) {
                            const data = await res.json();
                            localStorage.setItem("preferred_piped_instance", instance);
                            resolve(data);
                        } else {
                            reject(new Error(`Status: ${res.status}`));
                        }
                    }
                } catch (err) {
                    cleanUpSignal();
                    reject(err);
                }
            });
        });
        
        try {
            if (signal && signal.aborted) {
                throw new DOMException("Aborted", "AbortError");
            }
            // Race the chunk of 3 requests
            const result = await Promise.any(promises);
            // Cancel other active requests in this chunk immediately
            controllers.forEach(c => c.abort());
            return result;
        } catch (err) {
            console.warn(`Parallel chunk failed for indices ${i} to ${i + chunk.length - 1}:`, err);
            controllers.forEach(c => c.abort());
            if (signal && signal.aborted) {
                throw new DOMException("Aborted", "AbortError");
            }
            // Yield to main thread briefly to prevent blocking the event loop
            await new Promise(resolve => setTimeout(resolve, 100));
        } finally {
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
        }
    }
    
    throw new Error("All Piped API instances failed.");
}

function mapPipedItem(item) {
    let videoId = "";
    if (item.videoId) {
        videoId = item.videoId;
    } else if (item.url) {
        const m = item.url.match(/[?&]v=([^&]+)/);
        videoId = m ? m[1] : "";
    }
    
    if (!videoId) return null;
    
    let durationStr = "3:00";
    let durationSeconds = parseInt(item.duration) || 180;
    if (durationSeconds) {
        const m = Math.floor(durationSeconds / 60);
        const s = durationSeconds % 60;
        durationStr = `${m}:${s.toString().padStart(2, "0")}`;
    }
    
    return {
        id: videoId,
        title: item.title || "Unknown Title",
        artist: item.uploaderName || "Unknown Artist",
        artistId: item.uploaderUrl ? item.uploaderUrl.split("/channel/")[1] || "" : "",
        album: "YouTube",
        albumId: "",
        thumbnail: item.thumbnail || "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=100&q=80",
        duration: durationStr,
        durationSeconds: durationSeconds,
        type: "song",
        year: ""
    };
}

async function fetchSuggestionsLite(q) {
    if (suggestionsAbortController) {
        suggestionsAbortController.abort();
    }
    suggestionsAbortController = new AbortController();
    const signal = suggestionsAbortController.signal;
    
    try {
        const suggestions = await fetchFromPiped("/suggestions", { query: q }, 5000, signal);
        if (!signal.aborted) {
            renderSuggestionsUI(suggestions);
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error("Lite suggestions fetch error:", e);
        }
    }
}

async function performSearchLite(q, filter, resultsContainer) {
    let pipedFilter = "all";
    if (filter) {
        const f = filter.toLowerCase().trim();
        if (f === "songs" || f === "song") {
            pipedFilter = "music_songs";
        } else if (f === "videos" || f === "video") {
            pipedFilter = "music_videos";
        } else if (f === "albums" || f === "album") {
            pipedFilter = "music_albums";
        } else if (f === "playlists" || f === "playlist") {
            pipedFilter = "music_playlists";
        }
    }
    
    try {
        const data = await fetchFromPiped("/search", { q: q, filter: pipedFilter });
        const items = data.items || [];
        const results = items
            .map(mapPipedItem)
            .filter(item => item !== null);
            
        searchResultsCache = results;
        renderSearchResults(results);
    } catch (err) {
        console.error("Lite search failed:", err);
        resultsContainer.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Search failed. Check Piped server connection.</p></div>`;
    }
}

async function loadHomeDataLite(trendContainer, newContainer, CACHE_DURATION, now) {
    try {
        const cachedTrend = localStorage.getItem("aura_home_trending_lite");
        const cachedNew = localStorage.getItem("aura_home_new_lite");
        const cachedTime = localStorage.getItem("aura_home_cache_time_lite");

        if (cachedTrend && cachedNew && cachedTime && (now - parseInt(cachedTime)) < CACHE_DURATION) {
            console.log("Lite home data loaded from cache!");
            renderHomeCards(JSON.parse(cachedTrend), trendContainer);
            renderHomeCards(JSON.parse(cachedNew), newContainer);
            return;
        }

        const trendDataRaw = await fetchFromPiped("/search", { q: "trending music hits", filter: "music_songs" });
        const trendData = (trendDataRaw.items || []).map(mapPipedItem).filter(x => x !== null).slice(0, 15);

        localStorage.setItem("aura_home_trending_lite", JSON.stringify(trendData));
        localStorage.setItem("aura_home_cache_time_lite", now.toString());
        
        renderHomeCards(trendData, trendContainer);

        const newDataRaw = await fetchFromPiped("/search", { q: "latest music releases", filter: "music_songs" });
        const newData = (newDataRaw.items || []).map(mapPipedItem).filter(x => x !== null).slice(0, 15);

        localStorage.setItem("aura_home_new_lite", JSON.stringify(newData));

        renderHomeCards(newData, newContainer);
        
    } catch (err) {
        console.error("Lite home data load error:", err);
        if (trendContainer) trendContainer.innerHTML = `<div class="empty-state"><p>Failed to load trending. Check connection.</p></div>`;
        if (newContainer) newContainer.innerHTML = `<div class="empty-state"><p>Failed to load new releases. Check connection.</p></div>`;
    }
}

async function loadSyncedLyricsLite(track) {
    const container = document.getElementById("lyrics-lines-container");
    container.innerHTML = `<div class="lyrics-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading lyrics...</div>`;
    
    lyricsTimeline = [];
    currentActiveLyricIndex = -1;
    
    try {
        let cleanTitle = track.title;
        const emojiRegex = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u;
        const splitChars = ['|', '#', '(', '['];
        let minIndex = cleanTitle.length;
        
        for (const char of splitChars) {
            const idx = cleanTitle.indexOf(char);
            if (idx !== -1 && idx < minIndex) {
                minIndex = idx;
            }
        }
        const emojiMatch = emojiRegex.exec(cleanTitle);
        if (emojiMatch && emojiMatch.index < minIndex) {
            minIndex = emojiMatch.index;
        }
        
        cleanTitle = cleanTitle.substring(0, minIndex).trim();
        cleanTitle = cleanTitle.replace(/-\s*$/, "").trim();
        
        if (!cleanTitle) {
            cleanTitle = track.title.replace(/\(.*?\)|\[.*?\]/g, "").trim();
        }

        const cleanArtist = track.artist.replace(/\(.*?\)|\[.*?\]/g, "").trim();
        let url = `https://lrclib.net/api/lookup?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`;
        if (track.durationSeconds) {
            url += `&duration=${track.durationSeconds}`;
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (currentLoadedTrack && currentLoadedTrack.id !== track.id) return;
        
        if (res.ok) {
            const data = await res.json();
            if (currentLoadedTrack && currentLoadedTrack.id !== track.id) return;
            
            if (data.syncedLyrics) {
                lyricsTimeline = parseLrcLite(data.syncedLyrics);
                const sourceTag = document.getElementById("lyrics-source-tag");
                if (sourceTag) sourceTag.innerText = "Source: lrclib (Synced)";
            } else if (data.plainLyrics) {
                lyricsTimeline = generateSyntheticSyncLite(data.plainLyrics, track.durationSeconds || 180);
                const sourceTag = document.getElementById("lyrics-source-tag");
                if (sourceTag) sourceTag.innerText = "Source: lrclib (Plain, Auto-Synced)";
            }
        }
        
        if (lyricsTimeline.length === 0) {
            const placeholder = `[Instrumental Intro]\nPlaying: ${track.title}\nBy: ${track.artist}\nLyrics not found for this track.\n[Instrumental Outro]`;
            lyricsTimeline = generateSyntheticSyncLite(placeholder, track.durationSeconds || 180);
            const sourceTag = document.getElementById("lyrics-source-tag");
            if (sourceTag) sourceTag.innerText = "Source: AURA System (Synthetic)";
        }
        
        renderLyricsUI();
    } catch (e) {
        console.error("Lite lyrics fetch failed:", e);
        const placeholder = `[Instrumental Intro]\nPlaying: ${track.title}\nBy: ${track.artist}\nLyrics not found for this track.\n[Instrumental Outro]`;
        lyricsTimeline = generateSyntheticSyncLite(placeholder, track.durationSeconds || 180);
        const sourceTag = document.getElementById("lyrics-source-tag");
        if (sourceTag) sourceTag.innerText = "Source: AURA System (Synthetic)";
        renderLyricsUI();
    }
}

function parseLrcLite(lrcText) {
    const lines = lrcText.split("\n");
    const parsed = [];
    const timeRegex = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
    
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        
        let match;
        const matches = [];
        timeRegex.lastIndex = 0;
        while ((match = timeRegex.exec(line)) !== null) {
            matches.push(match);
        }
        
        if (matches.length === 0) continue;
        
        const text = line.replace(timeRegex, "").trim();
        for (const m of matches) {
            const minutes = parseInt(m[1], 10);
            const seconds = parseInt(m[2], 10);
            let milliseconds = 0;
            if (m[3]) {
                const msStr = m[3].padEnd(3, "0").slice(0, 3);
                milliseconds = parseInt(msStr, 10);
            }
            const totalSeconds = minutes * 60 + seconds + (milliseconds / 1000.0);
            parsed.push({ time: totalSeconds, text: text });
        }
    }
    
    parsed.sort((a, b) => a.time - b.time);
    return parsed;
}

function generateSyntheticSyncLite(plainText, durationSec) {
    const lines = plainText.split("\n").map(l => l.trim()).filter(l => l);
    if (lines.length === 0) return [];
    
    const duration = durationSec > 0 ? durationSec : 180;
    const interval = duration / Math.max(lines.length + 1, 1);
    
    return lines.map((line, idx) => ({
        time: parseFloat(((idx + 1) * interval).toFixed(2)),
        text: line
    }));
}
