/*
  AURA ∞ MUSIC - PlaybackProvider
  Provides a clean interface for a last-resort YouTube IFrame Player fallback.
  Isolated to run only in Lite Mode and when not running in Native Mode (Capacitor).
*/

(function() {
    // Check elements
    const audioEl = document.getElementById("audio-element");
    if (!audioEl) {
        console.warn("[PlaybackProvider] Target audio-element not found.");
        return;
    }

    // Keep references to original methods & getters/setters
    const originalPlay = audioEl.play;
    const originalPause = audioEl.pause;
    const originalLoad = audioEl.load;

    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    const currentTimeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
    const durationDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "duration");
    const volumeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
    const pausedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "paused");
    const endedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "ended");

    const originalSrcGet = srcDescriptor.get;
    const originalSrcSet = srcDescriptor.set;
    const originalCurrentTimeGet = currentTimeDescriptor.get;
    const originalCurrentTimeSet = currentTimeDescriptor.set;
    const originalDurationGet = durationDescriptor.get;
    const originalVolumeGet = volumeDescriptor.get;
    const originalVolumeSet = volumeDescriptor.set;
    const originalPausedGet = pausedDescriptor.get;
    const originalEndedGet = endedDescriptor.get;

    // Define the isolated PlaybackProvider interface
    const PlaybackProvider = {
        iframeActive: false,
        ytPlayer: null,
        currentTrackId: null,
        fakeDuration: 180,
        timeUpdateInterval: null,

        isIframeActive() {
            // ONLY Lite Mode, NOT Native Mode
            const isLite = window.auraMode === "lite";
            const isNativeWrapper = (typeof window.isNative === "function" && window.isNative()) || (window.Capacitor && window.Capacitor.isNative);
            return this.iframeActive && isLite && !isNativeWrapper;
        },

        activateIframe(trackId) {
            const isNativeWrapper = (typeof window.isNative === "function" && window.isNative()) || (window.Capacitor && window.Capacitor.isNative);
            if (window.auraMode !== "lite" || isNativeWrapper) {
                console.log("[PlaybackProvider] Aborting iframe activation: Not in Lite Mode or running in Native Mode.");
                return;
            }

            console.log(`[PlaybackProvider] Activating YouTube IFrame fallback for track ID: ${trackId}`);
            this.iframeActive = true;
            this.currentTrackId = trackId;

            // Pause and reset HTML5 audio
            try {
                originalPause.call(audioEl);
                originalSrcSet.call(audioEl, "");
            } catch(e) {}

            this.ensureYoutubeApiLoaded();
            this.loadVideoInIframe(trackId);

            if (typeof window.onSongPlayStateChange === "function") {
                window.onSongPlayStateChange(true);
            }
        },

        deactivateIframe() {
            if (!this.iframeActive) return;
            console.log("[PlaybackProvider] Deactivating YouTube IFrame fallback.");
            this.iframeActive = false;
            this.currentTrackId = null;
            this.stopTimeUpdateSimulation();

            if (this.ytPlayer) {
                try {
                    this.ytPlayer.stopVideo();
                } catch(e){}
            }

            const container = document.getElementById("yt-iframe-container");
            if (container) {
                container.innerHTML = "";
            }
            this.ytPlayer = null;
        },

        ensureYoutubeApiLoaded() {
            if (window.YT) return;
            if (document.getElementById("yt-iframe-api-script")) return;

            console.log("[PlaybackProvider] Loading YouTube IFrame API script...");
            const tag = document.createElement('script');
            tag.id = "yt-iframe-api-script";
            tag.src = "https://www.youtube.com/iframe_api";
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
        },

        loadVideoInIframe(videoId) {
            const container = document.getElementById("yt-iframe-container");
            if (!container) return;

            container.innerHTML = '<div id="yt-player-placeholder"></div>';

            const initPlayer = () => {
                this.ytPlayer = new YT.Player('yt-player-placeholder', {
                    height: '200',
                    width: '200',
                    videoId: videoId,
                    playerVars: {
                        'autoplay': 1,
                        'controls': 0,
                        'disablekb': 1,
                        'fs': 0,
                        'rel': 0,
                        'showinfo': 0,
                        'iv_load_policy': 3,
                        'modestbranding': 1
                    },
                    events: {
                        'onReady': (event) => {
                            event.target.playVideo();
                            // Sync volume
                            const currentVol = originalVolumeGet.call(audioEl);
                            event.target.setVolume(currentVol * 100);
                        },
                        'onStateChange': (event) => {
                            // YT.PlayerState: UNSTARTED (-1), ENDED (0), PLAYING (1), PAUSED (2), BUFFERING (3), CUED (5)
                            if (event.data === YT.PlayerState.PLAYING) {
                                if (typeof window.onSongPlayStateChange === "function") {
                                    window.onSongPlayStateChange(true);
                                }
                                this.startTimeUpdateSimulation();
                            } else if (event.data === YT.PlayerState.PAUSED) {
                                if (typeof window.onSongPlayStateChange === "function") {
                                    window.onSongPlayStateChange(false);
                                }
                                this.stopTimeUpdateSimulation();
                            } else if (event.data === YT.PlayerState.ENDED) {
                                console.log("[PlaybackProvider] YT video ended, dispatching ended event.");
                                this.stopTimeUpdateSimulation();
                                const endedEvent = new Event("ended");
                                audioEl.dispatchEvent(endedEvent);
                            }
                        },
                        'onError': (event) => {
                            console.error("[PlaybackProvider] YT Player error code:", event.data);
                            if (typeof window.showToast === "function") {
                                window.showToast("Error loading YouTube source.");
                            }
                        }
                    }
                });
            };

            if (window.YT && window.YT.Player) {
                initPlayer();
            } else {
                window.onYouTubeIframeAPIReady = () => {
                    initPlayer();
                };
            }
        },

        startTimeUpdateSimulation() {
            this.stopTimeUpdateSimulation();
            this.timeUpdateInterval = setInterval(() => {
                if (this.isIframeActive()) {
                    const event = new Event("timeupdate");
                    audioEl.dispatchEvent(event);
                }
            }, 250);
        },

        stopTimeUpdateSimulation() {
            if (this.timeUpdateInterval) {
                clearInterval(this.timeUpdateInterval);
                this.timeUpdateInterval = null;
            }
        },

        getIframeCurrentTime() {
            if (this.ytPlayer && typeof this.ytPlayer.getCurrentTime === "function") {
                return this.ytPlayer.getCurrentTime();
            }
            return 0;
        },

        setIframeCurrentTime(sec) {
            if (this.ytPlayer && typeof this.ytPlayer.seekTo === "function") {
                this.ytPlayer.seekTo(sec, true);
            }
        },

        getIframeDuration() {
            if (this.ytPlayer && typeof this.ytPlayer.getDuration === "function") {
                const d = this.ytPlayer.getDuration();
                if (d > 0) return d;
            }
            if (window.currentLoadedTrack && window.currentLoadedTrack.durationSeconds) {
                return window.currentLoadedTrack.durationSeconds;
            }
            return this.fakeDuration;
        },

        playIframe() {
            if (this.ytPlayer && typeof this.ytPlayer.playVideo === "function") {
                this.ytPlayer.playVideo();
            }
        },

        pauseIframe() {
            if (this.ytPlayer && typeof this.ytPlayer.pauseVideo === "function") {
                this.ytPlayer.pauseVideo();
            }
        },

        setIframeVolume(vol) {
            if (this.ytPlayer && typeof this.ytPlayer.setVolume === "function") {
                this.ytPlayer.setVolume(vol * 100);
            }
        },

        isIframePaused() {
            if (this.ytPlayer && typeof this.ytPlayer.getPlayerState === "function") {
                return this.ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING;
            }
            return true;
        }
    };

    // Override methods on the DOM audio element instance
    audioEl.play = function() {
        if (PlaybackProvider.isIframeActive()) {
            PlaybackProvider.playIframe();
            return Promise.resolve();
        }
        return originalPlay.apply(this, arguments);
    };

    audioEl.pause = function() {
        if (PlaybackProvider.isIframeActive()) {
            PlaybackProvider.pauseIframe();
            return;
        }
        originalPause.apply(this, arguments);
    };

    audioEl.load = function() {
        if (PlaybackProvider.isIframeActive()) {
            return;
        }
        originalLoad.apply(this, arguments);
    };

    // Define property getters/setters
    Object.defineProperty(audioEl, "src", {
        get() {
            return originalSrcGet.call(this);
        },
        set(val) {
            // Deactivate iframe whenever a new stream src is loaded (i.e. returning to HTML5 audio)
            if (PlaybackProvider.isIframeActive()) {
                PlaybackProvider.deactivateIframe();
            }
            originalSrcSet.call(this, val);
        },
        configurable: true
    });

    Object.defineProperty(audioEl, "currentTime", {
        get() {
            if (PlaybackProvider.isIframeActive()) {
                return PlaybackProvider.getIframeCurrentTime();
            }
            return originalCurrentTimeGet.call(this);
        },
        set(val) {
            if (PlaybackProvider.isIframeActive()) {
                PlaybackProvider.setIframeCurrentTime(val);
            } else {
                originalCurrentTimeSet.call(this, val);
            }
        },
        configurable: true
    });

    Object.defineProperty(audioEl, "duration", {
        get() {
            if (PlaybackProvider.isIframeActive()) {
                return PlaybackProvider.getIframeDuration();
            }
            return originalDurationGet.call(this);
        },
        configurable: true
    });

    Object.defineProperty(audioEl, "volume", {
        get() {
            return originalVolumeGet.call(this);
        },
        set(val) {
            originalVolumeSet.call(this, val);
            if (PlaybackProvider.isIframeActive()) {
                PlaybackProvider.setIframeVolume(val);
            }
        },
        configurable: true
    });

    Object.defineProperty(audioEl, "paused", {
        get() {
            if (PlaybackProvider.isIframeActive()) {
                return PlaybackProvider.isIframePaused();
            }
            return originalPausedGet.call(this);
        },
        configurable: true
    });

    Object.defineProperty(audioEl, "ended", {
        get() {
            if (PlaybackProvider.isIframeActive()) {
                if (PlaybackProvider.ytPlayer && typeof PlaybackProvider.ytPlayer.getPlayerState === "function") {
                    return PlaybackProvider.ytPlayer.getPlayerState() === 0;
                }
                return false;
            }
            return originalEndedGet.call(this);
        },
        configurable: true
    });

    // Register audio fallback trigger for loading errors
    audioEl.addEventListener("error", () => {
        const isNativeWrapper = (typeof window.isNative === "function" && window.isNative()) || (window.Capacitor && window.Capacitor.isNative);
        if (window.auraMode === "lite" && window.currentLoadedTrack && !window.currentLoadedTrack.isLocal && !isNativeWrapper) {
            console.warn("[PlaybackProvider] HTML5 stream failed to load. Initiating YouTube IFrame fallback...");
            PlaybackProvider.activateIframe(window.currentLoadedTrack.id);
        }
    });

    // Bind globally
    window.PlaybackProvider = PlaybackProvider;
})();
