package com.aura.music.pro2

import android.app.PendingIntent
import android.content.Intent
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.annotation.OptIn
import android.media.audiofx.Equalizer
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.Futures

class AuraPlaybackService : MediaSessionService() {

    private var exoPlayer: ExoPlayer? = null
    private var mediaSession: MediaSession? = null

    // Native Equalizer support
    private var equalizer: Equalizer? = null
    private val uiBandGains = FloatArray(10) { 0f }

    // For Capacitor plugin communication
    private val binder = LocalBinder()
    private var playbackListener: PlaybackListener? = null

    // Tracking current track metadata
    private var currentTrackId: String? = null
    private var currentPlayableUrl: String = ""
    private var currentTitle: String = ""
    private var currentArtist: String = ""
    private var currentArtworkUrl: String = ""

    // Periodic progress updates (every 500ms when playing)
    private val handler = Handler(Looper.getMainLooper())
    private val progressRunnable = object : Runnable {
        override fun run() {
            notifyPlaybackState()
            if (exoPlayer?.isPlaying == true) {
                handler.postDelayed(this, 500)
            }
        }
    }

    interface PlaybackListener {
        fun onStateChanged(
            isPlaying: Boolean,
            positionSec: Double,
            durationSec: Double,
            trackId: String?,
            error: String?,
            action: String? = null
        )
    }

    inner class LocalBinder : Binder() {
        fun getService(): AuraPlaybackService = this@AuraPlaybackService
    }

    override fun onBind(intent: Intent?): IBinder? {
        // If system bindings are requested for MediaSession, call parent
        if (intent?.action == "androidx.media3.session.MediaSessionService") {
            return super.onBind(intent)
        }
        // Return local binder for direct Capacitor plugin communication
        return binder
    }

    override fun onCreate() {
        super.onCreate()
        initializePlayer()
    }

    @OptIn(UnstableApi::class)
    private fun initializePlayer() {
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        exoPlayer = ExoPlayer.Builder(this)
            .setAudioAttributes(audioAttributes, true) // Handles audio focus automatically
            .setHandleAudioBecomingNoisy(true)        // Pauses automatically on headphone disconnect
            .build().apply {
                setWakeMode(C.WAKE_MODE_NETWORK)
                repeatMode = Player.REPEAT_MODE_OFF
                addListener(playerListener)
            }

        // Set up pending intent to open MainActivity when clicking notifications/lock screen
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        mediaSession = MediaSession.Builder(this, exoPlayer!!)
            .setSessionActivity(pendingIntent)
            .setCallback(mediaSessionCallback)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return mediaSession
    }

    // --- Media Controller & JavaScript Core Communication API ---

    fun setPlaybackListener(listener: PlaybackListener) {
        this.playbackListener = listener
    }

    fun play(url: String, title: String, artist: String, artworkUrl: String?, trackId: String) {
        currentTrackId = trackId
        currentPlayableUrl = url
        currentTitle = title
        currentArtist = artist
        currentArtworkUrl = artworkUrl ?: ""

        // Set initial media metadata (uses app icon fallback)
        updatePlayerMediaItem(null)

        // Load network artwork image asynchronously in background thread
        if (!artworkUrl.isNullOrEmpty()) {
            loadArtworkBitmap(artworkUrl) { bitmap ->
                // Verify we are still on the same track when download completes
                if (trackId == currentTrackId) {
                    updatePlayerMediaItem(bitmap)
                }
            }
        }
    }

