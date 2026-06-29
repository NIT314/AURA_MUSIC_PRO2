import random
import math
import json
import logging
import time
import asyncio
from typing import Dict, List, Any
from services.music_service import search_music, get_related_tracks

logger = logging.getLogger(__name__)

MOOD_QUERIES = {
    "happy": ["happy pop hits", "upbeat feel good songs", "happy morning vibe"],
    "sad": ["sad emotional hindi songs", "sad acoustic breakup songs", "lofi sad tracks"],
    "workout": ["gym workout phonk motivation", "high energy workout playlist", "edm workout beat"],
    "sleep": ["lofi sleep music", "deep sleep ambient rainfall", "peaceful sleep piano"],
    "romantic": ["romantic hindi love songs", "acoustic romantic ballads", "slow pop love hits"],
    "rain": ["rainy day chill music", "lofi rain sounds", "acoustic rainy day"],
    "chill": ["chill lofi beats", "relaxed acoustic soft pop", "calm ambient lounge vibes"],
    "energy": ["high energy upbeat pop", "motivational electro dance", "groovy electronic hits"],
    "focus": ["focus study lofi beats", "classical piano for concentration", "deep focus instrumental synth"],
    "melancholy": ["melancholy atmospheric indie", "introspective reflective piano", "moody ambient slow pop"],
    "hype": ["hype aggressive trap hip hop", "high intensity rap pump up", "energetic electronic trap beats"],
    "late_night": ["midnight lofi nocturnes", "dark moody ambient slow hits", "late night highway driving tracks"],
    "morning": ["fresh optimistic morning acoustic", "sunny day wake up pop", "gentle bright morning acoustic guitar"],
    "study": ["study session calm piano", "relaxing acoustic instrumental background", "ambient acoustic guitar study vibe"],
    "rainy_coffee": ["rainy day cafe jazz", "cozy coffee shop jazz instrumental", "soft cafe piano and rain beats"],
    "confidence": ["bold main character energy hits", "empowerment pop self confidence anthems", "confident upbeat rap strut music"],
    "heartbreak": ["sad heartbreak breakup songs", "crying breakup emotional ballads", "breakup pain lofi emotional beats"],
    "calm_anxiety": ["anxiety relief relaxing ambient", "deeply soothing slow breathing tracks", "calming slow tempo soft ambient"],
    "lonely": ["lonely isolated introspective acoustic", "solitude late night slow indie", "lonely feeling atmospheric ambient"],
    "sufi": ["sufi qawwali devotional hits", "mystical sufi fusion tracks", "soulful sufi love songs"],
    "summer": ["bright summer beach pop", "breezy tropical house summer hits", "upbeat summer roadtrip playlist"],
    "winter": ["cozy winter fireplace acoustic", "warm slow winter acoustic guitar", "chilly winter evening soft piano"]
}

AI_DJ_PHRASES = [
    "Here is a selection tuned to your current listening rhythm.",
    "Based on your recent hits, I think you'll vibe with this track.",
    "Transitioning into some acoustic grooves for the perfect aura.",
    "Keeping the energy levels high with this next mix.",
    "Time to slow down and relax with some chill ambient melodies.",
    "A legendary track that matches your listening mood."
]

# Simple in-memory cache for watch playlist fetches to prevent YTMusic API rate limits
_WATCH_PLAYLIST_CACHE = {}
CACHE_EXPIRY_SECONDS = 300  # 5 minutes cache TTL

def _cached_get_related_tracks(video_id: str) -> List[Dict[str, Any]]:
    now = time.time()
    if video_id in _WATCH_PLAYLIST_CACHE:
        cached_data, timestamp = _WATCH_PLAYLIST_CACHE[video_id]
        if now - timestamp < CACHE_EXPIRY_SECONDS:
            logger.info(f"Cache HIT for watch playlist of track {video_id}")
            return cached_data
    
    logger.info(f"Cache MISS for watch playlist of track {video_id}, querying YTMusic...")
    tracks = get_related_tracks(video_id)
    _WATCH_PLAYLIST_CACHE[video_id] = (tracks, now)
    return tracks

