import os
import time
import json
import logging
import asyncio
import base64
import hmac
import hashlib
import secrets
from datetime import datetime
from fastapi import FastAPI, WebSocket, HTTPException, Query, Request, Header
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import httpx

# Services
from services.music_service import (
    search_music, get_suggestions, get_streaming_url,
    get_related_tracks, get_album_details, get_artist_details,
    fetch_youtube_playlist_ytmusic, fetch_youtube_playlist_ytdlp,
    fetch_spotify_playlist
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
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "*"
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


@app.get("/api/playlist/import")
@limiter.limit("20/minute")
async def api_playlist_import(request: Request, provider: str = None, id: str = None, url: str = None):
    playlist_id = id
    selected_provider = provider
    
    if url:
        import re
        url = url.strip()
        # YouTube detection
        yt_match = re.search(r'[&?]list=([a-zA-Z0-9_-]+)', url)
        if yt_match:
            playlist_id = yt_match.group(1)
            selected_provider = "youtube"
        else:
            # Spotify detection
            sp_match = re.search(r'playlist/([a-zA-Z0-9]+)', url)
            if sp_match:
                playlist_id = sp_match.group(1)
                selected_provider = "spotify"
                
    if not playlist_id:
        raise HTTPException(status_code=400, detail="Missing playlist ID or URL")
        
    if not selected_provider:
        selected_provider = "youtube"
        
    selected_provider = selected_provider.lower().strip()
    
    if selected_provider == "youtube":
        try:
            return await asyncio.to_thread(fetch_youtube_playlist_ytmusic, playlist_id)
        except Exception as e:
            logger.warning(f"YTMusic playlist fetch failed: {e}. Falling back to yt-dlp...")
            try:
                return await asyncio.to_thread(fetch_youtube_playlist_ytdlp, playlist_id)
            except Exception as e2:
                logger.error(f"yt-dlp playlist fetch failed: {e2}")
                raise HTTPException(status_code=500, detail=f"Failed to fetch YouTube playlist: {e2}")
                
    elif selected_provider == "spotify":
        try:
            spotify_data = await asyncio.to_thread(fetch_spotify_playlist, playlist_id)
            
            def search_single(track_info):
                q = f"{track_info['title']} {track_info['artist']}".strip()
                try:
                    res = search_music(q, filter_type='songs')
                    return res[0] if res else None
                except Exception:
                    return None
            
            async def resolve_one(track_info):
                return await asyncio.to_thread(search_single, track_info)
                
            tasks = [resolve_one(t) for t in spotify_data["tracks"]]
            results = await asyncio.gather(*tasks)
            resolved_tracks = [r for r in results if r]
            
            return {
                "title": spotify_data["title"],
                "playlistId": playlist_id,
                "tracks": resolved_tracks
            }
        except Exception as e:
            logger.error(f"Spotify playlist resolution failed: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to resolve Spotify playlist: {e}")
            
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported provider: {selected_provider}")

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

# --- SECURE HASHING & DATABASE INITIALIZATION ---
DB_DIR = "backend_db"
DB_FILE = os.path.join(DB_DIR, "broadcasts.json")

if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)

JWT_SECRET = os.environ.get("AURA_JWT_SECRET")
if not JWT_SECRET:
    JWT_SECRET = secrets.token_hex(32)
    logger.warning("AURA_JWT_SECRET environment variable not set! Using a transient random key for JWT signing. Admin sessions will invalidate on restart.")

def generate_password_hash(password: str) -> str:
    # PBKDF2-HMAC-SHA256 with 600,000+ iterations, 16-byte salt from secrets
    salt = secrets.token_bytes(16)
    iterations = 600000
    key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations)
    return f"pbkdf2:sha256:{iterations}${salt.hex()}${key.hex()}"

def check_password_hash(hash_str: str, password: str) -> bool:
    try:
        parts = hash_str.split('$')
        if len(parts) != 3:
            return False
        algo_iter, salt_hex, key_hex = parts
        algo_parts = algo_iter.split(':')
        if len(algo_parts) == 3:
            algo, subalgo, iterations = algo_parts
            if algo != 'pbkdf2' or subalgo != 'sha256':
                return False
        elif len(algo_parts) == 2:
            algo_sub, iterations = algo_parts
            if algo_sub != 'pbkdf2:sha256':
                return False
        else:
            return False
        iterations = int(iterations)
        salt = bytes.fromhex(salt_hex)
        key = bytes.fromhex(key_hex)
        new_key = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations)
        return hmac.compare_digest(key, new_key)
    except Exception:
        return False