    private fun updatePlayerMediaItem(artworkBitmap: android.graphics.Bitmap?) {
        val metaBuilder = MediaMetadata.Builder()
            .setTitle(currentTitle)
            .setArtist(currentArtist)

        if (artworkBitmap != null) {
            metaBuilder.setArtworkData(
                bitmapToByteArray(artworkBitmap),
                MediaMetadata.PICTURE_TYPE_FRONT_COVER
            )
        }

        val mediaItem = MediaItem.Builder()
            .setUri(currentPlayableUrl)
            .setMediaId(currentTrackId ?: "")
            .setMediaMetadata(metaBuilder.build())
            .build()

        exoPlayer?.let { player ->
            val wasPlaying = player.isPlaying
            player.setMediaItem(mediaItem)
            player.prepare()
            player.play()
            
            // Start progress reporting
            handler.removeCallbacks(progressRunnable)
            handler.post(progressRunnable)
        }
    }

    fun pause() {
        exoPlayer?.pause()
        handler.removeCallbacks(progressRunnable)
    }

    fun resume() {
        exoPlayer?.play()
        handler.removeCallbacks(progressRunnable)
        handler.post(progressRunnable)
    }

    fun seek(positionSec: Double) {
        val positionMs = (positionSec * 1000).toLong()
        exoPlayer?.seekTo(positionMs)
        notifyPlaybackState()
    }

    fun stop() {
        exoPlayer?.stop()
        handler.removeCallbacks(progressRunnable)
        notifyPlaybackState()
    }

    fun next() {
        // Trigger queue next action back to JavaScript
        playbackListener?.onStateChanged(
            isPlaying = exoPlayer?.isPlaying == true,
            positionSec = getPositionSec(),
            durationSec = getDurationSec(),
            trackId = currentTrackId,
            error = null,
            action = "next"
        )
    }

    fun prev() {
        // Trigger queue prev action back to JavaScript
        playbackListener?.onStateChanged(
            isPlaying = exoPlayer?.isPlaying == true,
            positionSec = getPositionSec(),
            durationSec = getDurationSec(),
            trackId = currentTrackId,
            error = null,
            action = "prev"
        )
    }

    // --- Native Equalizer Implementation ---

    private fun setupEqualizer(sessionId: Int) {
        if (sessionId == 0) return
        try {
            equalizer?.release()
            equalizer = Equalizer(0, sessionId).apply {
                enabled = true
            }
            applyStoredEqualizerBands()
            android.util.Log.d("AuraPlayback", "Equalizer initialized successfully on audio session $sessionId")
        } catch (e: Exception) {
            android.util.Log.e("AuraPlayback", "Failed to initialize Equalizer: ${e.message}")
        }
    }

    private fun applyStoredEqualizerBands() {
        val eq = equalizer ?: return
        val numBands = eq.numberOfBands.toInt()
        if (numBands <= 0) return

        val range = eq.bandLevelRange
        val minLevel = range[0].toInt()
        val maxLevel = range[1].toInt()

        for (nativeBand in 0 until numBands) {
            val position = if (numBands > 1) nativeBand.toFloat() / (numBands - 1).toFloat() else 0f
            val uiIndexFloat = position * 9f
            val lowerIndex = kotlin.math.floor(uiIndexFloat.toDouble()).toInt()
            val upperIndex = kotlin.math.ceil(uiIndexFloat.toDouble()).toInt()
            val fraction = uiIndexFloat - lowerIndex

            val gainDb = if (lowerIndex == upperIndex) {
                uiBandGains[lowerIndex]
            } else {
                uiBandGains[lowerIndex] * (1f - fraction) + uiBandGains[upperIndex] * fraction
            }

            var millibels = (gainDb * 100f).toInt()
            if (millibels < minLevel) millibels = minLevel
            if (millibels > maxLevel) millibels = maxLevel

            try {
                eq.setBandLevel(nativeBand.toShort(), millibels.toShort())
            } catch (e: Exception) {
                android.util.Log.e("AuraPlayback", "Failed to set native band $nativeBand to $millibels: ${e.message}")
            }
        }
    }

    fun setEqBand(uiBandIndex: Int, gainDb: Float) {
        if (uiBandIndex in 0..9) {
            uiBandGains[uiBandIndex] = gainDb
            applyStoredEqualizerBands()
        }
    }

    // --- Helpers ---

