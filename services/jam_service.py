import time
import json
import logging
import asyncio
from typing import Dict, List, Any
from fastapi import WebSocket

logger = logging.getLogger(__name__)

class JamRoom:
    def __init__(self, room_code: str, host_username: str):
        self.room_code = room_code
        self.host_username = host_username
        self.active_connections: Dict[str, WebSocket] = {}
        self.roles: Dict[str, str] = {host_username: "host"}
        self.current_track: Dict[str, Any] = {}
        self.playback_state = "PAUSED"
        self.playback_time = 0.0
        self.last_updated = time.time()
        self.queue: List[Dict[str, Any]] = []
        self.chat_history: List[Dict[str, Any]] = []
        self.host_explicitly_left = False
        self.host_pending_reconnect = False
        self.grace_period_task = None
        self.add_only_mode = False
        self.manual_order = False
        self.ws_locks: Dict[WebSocket, asyncio.Lock] = {}
        self.reaction_times: Dict[str, List[float]] = {}

    def get_role(self, username: str) -> str:
        for k, v in self.roles.items():
            if k.lower() == username.lower():
                return v
        return "listener"

    def has_permission(self, username: str, action: str) -> bool:
        role = self.get_role(username)
        if role == "host":
            return True
        if role == "co-host":
            return action in ["control_playback", "add_queue", "remove_queue"]
        if role == "moderator":
            return action in ["add_queue", "remove_queue"]
        if role == "contributor":
            return action in ["add_queue"]
        if role == "listener":
            if self.add_only_mode:
                return action == "add_queue"
            return False
        return False

    async def toggle_add_only_mode(self, username: str, enabled: bool):
        if username.lower() == self.host_username.lower():
            self.add_only_mode = bool(enabled)
            await self.broadcast_state()

    async def connect(self, username: str, websocket: WebSocket):
        active_username_match = None
        for k in self.active_connections.keys():
            if k.lower() == username.lower():
                active_username_match = k
                break
                
        if active_username_match:
            old_ws = self.active_connections[active_username_match]
            from starlette.websockets import WebSocketState
            is_disconnected = False
            try:
                if old_ws.client_state == WebSocketState.DISCONNECTED or old_ws.application_state == WebSocketState.DISCONNECTED:
                    is_disconnected = True
            except Exception:
                is_disconnected = True
                
            if is_disconnected:
                del self.active_connections[active_username_match]
            else:
                # Must accept first, then close — otherwise the custom close code never reaches the browser
                await websocket.accept()
                try:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "code": 4001,
                        "reason": "Username already taken"
                    }))
                except Exception:
                    pass
                await websocket.close(code=4001, reason="Username already taken")
                return False
        await websocket.accept()
        self.active_connections[username] = websocket
        
        has_role = False
        for k in self.roles.keys():
            if k.lower() == username.lower():
                has_role = True
                break
        if not has_role:
            self.roles[username] = "listener"
        
        # Send initial chat history directly to the newly connected user only!
        try:
            await self.send_to_ws(websocket, json.dumps({
                "type": "chat_history",
                "history": self.chat_history
            }))
        except Exception:
            pass
        
        # If the host reconnects, cancel the grace period timer
        if username.lower() == self.host_username.lower():
            if self.host_pending_reconnect:
                self.host_pending_reconnect = False
                if self.grace_period_task:
                    self.grace_period_task.cancel()
                    self.grace_period_task = None
                await self.broadcast({
                    "type": "host_back"
                })
                await self.add_chat_msg("System", f"Host ({username}) reconnected!", msg_type="system")
            else:
                await self.add_chat_msg("System", f"{username} joined the Jam party!", msg_type="system")
        else:
            await self.add_chat_msg("System", f"{username} joined the Jam party!", msg_type="system")

        await self.broadcast_state()
        return True

    async def disconnect(self, username: str, websocket: WebSocket = None):
        target_username = None
        for k in self.active_connections.keys():
            if k.lower() == username.lower():
                target_username = k
                break
                
        if target_username:
            if websocket is not None and self.active_connections[target_username] != websocket:
                return
            ws = self.active_connections[target_username]
            del self.active_connections[target_username]
            if ws in self.ws_locks:
                del self.ws_locks[ws]
            
        if username.lower() == self.host_username.lower():
            if self.host_explicitly_left:
                await self.destroy_room("host_left")
                return
            else:
                # Host dropped unexpectedly
                if len(self.active_connections) == 0:
                    await self.destroy_room("host_left")
                    return
                else:
                    self.host_pending_reconnect = True
                    await self.broadcast({
                        "type": "host_reconnecting"
                    })
                    await self.add_chat_msg("System", f"Host ({username}) disconnected. Waiting 30s to reconnect...", msg_type="system")
                    self.grace_period_task = asyncio.create_task(self.run_host_grace_period(30.0))
                    return

        # Non-host disconnection
        if len(self.active_connections) == 0:
            # If no users remain, clean up the room
            if self.grace_period_task:
                self.grace_period_task.cancel()
                self.grace_period_task = None
            if self.room_code in rooms:
                del rooms[self.room_code]
            return

        await self.add_chat_msg("System", f"{username} left the Jam party.", msg_type="system")
        await self.broadcast_state()

    async def run_host_grace_period(self, duration: float):
        try:
            await asyncio.sleep(duration)
            await self.destroy_room("host_left")
        except asyncio.CancelledError:
            pass

    async def destroy_room(self, reason: str):
        if self.grace_period_task:
            self.grace_period_task.cancel()
            self.grace_period_task = None
            
        close_msg = json.dumps({
            "type": "room_closed",
            "reason": reason
        })
        
        connections = list(self.active_connections.items())
        for user, ws in connections:
            try:
                await self.send_to_ws(ws, close_msg)
                await ws.close(code=1000, reason="Host left the session")
            except Exception:
                pass
            if ws in self.ws_locks:
                del self.ws_locks[ws]
                
        self.active_connections.clear()
        self.ws_locks.clear()
        if self.room_code in rooms:
            del rooms[self.room_code]

    async def close_room(self, username: str):
        if username.lower() == self.host_username.lower():
            self.host_explicitly_left = True
            await self.destroy_room("host_left")

    async def handle_heartbeat_sync(self, username: str, video_id: str, position: float):
        if username.lower() != self.host_username.lower():
            return
        self.playback_time = float(position)
        self.playback_state = "PLAYING"
        self.last_updated = time.time()
        # Broadcast standard playback_sync to all other clients
        await self.broadcast({
            "type": "playback_sync",
            "video_id": video_id,
            "state": self.playback_state,
            "position": self.playback_time,
            "track": self.current_track,
            "server_time": time.time() * 1000,
            "sender": username
        })

    def get_current_position(self) -> float:
        if self.playback_state == "PLAYING" and self.current_track:
            elapsed = time.time() - self.last_updated
            total_duration = self.current_track.get("durationSeconds", 300)
            return min(self.playback_time + elapsed, float(total_duration))
        return self.playback_time

    async def update_playback(self, username: str, video_id: str, state: str, position: float, track_data: Dict[str, Any] = None):
        if not self.has_permission(username, "control_playback"):
            return
        self.playback_state = state
        self.playback_time = float(position)
        self.last_updated = time.time()
        if track_data:
            self.current_track = track_data
        elif video_id and (not self.current_track or self.current_track.get("id") != video_id):
            self.current_track = {"id": video_id}
        await self.broadcast({
            "type": "playback_sync",
            "video_id": video_id,
            "state": self.playback_state,
            "position": self.playback_time,
            "track": self.current_track,
            "server_time": time.time() * 1000,
            "sender": username
        })

    async def add_to_queue(self, username: str, song: Dict[str, Any]):
        if not self.has_permission(username, "add_queue"):
            return
        if any(item["id"] == song["id"] for item in self.queue):
            return
        queue_item = {
            "id": song["id"],
            "title": song["title"],
            "artist": song["artist"],
            "thumbnail": song.get("thumbnail", ""),
            "duration": song.get("duration", ""),
            "durationSeconds": song.get("durationSeconds", 0),
            "submitted_by": username
        }
        self.queue.append(queue_item)
        await self.add_chat_msg("System", f"{username} added '{song['title']}' to queue.", msg_type="system")
        await self.broadcast_state()


    async def remove_from_queue(self, username: str, song_id: str):
        if not self.has_permission(username, "remove_queue"):
            if not self.add_only_mode and self.get_role(username) == "listener":
                return
            own_song = False
            for item in self.queue:
                if item["id"] == song_id and item["submitted_by"] == username:
                    own_song = True
                    break
            if not own_song:
                return
        self.queue = [item for item in self.queue if item["id"] != song_id]
        if len(self.queue) == 0:
            self.manual_order = False
        await self.broadcast_state()


    async def reorder_queue(self, username: str, queue_ids: List[str]):
        if not self.has_permission(username, "control_playback"):
            return
        self.manual_order = True
        id_to_item = {item["id"]: item for item in self.queue}
        new_queue = []
        for q_id in queue_ids:
            if q_id in id_to_item:
                new_queue.append(id_to_item[q_id])
        for item in self.queue:
            if item["id"] not in queue_ids:
                new_queue.append(item)
        self.queue = new_queue
        await self.broadcast_state()

    async def skip_to_next(self, username: str):
        if not self.has_permission(username, "control_playback"):
            return
        if self.queue:
            current_id = self.current_track.get("id") if self.current_track else None
            next_index = 0
            if current_id:
                for idx, item in enumerate(self.queue):
                    if item["id"] == current_id:
                        next_index = idx + 1
                        break
            if next_index < len(self.queue):
                next_song = self.queue[next_index]
                self.current_track = next_song
                self.playback_state = "PLAYING"
                self.playback_time = 0.0
                self.last_updated = time.time()
                await self.add_chat_msg("System", f"Playing next queued track: '{next_song['title']}'", msg_type="system")
                await self.broadcast({
                    "type": "playback_sync",
                    "video_id": next_song["id"],
                    "state": "PLAYING",
                    "position": 0.0,
                    "track": self.current_track,
                    "server_time": time.time() * 1000,
                    "sender": username
                })
                await self.broadcast_state()
            else:
                self.playback_state = "PAUSED"
                self.playback_time = 0.0
                self.last_updated = time.time()
                await self.broadcast({
                    "type": "playback_sync",
                    "video_id": "",
                    "state": "PAUSED",
                    "position": 0.0,
                    "track": {},
                    "server_time": time.time() * 1000,
                    "sender": username
                })
                await self.broadcast_state()
        else:
            self.playback_state = "PAUSED"
            self.playback_time = 0.0
            self.last_updated = time.time()
            await self.broadcast({
                "type": "playback_sync",
                "video_id": "",
                "state": "PAUSED",
                "position": 0.0,
                "track": {},
                "server_time": time.time() * 1000,
                "sender": username
            })

    async def skip_to_prev(self, username: str):
        if not self.has_permission(username, "control_playback"):
            return
        if self.queue:
            current_id = self.current_track.get("id") if self.current_track else None
            prev_index = len(self.queue) - 1  # Default to last track (wrap around)
            if current_id:
                for idx, item in enumerate(self.queue):
                    if item["id"] == current_id:
                        prev_index = idx - 1
                        break
            if prev_index < 0:
                prev_index = len(self.queue) - 1  # Wrap to last song
            prev_song = self.queue[prev_index]
            self.current_track = prev_song
            self.playback_state = "PLAYING"
            self.playback_time = 0.0
            self.last_updated = time.time()
            await self.add_chat_msg("System", f"Playing previous track: '{prev_song['title']}'", msg_type="system")
            await self.broadcast({
                "type": "playback_sync",
                "video_id": prev_song["id"],
                "state": "PLAYING",
                "position": 0.0,
                "track": self.current_track,
                "server_time": time.time() * 1000,
                "sender": username
            })
            await self.broadcast_state()

    async def add_chat_msg(self, username: str, text: str, msg_type: str = "chat"):
        truncated_text = text[:500] if text else ""
        msg = {
            "username": username,
            "message": truncated_text,
            "time": time.strftime("%H:%M"),
            "type": msg_type
        }
        self.chat_history.append(msg)
        if len(self.chat_history) > 100:
            self.chat_history.pop(0)
        await self.broadcast({
            "type": "chat_message",
            "message": msg
        })

    async def trigger_reaction(self, username: str, emoji: str):
        now = time.time()
        times = self.reaction_times.setdefault(username, [])
        times = [t for t in times if now - t < 3.0]
        if len(times) >= 5:
            return
        times.append(now)
        self.reaction_times[username] = times

        await self.broadcast({
            "type": "reaction",
            "username": username,
            "emoji": emoji
        })

    async def set_user_role(self, host_username: str, target_user: str, new_role: str):
        if host_username.lower() != self.host_username.lower():
            return
        # Find connection target case-insensitively
        target_username = None
        for k in self.active_connections.keys():
            if k.lower() == target_user.lower():
                target_username = k
                break
                
        if not target_username:
            return
        if new_role in ["host", "co-host", "moderator", "contributor", "listener"]:
            if new_role == "host":
                self.roles[self.host_username] = "co-host"
                self.host_username = target_username
                self.roles[target_username] = "host"
                await self.add_chat_msg("System", f"{target_username} is now the Host. {host_username} has been changed to co-host.", msg_type="system")
            else:
                self.roles[target_username] = new_role
                await self.add_chat_msg("System", f"{target_username}'s role has been set to {new_role}.", msg_type="system")
            await self.broadcast_state()

    def get_room_state_dict(self):
        serialized_queue = []
        for item in self.queue:
            serialized_queue.append({
                "id": item["id"],
                "title": item["title"],
                "artist": item["artist"],
                "thumbnail": item["thumbnail"],
                "duration": item["duration"],
                "durationSeconds": item["durationSeconds"],
                "submitted_by": item["submitted_by"]
            })
        users_list = []
        for user in self.active_connections.keys():
            users_list.append({
                "username": user,
                "role": self.get_role(user),
                "is_host": user.lower() == self.host_username.lower()
            })
        return {
            "room_code": self.room_code,
            "host_username": self.host_username,
            "add_only_mode": self.add_only_mode,
            "users": users_list,
            "playback": {
                "state": self.playback_state,
                "position": self.get_current_position(),
                "last_updated": self.last_updated,
                "current_track": self.current_track
            },
            "queue": serialized_queue
        }

    async def send_to_ws(self, ws: WebSocket, message_str: str):
        if ws not in self.ws_locks:
            self.ws_locks[ws] = asyncio.Lock()
        async with self.ws_locks[ws]:
            await ws.send_text(message_str)

    async def broadcast_state(self):
        state = self.get_room_state_dict()
        await self.broadcast({
            "type": "room_state",
            "state": state,
            "server_time": time.time() * 1000
        })

    async def broadcast(self, message: dict):
        message_str = json.dumps(message)
        disconnected_users = []
        for username, ws in list(self.active_connections.items()):
            try:
                await self.send_to_ws(ws, message_str)
            except Exception:
                disconnected_users.append((username, ws))
        for username, ws in disconnected_users:
            await self.disconnect(username, ws)

rooms: Dict[str, JamRoom] = {}

def create_room(room_code: str, host_username: str) -> JamRoom:
    code = room_code.upper().strip()
    if code in rooms:
        return rooms[code]
    room = JamRoom(code, host_username)
    rooms[code] = room
    return room

def get_room(room_code: str) -> JamRoom:
    return rooms.get(room_code.upper().strip())