def load_db() -> dict:
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"admin": {}, "broadcasts": []}

def save_db(data: dict):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def init_db():
    if not os.path.exists(DB_FILE):
        # Generate secure random 16-character default password
        initial_password = "".join(secrets.choice("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") for _ in range(16))
        print("\n" + "="*80)
        print(f"[ADMIN INITIALIZATION] Created admin account. Initial password: {initial_password}")
        print("Please log in and change your password immediately. Admin CRUD functions are locked until updated.")
        print("="*80 + "\n")
        logger.info(f"[ADMIN INITIALIZATION] Generated initial admin password: {initial_password}")
        
        db_data = {
            "admin": {
                "username_hash": generate_password_hash("admin"),
                "password_hash": generate_password_hash(initial_password),
                "is_default_password": True
            },
            "broadcasts": []
        }
        save_db(db_data)
    else:
        try:
            db_data = load_db()
            if "admin" not in db_data or "broadcasts" not in db_data:
                raise ValueError("Malformed DB")
        except Exception:
            logger.error("Error reading broadcasts.json database. Resetting credentials.")
            initial_password = "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(16))
            print("\n" + "="*80)
            print(f"[ADMIN RESET] Reset admin account. Password: {initial_password}")
            print("="*80 + "\n")
            db_data = {
                "admin": {
                    "username_hash": generate_password_hash("admin"),
                    "password_hash": generate_password_hash(initial_password),
                    "is_default_password": True
                },
                "broadcasts": []
            }
            save_db(db_data)

init_db()

# --- JWT UTILITIES ---
def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('utf-8').replace('=', '')

def base64url_decode(data: str) -> bytes:
    padding = '=' * (4 - (len(data) % 4))
    return base64.urlsafe_b64decode(data + padding)