async def _fetch_all_seeds_async(seeds: List[str]) -> List[List[Dict[str, Any]]]:
    # Run synchronous watch playlist calls concurrently in worker threads
    tasks = [asyncio.to_thread(_cached_get_related_tracks, seed_id) for seed_id in seeds]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    combined = []
    for r in results:
        if isinstance(r, list):
            combined.append(r)
        else:
            logger.error(f"Error fetching watch playlist seed: {r}")
    return combined

class TasteProfile:
    def __init__(self, current_video_id: str = None, session_history: list = None, global_history: list = None, skipped_tracks: list = None, excluded_tracks: list = None):
        self.current_video_id = current_video_id or ""
        self.session_history = session_history or []
        self.global_history = global_history or []
        self.skipped_tracks = set(skipped_tracks or [])
        self.excluded_tracks = set(excluded_tracks or [])
        
        self.track_weights = {}
        self.artist_affinity = {}
        
        self._build_profile()

    def _build_profile(self):
        decay_factor = 0.15
        
        # Process Session History (70% weight baseline)
        for idx, item in enumerate(self.session_history):
            track_id = item.get("id") if isinstance(item, dict) else item
            artist_id = item.get("artistId") if isinstance(item, dict) else None
            
            if not track_id or track_id in self.skipped_tracks or track_id in self.excluded_tracks:
                continue
                
            weight = 1.0 * math.exp(-decay_factor * idx)
            self.track_weights[track_id] = self.track_weights.get(track_id, 0.0) + weight
            
            if artist_id:
                self.artist_affinity[artist_id] = self.artist_affinity.get(artist_id, 0.0) + weight

        # Process Global History (30% weight baseline)
        for idx, item in enumerate(self.global_history):
            track_id = item.get("id") if isinstance(item, dict) else item
            artist_id = item.get("artistId") if isinstance(item, dict) else None
            
            if not track_id or track_id in self.skipped_tracks or track_id in self.excluded_tracks:
                continue
                
            weight = 0.43 * math.exp(-decay_factor * idx)
            self.track_weights[track_id] = self.track_weights.get(track_id, 0.0) + weight
            
            if artist_id:
                self.artist_affinity[artist_id] = self.artist_affinity.get(artist_id, 0.0) + weight

    def get_seeds(self) -> List[str]:
        seeds = []
        if self.current_video_id and self.current_video_id not in self.skipped_tracks and self.current_video_id not in self.excluded_tracks:
            seeds.append(self.current_video_id)
            
        # Get most recent session track (different from current)
        for item in self.session_history:
            tid = item.get("id") if isinstance(item, dict) else item
            if tid and tid != self.current_video_id and tid not in self.skipped_tracks and tid not in self.excluded_tracks:
                seeds.append(tid)
                break
                
        # Get highest weight track (excluding already selected seeds)
        highest_weight_tid = None
        highest_weight = -1.0
        for tid, weight in self.track_weights.items():
            if tid not in seeds and tid not in self.skipped_tracks and tid not in self.excluded_tracks:
                if weight > highest_weight:
                    highest_weight = weight
                    highest_weight_tid = tid
        if highest_weight_tid:
            seeds.append(highest_weight_tid)
            
        # If still short of seeds, populate from global history
        for item in self.global_history:
            if len(seeds) >= 3:
                break
            tid = item.get("id") if isinstance(item, dict) else item
            if tid and tid not in seeds and tid not in self.skipped_tracks and tid not in self.excluded_tracks:
                seeds.append(tid)
                
        return seeds[:3]

    def get_top_artists(self, limit=3) -> List[str]:
        sorted_artists = sorted(self.artist_affinity.items(), key=lambda x: x[1], reverse=True)
        return [artist_id for artist_id, weight in sorted_artists if artist_id][:limit]

def get_mood_playlist(mood: str):
    mood_key = mood.lower().strip()
    queries = MOOD_QUERIES.get(mood_key, ["chill vibes"])
    selected_query = random.choice(queries)
    results = search_music(selected_query, filter_type="songs")
    return results[:25]

