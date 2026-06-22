import os
import time
import threading
from ytmusicapi import YTMusic
import yt_dlp
import logging
from collections import OrderedDict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
try:
    import yt_dlp as _yt_dlp_check
    logger.info(f"yt-dlp version: {_yt_dlp_check.version.__version__}")
except Exception:
    pass

COOKIES_PATH = os.path.join(os.path.dirname(__file__), '..', 'cookies.txt')
ytmusic = YTMusic()
MAX_CACHE_SIZE = 100
stream_cache = OrderedDict()
CACHE_EXPIRY_SECONDS = 18000
cache_lock = threading.Lock()

INVIDIOUS_INSTANCES = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://invidious.privacyredirect.com",
    "https://yt.cdaut.de",
]

def _search_invidious(query: str, filter_type: str = None):
    import httpx
    for instance in INVIDIOUS_INSTANCES:
        try:
            url = f"{instance}/api/v1/search"
            params = {"q": query, "type": "video", "n": 20}
            response = httpx.get(url, params=params, timeout=8.0)
            if response.status_code != 200:
                continue
            data = response.json()
            standardized = []
            for item in data:
                if item.get("type") != "video":
                    continue
                duration_sec = item.get("lengthSeconds", 0)
                m, s = divmod(int(duration_sec), 60)
                duration_str = f"{m}:{s:02d}"
                thumbnail = ""
                thumbnails = item.get("videoThumbnails", [])
                if thumbnails:
                    thumbnail = thumbnails[0].get("url", "")
                    if thumbnail.startswith("/"):
                        thumbnail = f"{instance}{thumbnail}"
                standardized.append({
                    "id": item.get("videoId", ""),
                    "title": item.get("title", ""),
                    "artist": item.get("author", "Unknown Artist"),
                    "artistId": item.get("authorId", ""),
                    "album": "",
                    "albumId": "",
                    "thumbnail": thumbnail,
                    "duration": duration_str,
                    "durationSeconds": duration_sec,
                    "type": "song",
                    "year": ""
                })
            if standardized:
                logger.info(f"Invidious search success via {instance}")
                return standardized
        except Exception as e:
            logger.warning(f"Invidious instance {instance} failed: {e}")
            continue
    return []

def search_music(query: str, filter_type: str = None):
    try:
        search_query = f"ytsearch50:{query}"
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'nocheckcertificate': True,
            'extract_flat': True,
            'force_ipv4': True,
            'cookiefile': COOKIES_PATH if os.path.exists(COOKIES_PATH) else None,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(search_query, download=False)
            entries = info.get('entries', [])
        standardized = []
        for item in entries:
            if not item:
                continue
            duration_sec = item.get('duration', 0) or 0
            m, s = divmod(int(duration_sec), 60)
            duration_str = f"{m}:{s:02d}"
            thumbnail = ""
            thumbnails = item.get('thumbnails', [])
            if thumbnails:
                thumbnail = thumbnails[-1].get('url', '')
            artist_name = item.get('uploader', '') or item.get('channel', '') or 'Unknown Artist'
            artist_name = artist_name.replace(' - Topic', '')
            video_id = item.get('id', '') or item.get('url', '')
            if not video_id:
                continue
            standardized.append({
                "id": video_id,
                "title": item.get('title', ''),
                "artist": artist_name,
                "artistId": item.get('channel_id', ''),
                "album": "",
                "albumId": "",
                "thumbnail": thumbnail,
                "duration": duration_str,
                "durationSeconds": duration_sec,
                "type": "song",
                "year": str(item.get('upload_date', ''))[:4] if item.get('upload_date') else ""
            })
        if standardized:
            return standardized
        logger.warning("yt-dlp search returned empty, trying Invidious fallback")
        return _search_invidious(query, filter_type)
    except Exception as e:
        if 'SSL' in str(e) or 'SSLError' in str(e):
            logger.error(f"SSL/Network error in search, trying Invidious fallback: {e}")
        else:
            logger.error(f"Search failed, trying Invidious fallback: {e}")
        return _search_invidious(query, filter_type)

def get_suggestions(query: str):
    try:
        search_query = f"ytsearch10:{query}"
        
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'nocheckcertificate': True,
            'extract_flat': True,
            'force_ipv4': True,
            'cookiefile': COOKIES_PATH if os.path.exists(COOKIES_PATH) else None,
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(search_query, download=False)
            entries = info.get('entries', [])
        
        suggestions = []
        for item in entries:
            if item and item.get('title'):
                suggestions.append(item['title'])
        
        return suggestions[:10]
        
    except Exception as e:
        logger.error(f"Failed to fetch suggestions: {e}")
        return []

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

    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best', # 🔥 M4A format force karega jo Mobile/Safari par smoothly chalta hai
        'quiet': True,
        'no_warnings': True,
        'nocheckcertificate': True,
        'skip_download': True,
        'extract_flat': False,
        'force_ipv4': True,
        'cookiefile': COOKIES_PATH if os.path.exists(COOKIES_PATH) else None,
    }
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
            else:
                raise Exception("No direct format URL found in yt-dlp metadata")
    except Exception as e:
        logger.error(f"Failed to extract direct stream for {video_id}: {e}")
        raise e

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
