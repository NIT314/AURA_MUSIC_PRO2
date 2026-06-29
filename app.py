import os
import time
import json
import logging
import asyncio
from fastapi import FastAPI, WebSocket, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import httpx

# Services
from services.music_service import (
    search_music, get_suggestions, get_streaming_url,
    get_related_tracks, get_album_details, get_artist_details
)
from services.lyrics_service import fetch_lyrics
from services.recommendation_service import get_mood_playlist, get_ai_recommendations
from services.jam_service import create_room, get_room, rooms

# 🔥 DDOS PROTECTION IMPORTS
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AURA ∞ MUSIC API", version="1.0.0")

# Simple in-memory stream URL cache: {video_id: (resolved_url, timestamp)}
stream_url_cache = {}

# 🔥 INITIALIZE LIMITER (IP Address ke hisaab se block karega)
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def api_health():
    return {"status": "ok"}

@app.get("/api/search")
@limiter.limit("60/minute") # Ek user 1 minute mein max 60 search kar sakta hai
async def api_search(request: Request, q: str = Query(..., min_length=1), filter: str = None):
    return await asyncio.to_thread(search_music, q, filter)

@app.get("/api/suggestions")
def api_suggestions(q: str):
    return get_suggestions(q)

@app.get("/api/stream")
@limiter.limit("120/minute") # Stream ke liye thodi limit zyada rakhi hai taaki gaana aage-peeche karne par block na ho
async def api_stream(video_id: str, request: Request):
    print(f"DEBUG: Fetching stream for ID {video_id}", flush=True)
    logger.info(f"Stream request received for video_id={video_id}")
    try:
        now = time.time()
        cached = stream_url_cache.get(video_id)
        if cached and (now - cached[1] < 240):  # 240 seconds = 4 minutes
            stream_url = cached[0]
            logger.info(f"Stream URL resolved from cache for {video_id}: {stream_url[:80]}...")
        else:
            stream_url = get_streaming_url(video_id)
            # Bounded memory cleanup: remove expired entries inline
            expired_keys = [k for k, v in stream_url_cache.items() if now - v[1] >= 240]
            for k in expired_keys:
                stream_url_cache.pop(k, None)
            stream_url_cache[video_id] = (stream_url, now)
            logger.info(f"Stream URL resolved fresh for {video_id}: {stream_url[:80]}...")
    except Exception as e:
        logger.error(f"Stream resolution error for {video_id}: {e}")
        raise HTTPException(status_code=404, detail=f"Track streaming source not found: {e}")

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
    
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    # 🔥 FIX: Context manager (with) hataya taaki stream poori hone tak connection open rahe
    client = httpx.AsyncClient()
    try:
        request_obj = client.build_request("GET", stream_url, headers=headers)
        response_stream = await client.send(request_obj, stream=True, follow_redirects=True)
        
        response_headers = {
            "Content-Type": response_stream.headers.get("content-type", "audio/mpeg"),
            "Accept-Ranges": "bytes",
        }
        
        if "content-range" in response_stream.headers:
            response_headers["Content-Range"] = response_stream.headers["content-range"]
        if "content-length" in response_stream.headers:
            response_headers["Content-Length"] = response_stream.headers["content-length"]

        async def stream_generator():
            try:
                async for chunk in response_stream.aiter_bytes(chunk_size=131072):
                    yield chunk
            finally:
                await response_stream.aclose()
                await client.aclose() # 🔥 Jab gaana poora ho jayega tab hi close hoga

        return StreamingResponse(
            stream_generator(),
            status_code=response_stream.status_code,
            headers=response_headers
        )
    except Exception as e:
        await client.aclose()
        logger.error(f"Error establishing proxy stream: {e}")
        raise HTTPException(status_code=500, detail="Error proxying audio stream")

@app.get("/api/lyrics")
async def api_lyrics(video_id: str, title: str, artist: str, duration: int = 0):
    return await fetch_lyrics(video_id, title, artist, duration)

@app.get("/api/recommendations")
async def api_recommendations(video_id: str = None, history: str = None, profile: str = None):
    history_ids = history.split(",") if history else []
    return await get_ai_recommendations(history_ids, video_id, profile_json=profile)