    private fun getPositionSec(): Double {
        val pos = exoPlayer?.currentPosition ?: 0L
        return pos.toDouble() / 1000.0
    }

    private fun getDurationSec(): Double {
        val dur = exoPlayer?.duration ?: 0L
        return if (dur == C.TIME_UNSET || dur <= 0L) 0.0 else dur.toDouble() / 1000.0
    }

    private fun notifyPlaybackState() {
        val player = exoPlayer ?: return
        playbackListener?.onStateChanged(
            isPlaying = player.isPlaying,
            positionSec = getPositionSec(),
            durationSec = getDurationSec(),
            trackId = currentTrackId,
            error = null
        )
    }

    private fun bitmapToByteArray(bitmap: android.graphics.Bitmap): ByteArray {
        val stream = java.io.ByteArrayOutputStream()
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)
        return stream.toByteArray()
    }

    private fun loadArtworkBitmap(urlStr: String, callback: (android.graphics.Bitmap?) -> Unit) {
        Thread {
            try {
                val url = java.net.URL(urlStr)
                val connection = url.openConnection() as java.net.HttpURLConnection
                connection.doInput = true
                connection.connect()
                val input = connection.inputStream
                val bitmap = android.graphics.BitmapFactory.decodeStream(input)
                Handler(Looper.getMainLooper()).post {
                    callback(bitmap)
                }
            } catch (e: Exception) {
                Handler(Looper.getMainLooper()).post {
                    callback(null)
                }
            }
        }.start()
    }

    // --- ExoPlayer Event Listener ---

    private val playerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            notifyPlaybackState()
            if (isPlaying) {
                handler.removeCallbacks(progressRunnable)
                handler.post(progressRunnable)
            } else {
                handler.removeCallbacks(progressRunnable)
            }
        }
        override fun onAudioSessionIdChanged(audioSessionId: Int) {
            setupEqualizer(audioSessionId)
        }

        override fun onPlayerError(error: PlaybackException) {
            playbackListener?.onStateChanged(
                isPlaying = false,
                positionSec = getPositionSec(),
                durationSec = getDurationSec(),
                trackId = currentTrackId,
                error = error.localizedMessage
            )
        }

        override fun onPlaybackStateChanged(state: Int) {
            notifyPlaybackState()
            if (state == Player.STATE_ENDED) {
                // If a song finishes naturally, trigger next track via JS queue
                next()
            }
        }
    }

    // --- MediaSession Callback to override default skip/headset key behavior ---

    private val mediaSessionCallback = object : MediaSession.Callback {
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo
        ): MediaSession.ConnectionResult {
            // Explicitly enable seek to next and seek to previous player commands
            // so notification drawer next/prev buttons are shown and click events are active
            val connectionResult = super.onConnect(session, controller)
            val customPlayerCommands = connectionResult.availablePlayerCommands.buildUpon()
                .add(Player.COMMAND_SEEK_TO_NEXT)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                .build()
            return MediaSession.ConnectionResult.accept(
                connectionResult.availableSessionCommands,
                customPlayerCommands
            )
        }

        override fun onPlayerCommandRequest(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            playerCommand: Int
        ): Int {
            when (playerCommand) {
                Player.COMMAND_SEEK_TO_NEXT -> {
                    next()
                    return SessionResult.RESULT_INFO_SKIPPED
                }
                Player.COMMAND_SEEK_TO_PREVIOUS -> {
                    prev()
                    return SessionResult.RESULT_INFO_SKIPPED
                }
            }
            return super.onPlayerCommandRequest(session, controller, playerCommand)
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(progressRunnable)
        exoPlayer?.let { player ->
            player.removeListener(playerListener)
            player.release()
        }
        exoPlayer = null
        equalizer?.let {
            it.release()
        }
        equalizer = null
        mediaSession?.let { session ->
            session.release()
        }
        mediaSession = null
        super.onDestroy()
    }
}
