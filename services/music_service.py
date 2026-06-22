import os
import time
import threading
from ytmusicapi import YTMusic
import yt_dlp
import logging
from collections import OrderedDict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

COOKIES_PATH = os.path.join(os.path.dirname(__file__), '..', 'cookies.txt')
if os.path.exists(COOKIES_PATH):
    ytmusic = YTMusic(auth=COOKIES_PATH)
else:
    ytmusic = YTMusic()
MAX_CACHE_SIZE = 100
stream_cache = OrderedDict()
CACHE_EXPIRY_SECONDS = 18000
cache_lock = threading.Lock()

def search_music(query: str, filter_type: str = None):
    try:
        api_filter = None
        if filter_type:
            ft = filter_type.lower()
            if "song" in ft:
                api_filter = "songs"
            elif "album" in ft:
                api_filter = "albums"
            elif "artist" in ft:
                api_filter = "artists"
            elif "playlist" in ft:
                api_filter = "playlists"
            elif "video" in ft:
                api_filter = "videos"
            elif "podcast" in ft:
                api_filter = "podcasts"

        results = ytmusic.search(query, filter=api_filter, limit=100)
        standardized = []
        for item in results:
            category = item.get("resultType", "song")
            duration_str = ""
            duration_sec = 0
            if "duration" in item and item["duration"]:
                duration_str = item["duration"]
                parts = duration_str.split(":")
                try:
                    if len(parts) == 2:
                        duration_sec = int(parts[0]) * 60 + int(parts[1])
                    elif len(parts) == 3:
                        duration_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                except ValueError:
                    pass
            elif "duration_seconds" in item:
                duration_sec = item["duration_seconds"]
                m, s = divmod(duration_sec, 60)
                duration_str = f"{m}:{s:02d}"

            thumbnail = ""
            if "thumbnails" in item and item["thumbnails"]:
                thumbnail = item["thumbnails"][-1].get("url", "")

            artist_name = "Unknown Artist"
            artist_id = ""
            if "artists" in item and item["artists"]:
                artist_name = ", ".join([a.get("name", "") for a in item["artists"] if a.get("name")])
                artist_id = item["artists"][0].get("id", "")
            elif "author" in item:
                artist_name = item["author"]

            album_name = ""
            album_id = ""
            if "album" in item and item["album"]:
                album_name = item.get("album", {}).get("name", "")
                album_id = item.get("album", {}).get("id", "")

            standardized.append({
                "id": item.get("videoId") or item.get("browseId") or item.get("playlistId") or "",
                "title": item.get("title", ""),
                "artist": artist_name,
                "artistId": artist_id,
                "album": album_name,
                "albumId": album_id,
                "thumbnail": thumbnail,
                "duration": duration_str,
                "durationSeconds": duration_sec,
                "type": category,
                "year": item.get("year", "")
            })
        return standardized
    except Exception as e:
        if 'SSL' in str(e) or 'SSLError' in str(e):
            logger.error(f"SSL/Network error — cookies may be expired: {e}")
        else:
            logger.error(f"Search failed: {e}")
        return []

def get_suggestions(query: str):
    try:
        return ytmusic.get_search_suggestions(query)
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
