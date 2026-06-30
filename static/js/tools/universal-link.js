/*
  AURA ∞ MUSIC - Universal Link Resolver
  Detects and resolves various link formats to direct playback or YouTube search queries.
*/

window.AuraUniversalLink = {
    init() {
        const input = document.getElementById("universal-link-input");
        const playBtn = document.getElementById("universal-play-btn");
        const pasteBtn = document.getElementById("universal-paste-btn");

        if (playBtn) {
            playBtn.addEventListener("click", async () => {
                const text = input.value.trim();
                if (!text) {
                    showToast("Please enter a link or search term.");
                    return;
                }
                playBtn.disabled = true;
                playBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Resolving...`;
                
                try {
                    await this.resolveAndPlay(text);
                } catch (e) {
                    console.error("Resolve link error:", e);
                    showToast("Failed to resolve link.");
                } finally {
                    playBtn.disabled = false;
                    playBtn.innerHTML = `<i class="fa-solid fa-play"></i> Resolve & Play`;
                }
            });
        }

        if (pasteBtn) {
            pasteBtn.addEventListener("click", async () => {
                try {
                    let clipboardText = "";
                    if (window.isNative && window.isNative() && typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.Clipboard) {
                        const result = await Capacitor.Plugins.Clipboard.read();
                        clipboardText = result.value || "";
                    } else {
                        clipboardText = await navigator.clipboard.readText();
                    }
                    if (clipboardText) {
                        input.value = clipboardText.trim();
                        showToast("Pasted from clipboard!");
                    } else {
                        showToast("Clipboard is empty.");
                    }
                } catch (e) {
                    console.error("Paste Clipboard error:", e);
                    showToast("Clipboard permission denied.");
                }
            });
        }
    },

    async resolveAndPlay(text) {
        const provider = this.detectProvider(text);
        console.log(`[Link Player] Detected provider: ${provider} for input: ${text}`);

        switch (provider) {
            case "youtube":
                await this.resolveYoutube(text);
                break;
            case "direct":
                await this.resolveDirectAudio(text);
                break;
            case "spotify":
                await this.resolveSpotify(text);
                break;
            case "soundcloud":
                await this.resolveSoundCloud(text);
                break;
            case "apple":
                await this.resolveAppleMusic(text);
                break;
            case "deezer":
                await this.resolveDeezer(text);
                break;
            case "social":
                await this.resolveSocial(text);
                break;
            case "other_music":
                await this.resolveOtherMusic(text, provider);
                break;
            case "generic":
            default:
                await this.resolveGeneric(text);
                break;
        }
    },

    detectProvider(text) {
        if (!text.startsWith("http://") && !text.startsWith("https://")) {
            return "generic";
        }

        const url = text.toLowerCase();
        
        if (url.includes("youtube.com") || url.includes("youtu.be") || url.includes("music.youtube.com")) {
            return "youtube";
        }

        if (url.includes("spotify.com")) {
            return "spotify";
        }

        if (url.includes("soundcloud.com")) {
            return "soundcloud";
        }

        if (url.includes("music.apple.com")) {
            return "apple";
        }

        if (url.includes("deezer.com")) {
            return "deezer";
        }

        const audioExtensions = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".m3u8"];
        const hasAudioExtension = audioExtensions.some(ext => url.split('?')[0].endsWith(ext));
        if (hasAudioExtension || url.includes("icecast") || url.includes("shoutcast") || url.includes("/stream") || url.includes("/live")) {
            return "direct";
        }

        if (url.includes("instagram.com") || url.includes("facebook.com") || url.includes("fb.watch") || url.includes("tiktok.com") || url.includes("twitter.com") || url.includes("x.com")) {
            return "social";
        }

        if (url.includes("jiosaavn.com") || url.includes("gaana.com") || url.includes("wynk.in") || url.includes("hungama.com") || url.includes("bandcamp.com") || url.includes("audiomack.com") || url.includes("mixcloud.com") || url.includes("rss") || url.includes(".xml")) {
            return "other_music";
        }

        return "generic";
    },

    async resolveYoutube(url) {
        let videoId = null;
        let playlistId = null;

        const videoRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|x\/|user\/[^\/]+\/)|youtu\.be\/|youtube\.com\/shorts\/|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/;
        const videoMatch = url.match(videoRegex);
        if (videoMatch) videoId = videoMatch[1];

        const playlistMatch = url.match(/[&?]list=([a-zA-Z0-9_-]+)/);
        if (playlistMatch) playlistId = playlistMatch[1];

        if (playlistId) {
            await this.resolveYoutubePlaylist(playlistId);
        } else if (videoId) {
            showToast("Playing YouTube video...");
            const track = {
                id: videoId,
                title: "Loading...",
                artist: "YouTube Video",
                thumbnail: `https://img.youtube.com/vi/${videoId}/0.jpg`,
                isLocal: false
            };
            
            try {
                const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
                const res = await fetch(oembedUrl);
                const metadata = await res.json();
                if (metadata.title) {
                    track.title = metadata.title;
                    track.artist = metadata.author_name || "YouTube Video";
                }
            } catch (e) {
                console.log("oEmbed failed, using defaults:", e);
                track.title = "YouTube Track " + videoId;
            }
            
            await window.playSingleSong(track);
        } else {
            await this.resolveGeneric(url);
        }
    },

    async resolveDirectAudio(url) {
        showToast("Streaming direct link...");
        let cleanName = url.substring(url.lastIndexOf("/") + 1).split('?')[0];
        if (!cleanName || cleanName.length > 30) {
            cleanName = "Direct Audio Link";
        }
        
        const track = {
            id: url,
            title: decodeURIComponent(cleanName),
            artist: "External Stream",
            thumbnail: "icon-192.png",
            isLocal: false,
            isDirect: true,
            duration: "Live"
        };
        await window.playSingleSong(track);
    },

    async resolveSpotify(url) {
        const playlistMatch = url.match(/playlist\/([a-zA-Z0-9]+)/);
        if (playlistMatch) {
            const playlistId = playlistMatch[1];
            await this.resolveSpotifyPlaylist(playlistId);
            return;
        }

        showToast("Resolving Spotify Link...");
        let metadata = { title: "", artist: "" };

        try {
            const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
            const res = await fetch(oembedUrl);
            const data = await res.json();
            if (data.title) {
                metadata.title = data.title;
                metadata.artist = "";
                
                if (data.title.includes(" by ")) {
                    const parts = data.title.split(" by ");
                    metadata.title = parts[0];
                    metadata.artist = parts[1];
                }
            }
        } catch (e) {
            console.log("Spotify oEmbed failed, parsing path:", e);
            const parts = url.split("/");
            const idIdx = parts.indexOf("track");
            if (idIdx !== -1 && parts[idIdx + 1]) {
                metadata.title = "Spotify Track " + parts[idIdx + 1].split("?")[0];
            }
        }

        if (metadata.title) {
            const query = `${metadata.title} ${metadata.artist}`.trim();
            await this.resolveGeneric(query);
        } else {
            showToast("Could not extract Spotify details. Using raw URL search.");
            await this.resolveGeneric(url);
        }
    },

    async resolveSoundCloud(url) {
        showToast("Resolving SoundCloud Link...");
        let metadata = { title: "", artist: "" };

        try {
            const oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
            const res = await fetch(oembedUrl);
            const data = await res.json();
            if (data.title) {
                metadata.title = data.title;
                metadata.artist = data.author_name || "SoundCloud Artist";
            }
        } catch (e) {
            console.log("SoundCloud oEmbed failed:", e);
            const parts = url.split("/");
            metadata.title = decodeURIComponent(parts[parts.length - 1] || "SoundCloud Track");
        }

        if (metadata.title) {
            const query = `${metadata.title} ${metadata.artist}`.trim();
            await this.resolveGeneric(query);
        } else {
            await this.resolveGeneric(url);
        }
    },

    async resolveAppleMusic(url) {
        showToast("Resolving Apple Music...");
        const parts = url.split("/");
        let title = "Apple Music Track";
        
        const albumIdx = parts.indexOf("album");
        if (albumIdx !== -1 && parts[albumIdx + 1]) {
            title = parts[albumIdx + 1].replace(/-/g, " ");
        }
        await this.resolveGeneric(title);
    },

    async resolveDeezer(url) {
        showToast("Resolving Deezer Track...");
        const parts = url.split("/");
        let trackId = parts[parts.length - 1].split("?")[0];
        const title = "Deezer Track " + trackId;
        await this.resolveGeneric(title);
    },

    async resolveSocial(url) {
        showToast("Resolving Social Video...");
        let query = "Social media video sound";
        if (url.includes("instagram.com")) {
            query = "Instagram reel audio";
        } else if (url.includes("tiktok.com")) {
            query = "TikTok video track";
        }
        await this.resolveGeneric(query);
    },

    async resolveOtherMusic(url, provider) {
        showToast("Resolving regional track...");
        const parts = url.split("/");
        let title = parts[parts.length - 1].split("?")[0].replace(/[-_]/g, " ");
        if (title.length > 40) {
            title = title.substring(0, 40);
        }
        await this.resolveGeneric(title);
    },

    async resolveGeneric(query) {
        showToast(`Searching for: "${query}"... 🔍`);
        
        if (auraMode === "lite") {
            try {
                const data = await window.fetchFromPiped("/search", { q: query, filter: "music_songs" });
                const items = data.items || [];
                const results = items
                    .map(window.mapPipedItem)
                    .filter(item => item !== null);
                
                if (results.length > 0) {
                    showToast(`Playing top search result... 🎵`);
                    await window.playSingleSong(results[0]);
                } else {
                    showToast("No playable streams found for query.");
                }
            } catch (err) {
                console.error("Link search fallback error:", err);
                showToast("Failed to fetch search results from Piped.");
            }
        } else {
            try {
                const apiBase = window.getAuraBackendUrl() || "";
                const res = await fetch(`${apiBase}/api/search?q=${encodeURIComponent(query)}&filter=songs`);
                const results = await res.json();
                
                if (results.length > 0) {
                    showToast(`Playing top search result... 🎵`);
                    await window.playSingleSong(results[0]);
                } else {
                    showToast("No track found matching search metadata.");
                }
            } catch (err) {
                console.error("Link search fallback error:", err);
                showToast("Failed to resolve track search.");
            }
        }
    },

    async resolveSpotifyPlaylist(playlistId) {
        showToast("Importing Spotify playlist... 🔍");
        if (auraMode === "lite") {
            showToast("Playlists can only be imported in Pro Mode.");
            return;
        }
        
        try {
            const apiBase = window.getAuraBackendUrl() || "";
            const res = await fetch(`${apiBase}/api/playlist/import?provider=spotify&id=${playlistId}`);
            if (!res.ok) {
                const detail = await res.json().catch(() => ({}));
                throw new Error(detail.detail || "HTTP " + res.status);
            }
            const data = await res.json();
            const tracks = data.tracks || [];
            
            if (tracks.length === 0) {
                showToast("No playable tracks resolved from Spotify playlist.");
                return;
            }
            
            playerQueue.push(...tracks);
            showToast(`Imported ${tracks.length} tracks from Spotify playlist! 🎶`);
            await window.playSingleSong(tracks[0]);
        } catch (e) {
            console.error("Spotify playlist import failed:", e);
            showToast("Failed to import Spotify playlist: " + e.message);
        }
    },

    async resolveYoutubePlaylist(playlistId) {
        showToast("Importing YouTube playlist... 🔍");
        if (auraMode === "lite") {
            showToast("Playlists can only be imported in Pro Mode.");
            return;
        }
        
        try {
            const apiBase = window.getAuraBackendUrl() || "";
            const res = await fetch(`${apiBase}/api/playlist/import?provider=youtube&id=${playlistId}`);
            if (!res.ok) {
                const detail = await res.json().catch(() => ({}));
                throw new Error(detail.detail || "HTTP " + res.status);
            }
            const data = await res.json();
            const tracks = data.tracks || [];
            
            if (tracks.length === 0) {
                showToast("No tracks found in YouTube playlist.");
                return;
            }
            
            playerQueue.push(...tracks);
            showToast(`Queued ${tracks.length} tracks from YouTube playlist! 🎶`);
            await window.playSingleSong(tracks[0]);
        } catch (e) {
            console.error("YouTube playlist import failed:", e);
            showToast("Failed to import YouTube playlist: " + e.message);
        }
    }
};
