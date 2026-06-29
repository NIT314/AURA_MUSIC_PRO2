import os
import time
import threading
import shutil
from ytmusicapi import YTMusic
import yt_dlp
import logging
from collections import OrderedDict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger.info(f"yt-dlp version: {yt_dlp.version.__version__}")

_SECRET_COOKIES = '/etc/secrets/cookies.txt'
_LOCAL_COOKIES = os.path.join(os.path.dirname(__file__), '..', 'cookies.txt')
_TMP_COOKIES = '/tmp/cookies.txt'

def _resolve_cookies_path():
    if os.path.exists(_SECRET_COOKIES):
        try:
            if os.path.exists(_TMP_COOKIES):
                try:
                    os.remove(_TMP_COOKIES)
                except Exception:
                    pass
            shutil.copy(_SECRET_COOKIES, _TMP_COOKIES)
            os.chmod(_TMP_COOKIES, 0o666)  # Ensure writable permissions
            return _TMP_COOKIES
        except Exception as e:
            logger.warning(f"Failed to copy secrets cookies: {e}")
            return _SECRET_COOKIES
    elif os.path.exists(_LOCAL_COOKIES):
        return _LOCAL_COOKIES
    return None

COOKIES_PATH = _resolve_cookies_path()
ytmusic = YTMusic()
MAX_CACHE_SIZE = 100
stream_cache = OrderedDict()
CACHE_EXPIRY_SECONDS = 18000
cache_lock = threading.Lock()



def search_music(query: str, filter_type: str = None):
    try:
        # Map filter_type to ytmusicapi search filters
        yt_filter = None
        if filter_type:
            ft_lower = filter_type.lower().strip()
            if ft_lower in ['songs', 'song']:
                yt_filter = 'songs'
            elif ft_lower in ['videos', 'video']:
                yt_filter = 'videos'
            elif ft_lower in ['albums', 'album']:
                yt_filter = 'albums'
            elif ft_lower in ['artists', 'artist']:
                yt_filter = 'artists'
            elif ft_lower in ['playlists', 'playlist']:
                yt_filter = 'playlists'

        results = ytmusic.search(query, filter=yt_filter, limit=50)
        standardized = []
        for item in results:
            if not item:
                continue
            
            res_type = item.get('resultType', '')
            
            # Map videoId or browseId or playlistId
            video_id = item.get('videoId') or item.get('browseId') or item.get('playlistId')
            if not video_id and res_type == 'artist':
                artists = item.get('artists', [])
                if artists:
                    video_id = artists[0].get('id')
            if not video_id:
                continue
            
            # Thumbnail extraction
            thumbnail = ""
            thumbnails = item.get('thumbnails', [])
            if thumbnails:
                thumbnail = thumbnails[-1].get('url', '')

            # Artist extraction
            artists = item.get('artists', [])
            if artists:
                artist_name = ", ".join([a.get("name", "") for a in artists if a.get("name")])
                artist_id = artists[0].get("id", "")
            else:
                artist_name = item.get('artist', '') or item.get('author', '') or 'Unknown Artist'
                artist_id = ''

            # Duration extraction
            duration_str = item.get('duration', '')
            duration_sec = item.get('duration_seconds', 0)
            if not duration_str and duration_sec:
                m, s = divmod(int(duration_sec), 60)
                duration_str = f"{m}:{s:02d}"
            elif duration_str and not duration_sec:
                try:
                    parts = duration_str.split(':')
                    if len(parts) == 2:
                        duration_sec = int(parts[0]) * 60 + int(parts[1])
                    elif len(parts) == 3:
                        duration_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                except Exception:
                    duration_sec = 0

            # Album name & ID extraction
            album_name = ""
            album_id = ""
            album_data = item.get('album')
            if album_data:
                if isinstance(album_data, dict):
                    album_name = album_data.get('name', '')
                    album_id = album_data.get('id', '')
                elif isinstance(album_data, str):
                    album_name = album_data

            # Normalize result type (frontend expects song/video/artist/album/playlist)
            mapped_type = res_type
            if mapped_type == 'episode':
                mapped_type = 'video'

            # Set title field appropriately
            title = item.get('title') or item.get('name') or artist_name
            if res_type == 'artist':
                title = item.get('artist') or item.get('name') or artist_name or 'Unknown Artist'

            standardized.append({
                "id": video_id,
                "title": title,
                "artist": artist_name,
                "artistId": artist_id,
                "album": album_name,
                "albumId": album_id,
                "thumbnail": thumbnail,
                "duration": duration_str,
                "durationSeconds": duration_sec,
                "type": mapped_type,
                "year": str(item.get('year') or "")
            })
        return standardized
    except Exception as e:
        logger.error(f"Search failed: {e}")
        return []

def get_suggestions(query: str):
    try:
        return ytmusic.get_search_suggestions(query)
    except Exception as e:
        logger.error(f"Failed to fetch suggestions: {e}")
        return []

PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.nosebs.ru",
    "https://pipedapi-libre.kavin.rocks",
    "https://piped-api.privacy.com.de",
    "https://pipedapi.adminforge.de",
    "https://api.piped.yt",
]