async def get_ai_recommendations(history_ids: list, current_video_id: str = None, profile_json: str = None):
    profile = None
    if profile_json:
        try:
            data = json.loads(profile_json)
            profile = TasteProfile(
                current_video_id=data.get("current_video_id") or current_video_id,
                session_history=data.get("session_history") or [],
                global_history=data.get("global_history") or [],
                skipped_tracks=data.get("skipped_tracks") or [],
                excluded_tracks=data.get("excluded_tracks") or []
            )
        except Exception as e:
            logger.warning(f"Failed to parse profile JSON: {e}. Falling back to default.")
            
    if not profile:
        profile = TasteProfile(
            current_video_id=current_video_id,
            session_history=history_ids,
            global_history=history_ids,
            skipped_tracks=[],
            excluded_tracks=[]
        )
        
    try:
        seeds = profile.get_seeds()
        if not seeds:
            results = search_music("trending global hits", filter_type="songs")[:15]
            for track in results:
                track["ai_reason"] = random.choice(AI_DJ_PHRASES)
            return results
            
        # Fetch related playlists concurrently
        combined_results = await _fetch_all_seeds_async(seeds)
        
        candidates = {}
        for track_list in combined_results:
            for track in track_list:
                if not track or "id" not in track:
                    continue
                candidates[track["id"]] = track
                
        # Fetch top artists' music if candidate pool is small
        if len(candidates) < 20:
            top_artists = profile.get_top_artists(limit=2)
            if top_artists:
                artist_search_tasks = [
                    asyncio.to_thread(search_music, f"artist:{artist_id}" if artist_id.startswith("UC") else f"{artist_id}", "songs")
                    for artist_id in top_artists
                ]
                artist_results = await asyncio.gather(*artist_search_tasks, return_exceptions=True)
                for r in artist_results:
                    if isinstance(r, list):
                        for track in r:
                            if track and "id" in track and track["id"] not in candidates:
                                candidates[track["id"]] = track
                                
        scored_candidates = []
        session_ids = { (item.get("id") if isinstance(item, dict) else item) for item in profile.session_history }
        global_ids = { (item.get("id") if isinstance(item, dict) else item) for item in profile.global_history }
        
        for track_id, track in candidates.items():
            # Filters
            if track_id in profile.skipped_tracks or track_id in profile.excluded_tracks:
                continue
            if track_id in session_ids:
                continue  # Avoid repeats in current session
                
            # Scoring
            score = 1.0
            artist_id = track.get("artistId")
            
            # Artist Affinity bonus
            if artist_id and artist_id in profile.artist_affinity:
                affinity = profile.artist_affinity[artist_id]
                score += affinity * 0.8
                
            # Familiarity penalty
            if track_id in global_ids:
                score *= 0.6  # Penalize to favor discovery
                
            scored_candidates.append((score, track))
            
        scored_candidates.sort(key=lambda x: x[0], reverse=True)
        
        final_recommendations = []
        artist_counts = {}
        
        for score, track in scored_candidates:
            artist_id = track.get("artistId") or track.get("artist") or "Unknown"
            
            # Enforce capping: Max 2 tracks per artist
            if artist_counts.get(artist_id, 0) >= 2:
                continue
                
            # Dynamic reason selection
            if artist_id != "Unknown" and artist_id in profile.artist_affinity:
                track["ai_reason"] = f"From your favorite artist: {track.get('artist')}."
            elif track.get("id") in global_ids:
                track["ai_reason"] = "A familiar favorite returning to your aura stream."
            else:
                track["ai_reason"] = random.choice(AI_DJ_PHRASES)
                
            final_recommendations.append(track)
            artist_counts[artist_id] = artist_counts.get(artist_id, 0) + 1
            
            if len(final_recommendations) >= 20:
                break
                
        if not final_recommendations:
            final_recommendations = search_music("trending global hits", filter_type="songs")[:15]
            for track in final_recommendations:
                track["ai_reason"] = random.choice(AI_DJ_PHRASES)
                
        return final_recommendations
        
    except Exception as e:
        logger.error(f"AI DJ taste overhaul pipeline failed: {e}")
        fallback = search_music("top billboard songs", filter_type="songs")[:10]
        for track in fallback:
            track["ai_reason"] = random.choice(AI_DJ_PHRASES)
        return fallback