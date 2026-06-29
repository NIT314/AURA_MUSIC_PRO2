package com.aura.music.pro2

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AuraPlayerPlugin")
class AuraPlayerPlugin : Plugin() {

    private var playbackService: AuraPlaybackService? = null
    private var isBound = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as AuraPlaybackService.LocalBinder
            playbackService = binder.getService()
            isBound = true
            
            // Register state change listener
            playbackService?.setPlaybackListener(object : AuraPlaybackService.PlaybackListener {
                override fun onStateChanged(
                    isPlaying: Boolean,
                    positionSec: Double,
                    durationSec: Double,
                    trackId: String?,
                    error: String?,
                    action: String?
                ) {
                    val data = JSObject().apply {
                        put("isPlaying", isPlaying)
                        put("currentPosition", positionSec)
                        put("duration", durationSec)
                        put("trackId", trackId)
                        if (error != null) put("error", error)
                        if (action != null) put("action", action)
                    }
                    notifyListeners("onStateChange", data)
                }
            })
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            playbackService = null
            isBound = false
        }
    }

    override fun load() {
        super.load()
        bindPlaybackService()
    }

    private fun bindPlaybackService() {
        val intent = Intent(context, AuraPlaybackService::class.java)
        // Start service so it lives in the foreground even when unbound
        try {
            context.startService(intent)
        } catch (e: Exception) {
            // In Android 8.0+ starting foreground service directly might require startForegroundService,
            // but the service itself will call startForeground inside onStartCommand.
            // Under Capacitor context.startService is safe unless app is in background.
            context.startService(intent)
        }
        context.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val url = call.getString("url")
        val title = call.getString("title")
        val artist = call.getString("artist")
        val artwork = call.getString("artwork")
        val trackId = call.getString("trackId") ?: url

        if (url == null || title == null || artist == null) {
            call.reject("Missing required parameters: url, title, artist")
            return
        }

        if (isBound && playbackService != null) {
            playbackService?.play(url, title, artist, artwork, trackId)
            call.resolve()
        } else {
            bindPlaybackService()
            call.reject("Playback service is binding. Try again.")
        }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        if (isBound && playbackService != null) {
            playbackService?.pause()
            call.resolve()
        } else {
            call.reject("Playback service not bound")
        }
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        if (isBound && playbackService != null) {
            playbackService?.resume()
            call.resolve()
        } else {
            call.reject("Playback service not bound")
        }
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val position = call.getDouble("position")
        if (position == null) {
            call.reject("Missing position parameter")
            return
        }
        if (isBound && playbackService != null) {
            playbackService?.seek(position)
            call.resolve()
        } else {
            call.reject("Playback service not bound")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        if (isBound && playbackService != null) {
            playbackService?.stop()
            call.resolve()
        } else {
            call.reject("Playback service not bound")
        }
    }

    @PluginMethod
    fun next(call: PluginCall) {
        if (isBound && playbackService != null) {
            playbackService?.next()
            call.resolve()
        } else {
            call.reject("Playback service not bound")
        }
    }

    @PluginMethod
    fun prev(call: PluginCall) {
        if (isBound && playbackService != null) {
            playbackService?.prev()
            call.resolve()
        } else {
            call.reject("Playback service not bound")
        }
    }

    @PluginMethod
    fun setEqBand(call: PluginCall) {
        val bandIndex = call.getInt("bandIndex")
        val gainDb = call.getDouble("gainDb")?.toFloat()

        if (bandIndex == null || gainDb == null) {
            call.reject("Missing required parameters: bandIndex, gainDb")
            return
        }

        if (isBound && playbackService != null) {
            playbackService?.setEqBand(bandIndex, gainDb)
            call.resolve()
        } else {
            call.reject("Playback service not bound")
        }
    }

    override fun handleOnDestroy() {
        if (isBound) {
            context.unbindService(serviceConnection)
            isBound = false
        }
        super.handleOnDestroy()
    }
}