def _get_piped_stream(video_id: str) -> str:
    import httpx
    for instance in PIPED_INSTANCES:
        try:
            url = f"{instance}/streams/{video_id}"
            logger.info(f"Trying Piped stream fallback via {instance}...")
            response = httpx.get(url, follow_redirects=True, timeout=5.0)
            if response.status_code == 200:
                data = response.json()
                audio_streams = data.get("audioStreams", [])
                if audio_streams:
                    def get_bitrate(x):
                        q = x.get("quality", "0")
                        q_num = "".join(filter(str.isdigit, q))
                        return int(q_num) if q_num else 0
                    audio_streams.sort(key=get_bitrate, reverse=True)
                    stream_url = audio_streams[0].get("url")
                    if stream_url:
                        logger.info(f"Piped fallback succeeded via {instance}")
                        return stream_url
        except Exception as e:
            logger.warning(f"Piped fallback failed for {instance}: {e}")
    return None

INVIDIOUS_INSTANCES = [
    "https://iv.melmac.space",
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de", 
    "https://invidious.privacyredirect.com",
    "https://yt.cdaut.de",
    "https://invidious.flokinet.to",
    "https://invidious.lunar.icu",
]

def _get_invidious_stream(video_id: str) -> str:
    import httpx
    for instance in INVIDIOUS_INSTANCES:
        try:
            url = f"{instance}/api/v1/videos/{video_id}"
            logger.info(f"Trying Invidious stream fallback via {instance}...")
            response = httpx.get(url, params={"local": "true"}, follow_redirects=True, timeout=5.0)
            if response.status_code == 200:
                data = response.json()
                adaptive_formats = data.get("adaptiveFormats", [])
                audio_streams = [
                    f for f in adaptive_formats 
                    if f.get("type", "").startswith("audio/") or f.get("mimeType", "").startswith("audio/")
                ]
                if audio_streams:
                    audio_streams.sort(key=lambda x: int(x.get("bitrate", 0) or 0), reverse=True)
                    stream_url = audio_streams[0].get("url")
                    if stream_url:
                        if stream_url.startswith("/"):
                            stream_url = f"{instance}{stream_url}"
                        logger.info(f"Invidious fallback succeeded via {instance}")
                        return stream_url
        except Exception as e:
            logger.warning(f"Invidious fallback failed for {instance}: {e}")
    return None

def get_streaming_url(video_id: str) -> str:
    now = time.time()
    with cache_lock:
        if video_id in stream_cache:
            stream_cache.move_to_end(video_id)
            cached = stream_cache[video_id]
            if cached["expires"] > now:
                return cached["url"]
            else:
                del stream_cache[video_id]

    logger.info(f"get_streaming_url called for video_id={video_id}")
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'quiet': False,
        'no_warnings': False,
        'nocheckcertificate': True,
        'skip_download': True,
        'extract_flat': False,
        'force_ipv4': True,
        'cookiefile': COOKIES_PATH if COOKIES_PATH and os.path.exists(COOKIES_PATH) else None,
        'extractor_args': {
            'youtube': {
                'player_client': ['android', 'ios']
            }
        }
    }
    
    # 1. Try yt-dlp primary stream resolver
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            url = f"https://www.youtube.com/watch?v={video_id}"
            info = ydl.extract_info(url, download=False)
            formats = info.get("formats", [])
            stream_url = None
            audio_formats = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") != "none"]
            if audio_formats:
                audio_formats.sort(key=lambda x: x.get("abr", 0) or 0, reverse=True)
                stream_url = audio_formats[0].get("url")
            if not stream_url:
                stream_url = info.get("url")
            if stream_url:
                with cache_lock:
                    stream_cache[video_id] = {
                        "url": stream_url,
                        "expires": now + CACHE_EXPIRY_SECONDS
                    }
                    if len(stream_cache) > MAX_CACHE_SIZE:
                        stream_cache.popitem(last=False)
                return stream_url
    except Exception as e:
        logger.warning(f"yt-dlp primary extraction failed for {video_id}: {e}. Trying fallbacks...")

    # 2. Try Piped API secondary fallback
    stream_url = _get_piped_stream(video_id)
    if stream_url:
        with cache_lock:
            stream_cache[video_id] = {
                "url": stream_url,
                "expires": now + CACHE_EXPIRY_SECONDS
            }
            if len(stream_cache) > MAX_CACHE_SIZE:
                stream_cache.popitem(last=False)
        return stream_url

    # 3. Try Invidious API tertiary fallback
    stream_url = _get_invidious_stream(video_id)
    if stream_url:
        with cache_lock:
            stream_cache[video_id] = {
                "url": stream_url,
                "expires": now + CACHE_EXPIRY_SECONDS
            }
            if len(stream_cache) > MAX_CACHE_SIZE:
                stream_cache.popitem(last=False)
        return stream_url

    raise Exception(f"All stream extraction methods failed for video_id={video_id}")