def create_jwt_token(payload: dict, secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_json = json.dumps(header, separators=(',', ':')).encode('utf-8')
    payload_json = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    encoded_header = base64url_encode(header_json)
    encoded_payload = base64url_encode(payload_json)
    
    signing_input = f"{encoded_header}.{encoded_payload}".encode('utf-8')
    signature = hmac.new(secret.encode('utf-8'), signing_input, hashlib.sha256).digest()
    encoded_signature = base64url_encode(signature)
    return f"{encoded_header}.{encoded_payload}.{encoded_signature}"

def verify_jwt_token(token: str, secret: str) -> dict:
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None
        encoded_header, encoded_payload, encoded_signature = parts
        
        signing_input = f"{encoded_header}.{encoded_payload}".encode('utf-8')
        expected_signature = hmac.new(secret.encode('utf-8'), signing_input, hashlib.sha256).digest()
        expected_encoded_signature = base64url_encode(expected_signature)
        
        if not hmac.compare_digest(encoded_signature.encode('utf-8'), expected_encoded_signature.encode('utf-8')):
            return None
        
        payload_bytes = base64url_decode(encoded_payload)
        payload = json.loads(payload_bytes.decode('utf-8'))
        
        if 'exp' in payload and time.time() > payload['exp']:
            return None
        return payload
    except Exception:
        return None

# --- AUTH DEVIATION CHECKERS ---
async def get_current_admin_light(authorization: str = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authentication token")
    token = authorization.split(" ")[1]
    payload = verify_jwt_token(token, JWT_SECRET)
    if not payload or payload.get("sub") != "admin":
        raise HTTPException(status_code=401, detail="Session expired or invalid token")
    return payload

async def get_current_admin(authorization: str = Header(None)) -> dict:
    payload = await get_current_admin_light(authorization)
    db = load_db()
    if db.get("admin", {}).get("is_default_password", True):
        raise HTTPException(status_code=403, detail="Default password must be changed before accessing admin functions")
    return payload

# --- BROADCAST & ADMIN CONTROLLER ROUTES ---
@app.get("/api/broadcasts")
def get_broadcasts():
    db = load_db()
    now = datetime.utcnow()
    active = []
    for b in db.get("broadcasts", []):
        if not b.get("enabled", True):
            continue
        exp_str = b.get("expires_at")
        if exp_str:
            try:
                clean_str = exp_str.replace("Z", "")
                if "+" in clean_str:
                    clean_str = clean_str.split("+")[0]
                expiry_dt = datetime.fromisoformat(clean_str)
                if now > expiry_dt:
                    continue
            except Exception:
                pass
        active.append(b)
    return {
        "server_version": "1.3",
        "broadcasts": active
    }

@app.post("/api/admin/login")
@limiter.limit("5/minute")
async def admin_login(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request payload")
        
    username = body.get("username")
    password = body.get("password")
    
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required")
        
    db = load_db()
    admin_data = db.get("admin", {})
    
    stored_user_hash = admin_data.get("username_hash")
    stored_pass_hash = admin_data.get("password_hash")
    
    if not check_password_hash(stored_user_hash, username) or not check_password_hash(stored_pass_hash, password):
        raise HTTPException(status_code=401, detail="Invalid username or password")
        
    payload = {
        "sub": "admin",
        "exp": time.time() + 7200 # 2 hours duration
    }
    token = create_jwt_token(payload, JWT_SECRET)
    return {
        "token": token,
        "is_default_password": admin_data.get("is_default_password", True)
    }

@app.post("/api/admin/change-password")
async def change_password(request: Request, authorization: str = Header(None)):
    await get_current_admin_light(authorization)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request payload")
        
    new_password = body.get("new_password")
    if not new_password or len(new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters long")
        
    db = load_db()
    db["admin"]["password_hash"] = generate_password_hash(new_password)
    db["admin"]["is_default_password"] = False
    save_db(db)
    return {"status": "success", "message": "Password changed successfully"}

@app.post("/api/admin/broadcasts")
async def create_broadcast(request: Request, authorization: str = Header(None)):
    await get_current_admin(authorization)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request payload")
        
    title = body.get("title")
    message = body.get("message")
    if not title or not message:
        raise HTTPException(status_code=400, detail="Title and message are required")
        
    broadcast_id = secrets.token_hex(4)
    
    new_broadcast = {
        "id": broadcast_id,
        "title": title,
        "message": message,
        "backend_url": body.get("backend_url"),
        "button_text": body.get("button_text"),
        "button_url": body.get("button_url"),
        "created_at": datetime.utcnow().isoformat() + "Z",
        "expires_at": body.get("expires_at"),
        "enabled": body.get("enabled", True)
    }
    
    db = load_db()
    db["broadcasts"].append(new_broadcast)
    save_db(db)
    return {"status": "created", "id": broadcast_id}

@app.put("/api/admin/broadcasts/{id}")
async def update_broadcast(id: str, request: Request, authorization: str = Header(None)):
    await get_current_admin(authorization)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request payload")
        
    db = load_db()
    found_idx = -1
    for idx, b in enumerate(db.get("broadcasts", [])):
        if b.get("id") == id:
            found_idx = idx
            break
            
    if found_idx == -1:
        raise HTTPException(status_code=404, detail="Broadcast not found")
        
    b = db["broadcasts"][found_idx]
    b["title"] = body.get("title", b["title"])
    b["message"] = body.get("message", b["message"])
    b["backend_url"] = body.get("backend_url", b.get("backend_url"))
    b["button_text"] = body.get("button_text", b.get("button_text"))
    b["button_url"] = body.get("button_url", b.get("button_url"))
    b["expires_at"] = body.get("expires_at", b.get("expires_at"))
    b["enabled"] = body.get("enabled", b.get("enabled", True))
    
    save_db(db)
    return {"status": "updated"}

@app.delete("/api/admin/broadcasts/{id}")
async def delete_broadcast(id: str, authorization: str = Header(None)):
    await get_current_admin(authorization)
    db = load_db()
    found_idx = -1
    for idx, b in enumerate(db.get("broadcasts", [])):
        if b.get("id") == id:
            found_idx = idx
            break
            
    if found_idx == -1:
        raise HTTPException(status_code=404, detail="Broadcast not found")
        
    db["broadcasts"].pop(found_idx)
    save_db(db)
    return {"status": "deleted"}

os.makedirs("static/css", exist_ok=True)
os.makedirs("static/js", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port)