@app.get("/api/mood")
def api_mood(mood: str):
    return get_mood_playlist(mood)

@app.get("/api/albums/{browse_id}")
def api_album(browse_id: str):
    return get_album_details(browse_id)

@app.get("/api/artists/{channel_id}")
def api_artist(channel_id: str):
    return get_artist_details(channel_id)

@app.get("/api/jam/create")
def api_create_room(room_code: str, host: str):
    if not host or not host.strip():
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    if not room_code or not room_code.strip():
        raise HTTPException(status_code=400, detail="Room code cannot be empty")
    room = create_room(room_code, host)
    return {"room_code": room.room_code, "host": room.host_username}

@app.get("/api/jam/rooms")
def api_list_rooms():
    return {code: {"host": r.host_username, "listeners": len(r.active_connections)} for code, r in rooms.items()}

@app.websocket("/api/jam/ws/{room_code}")
async def jam_websocket_handler(websocket: WebSocket, room_code: str, username: str):
    if not username or not username.strip():
        await websocket.close(code=4003, reason="Username cannot be empty")
        return
    code = room_code.upper().strip()
    room = get_room(code)
    if not room:
        room = create_room(code, username)
    if not await room.connect(username, websocket):
        return
    try:
        while True:
            data_str = await websocket.receive_text()
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON from {username}")
                continue
            msg_type = data.get("type")
            if msg_type == "playback_update":
                video_id = data.get("video_id")
                state = data.get("state")
                position = data.get("position", 0.0)
                track_data = data.get("track")
                await room.update_playback(username, video_id, state, position, track_data)
            elif msg_type == "add_queue":
                song = data.get("song")
                if song:
                    await room.add_to_queue(username, song)
            elif msg_type == "vote_queue":
                song_id = data.get("song_id")
                vote = data.get("vote", 0)
                await room.vote_song(username, song_id, vote)
            elif msg_type == "remove_queue":
                song_id = data.get("song_id")
                await room.remove_from_queue(username, song_id)
            elif msg_type == "reorder_queue":
                queue_ids = data.get("queue_ids")
                if queue_ids:
                    await room.reorder_queue(username, queue_ids)
            elif msg_type == "skip_to_next":
                await room.skip_to_next(username)
            elif msg_type == "skip_to_prev":
                await room.skip_to_prev(username)
            elif msg_type == "chat":
                text = data.get("message", "")
                if text:
                    await room.add_chat_msg(username, text)
            elif msg_type == "reaction":
                emoji = data.get("emoji", "")
                if emoji:
                    await room.trigger_reaction(username, emoji)
            elif msg_type == "set_role":
                target_user = data.get("target_user")
                new_role = data.get("role")
                if target_user and new_role:
                    await room.set_user_role(username, target_user, new_role)
            elif msg_type == "end_jam":
                await room.close_room(username)
            elif msg_type == "toggle_add_only":
                await room.toggle_add_only_mode(username, data.get("enabled"))
            elif msg_type == "leave":
                await room.disconnect(username, websocket)
            elif msg_type == "ping":
                t0 = data.get("t0")
                now_ms = time.time() * 1000.0
                try:
                    await room.send_to_ws(websocket, json.dumps({
                        "type": "pong",
                        "t0": t0,
                        "t1": now_ms,
                        "t2": now_ms
                      }))
                except Exception:
                    pass
            elif msg_type == "heartbeat_sync":
                video_id = data.get("video_id")
                position = data.get("position", 0.0)
                await room.handle_heartbeat_sync(username, video_id, position)
            elif msg_type == "eq_sync":
                settings = data.get("settings")
                if room.has_permission(username, "control_playback"):
                    await room.broadcast({
                        "type": "eq_sync",
                        "settings": settings,
                        "sender": username
                    })
    except Exception as e:
        logger.warning(f"WebSocket connection issue for user {username} in {code}: {e}")
    finally:
        await room.disconnect(username, websocket)

os.makedirs("static/css", exist_ok=True)
os.makedirs("static/js", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port)