def get_related_tracks(video_id: str):
    try:
        playlist = ytmusic.get_watch_playlist(videoId=video_id, limit=20)
        tracks = []
        for item in playlist.get("tracks", []):
            thumbnail = ""
            if "thumbnail" in item and item["thumbnail"]:
                thumbnail = item["thumbnail"][-1].get("url", "")
            elif "thumbnails" in item and item["thumbnails"]:
                thumbnail = item["thumbnails"][-1].get("url", "")
            artist_name = "Unknown Artist"
            artist_id = ""
            if "artists" in item and item["artists"]:
                artist_name = ", ".join([a.get("name", "") for a in item["artists"] if a.get("name")])
                artist_id = item["artists"][0].get("id", "")
            tracks.append({
                "id": item.get("videoId", ""),
                "title": item.get("title", ""),
                "artist": artist_name,
                "artistId": artist_id,
                "album": item.get("album", {}).get("name", "") if item.get("album") else "",
                "albumId": item.get("album", {}).get("id", "") if item.get("album") else "",
                "thumbnail": thumbnail,
                "duration": item.get("duration", ""),
                "durationSeconds": item.get("duration_seconds", 0),
                "type": "song"
            })
        return tracks
    except Exception as e:
        logger.error(f"Failed to get watch playlist for {video_id}: {e}")
        return []

def get_album_details(browse_id: str):
    try:
        album_data = ytmusic.get_album(browseId=browse_id)
        tracks = []
        for idx, track in enumerate(album_data.get("tracks", [])):
            duration_str = track.get("duration", "")
            duration_sec = track.get("duration_seconds", 0)
            artists = track.get("artists", [])
            artist_name = ", ".join([a.get("name", "") for a in artists]) if artists else album_data.get("artists", [{}])[0].get("name", "Unknown")
            artist_id = artists[0].get("id", "") if artists else album_data.get("artists", [{}])[0].get("id", "")
            tracks.append({
                "id": track.get("videoId", ""),
                "title": track.get("title", ""),
                "artist": artist_name,
                "artistId": artist_id,
                "duration": duration_str,
                "durationSeconds": duration_sec,
                "trackNumber": idx + 1,
                "type": "song"
            })
        thumbnails = album_data.get("thumbnails", [])
        thumbnail = thumbnails[-1].get("url", "") if thumbnails else ""
        return {
            "title": album_data.get("title", ""),
            "artist": ", ".join([a.get("name", "") for a in album_data.get("artists", [])]),
            "artistId": album_data.get("artists", [{}])[0].get("id", "") if album_data.get("artists") else "",
            "thumbnail": thumbnail,
            "year": album_data.get("year", ""),
            "description": album_data.get("description", ""),
            "tracks": tracks
        }
    except Exception as e:
        logger.error(f"Failed to get album details for {browse_id}: {e}")
        return {}

def get_artist_details(channel_id: str):
    try:
        artist_data = ytmusic.get_artist(channelId=channel_id)
        songs = []
        for song in artist_data.get("songs", {}).get("results", []):
            thumbnails = song.get("thumbnails", [])
            thumbnail = thumbnails[-1].get("url", "") if thumbnails else ""
            songs.append({
                "id": song.get("videoId", ""),
                "title": song.get("title", ""),
                "artist": artist_data.get("name", ""),
                "artistId": channel_id,
                "album": song.get("album", {}).get("name", "") if song.get("album") else "",
                "albumId": song.get("album", {}).get("id", "") if song.get("album") else "",
                "thumbnail": thumbnail,
                "duration": song.get("duration", ""),
                "type": "song"
            })
        albums = []
        for album in artist_data.get("albums", {}).get("results", []):
            thumbnails = album.get("thumbnails", [])
            thumbnail = thumbnails[-1].get("url", "") if thumbnails else ""
            albums.append({
                "id": album.get("browseId", ""),
                "title": album.get("title", ""),
                "thumbnail": thumbnail,
                "year": album.get("year", ""),
                "type": "album"
            })
        singles = []
        for single in artist_data.get("singles", {}).get("results", []):
            thumbnails = single.get("thumbnails", [])
            thumbnail = thumbnails[-1].get("url", "") if thumbnails else ""
            singles.append({
                "id": single.get("browseId", ""),
                "title": single.get("title", ""),
                "thumbnail": thumbnail,
                "year": single.get("year", ""),
                "type": "single"
            })
        similar = []
        for rel in artist_data.get("related", {}).get("results", []):
            thumbnails = rel.get("thumbnails", [])
            thumbnail = thumbnails[-1].get("url", "") if thumbnails else ""
            similar.append({
                "id": rel.get("browseId", ""),
                "name": rel.get("title", ""),
                "thumbnail": thumbnail,
                "type": "artist"
            })
        thumbnails = artist_data.get("thumbnails", [])
        thumbnail = thumbnails[-1].get("url", "") if thumbnails else ""
        return {
            "name": artist_data.get("name", ""),
            "bio": artist_data.get("description", ""),
            "thumbnail": thumbnail,
            "popularSongs": songs,
            "albums": albums,
            "singles": singles,
            "similarArtists": similar
        }
    except Exception as e:
        logger.error(f"Failed to get artist details for {channel_id}: {e}")
        return {}
