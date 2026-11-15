package app.musike.android;

import android.content.Context;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.Cast;
import com.google.android.gms.cast.CastDevice;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaSeekOptions;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;
import java.net.InetAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Google Cast for the Android app (web/src/cast/android.ts). Devices are found with MediaRouter and listed in the
 * app's own picker; selecting one starts a Cast SDK session on the Default Media Receiver. Tracks are served to the
 * device by CastProxy. Everything that touches MediaRouter or the Cast SDK runs on the main thread.
 *
 * Events: "devices" { devices: [{ id, name, model }] }, "session" { connected, device?, volume?, muted? },
 * "status" { state, position, duration, idleReason? } and "error" { message } (a code the web app translates).
 */
@CapacitorPlugin(name = "MusikeCast")
public class MusikeCastPlugin extends Plugin {

    private static final String TAG = "MusikeCast";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final CastProxy proxy = new CastProxy();
    /** Socket work for the proxy stays off the main thread. */
    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private CastContext castContext;
    private MediaRouter router;
    private MediaRouteSelector selector;
    private boolean discovering;
    private PluginCall pendingConnect;
    private CastSession session;
    private RemoteMediaClient client;
    private WifiManager.WifiLock wifiLock;
    /** Stopping on purpose: the receiver closing is expected, not another app taking over. */
    private boolean ending;

    // --- setup

    @Override
    public void load() {
        try {
            CastContext.getSharedInstance(getContext(), Executors.newSingleThreadExecutor())
                .addOnSuccessListener(ctx -> main.post(() -> init(ctx)))
                .addOnFailureListener(e -> Log.w(TAG, "Cast unavailable (no Google Play services?)", e));
        } catch (Exception e) {
            Log.w(TAG, "Cast unavailable", e);
        }
    }

    private void init(CastContext ctx) {
        castContext = ctx;
        router = MediaRouter.getInstance(getContext());
        selector = ctx.getMergedSelector();
        ctx.getSessionManager().addSessionManagerListener(sessionListener, CastSession.class);
        // A session left from before (the app was restarted while casting): pick it up.
        CastSession current = ctx.getSessionManager().getCurrentCastSession();
        if (current != null && current.isConnected()) attach(current);
        if (discovering) router.addCallback(selector, routerCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY);
    }

    /** Runs on the main thread once the Cast SDK is ready, or rejects when it never will be. */
    private boolean ready(PluginCall call) {
        if (castContext != null) return true;
        if (call != null) call.reject("unavailable");
        return false;
    }

    // --- discovery

    private final MediaRouter.Callback routerCallback = new MediaRouter.Callback() {
        @Override
        public void onRouteAdded(@NonNull MediaRouter r, @NonNull MediaRouter.RouteInfo route) {
            publishDevices();
        }

        @Override
        public void onRouteRemoved(@NonNull MediaRouter r, @NonNull MediaRouter.RouteInfo route) {
            publishDevices();
        }

        @Override
        public void onRouteChanged(@NonNull MediaRouter r, @NonNull MediaRouter.RouteInfo route) {
            publishDevices();
        }
    };

    private boolean isCastRoute(MediaRouter.RouteInfo route) {
        return !route.isDefault() && !route.isBluetooth() && route.isEnabled() && route.matchesSelector(selector);
    }

    private void publishDevices() {
        if (router == null) return;
        JSArray list = new JSArray();
        for (MediaRouter.RouteInfo route : router.getRoutes()) {
            if (!isCastRoute(route)) continue;
            JSObject d = new JSObject();
            d.put("id", route.getId());
            d.put("name", route.getName());
            CastDevice device = CastDevice.getFromBundle(route.getExtras());
            String model = device != null ? device.getModelName() : route.getDescription();
            if (model != null) d.put("model", model);
            list.put(d);
        }
        JSObject event = new JSObject();
        event.put("devices", list);
        notifyListeners("devices", event);
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        main.post(() -> {
            discovering = true;
            if (router != null) {
                router.addCallback(selector, routerCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY);
                publishDevices();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        main.post(() -> {
            discovering = false;
            if (router != null) router.removeCallback(routerCallback);
            call.resolve();
        });
    }

    // --- session

    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("id", "");
        main.post(() -> {
            if (!ready(call)) return;
            MediaRouter.RouteInfo target = null;
            for (MediaRouter.RouteInfo route : router.getRoutes()) if (route.getId().equals(id)) target = route;
            if (target == null || !isCastRoute(target)) {
                call.reject("The device is no longer on the network.");
                return;
            }
            if (pendingConnect != null) pendingConnect.reject("cancelled");
            pendingConnect = call;
            // The Cast SDK starts the session when its route is selected (what Google's cast button does too).
            router.selectRoute(target);
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        main.post(() -> {
            ending = true;
            if (castContext != null) castContext.getSessionManager().endCurrentSession(true);
            detach();
            ending = false;
            call.resolve();
        });
    }

    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarted(@NonNull CastSession s, @NonNull String sessionId) {
            attach(s);
            if (pendingConnect != null) pendingConnect.resolve();
            pendingConnect = null;
        }

        @Override
        public void onSessionResumed(@NonNull CastSession s, boolean wasSuspended) {
            attach(s);
        }

        @Override
        public void onSessionStartFailed(@NonNull CastSession s, int error) {
            if (pendingConnect != null) pendingConnect.reject(CastStatusCodesText.of(error));
            pendingConnect = null;
        }

        @Override
        public void onSessionEnded(@NonNull CastSession s, int error) {
            boolean dropped = error != 0 && session != null;
            detach();
            if (dropped) error("lost");
        }

        @Override
        public void onSessionSuspended(@NonNull CastSession s, int reason) {}

        @Override
        public void onSessionStarting(@NonNull CastSession s) {}

        @Override
        public void onSessionEnding(@NonNull CastSession s) {}

        @Override
        public void onSessionResuming(@NonNull CastSession s, @NonNull String sessionId) {}

        @Override
        public void onSessionResumeFailed(@NonNull CastSession s, int error) {}
    };

    private final Cast.Listener castListener = new Cast.Listener() {
        @Override
        public void onVolumeChanged() {
            publishSession();
        }

        @Override
        public void onApplicationDisconnected(int statusCode) {
            boolean expected = ending || session == null;
            detach();
            // Otherwise another app took over the device, or it was stopped from the Google Home app.
            if (!expected) error("takenOver");
        }
    };

    private final RemoteMediaClient.Callback mediaCallback = new RemoteMediaClient.Callback() {
        @Override
        public void onStatusUpdated() {
            publishStatus();
        }
    };

    private final RemoteMediaClient.ProgressListener progressListener = (progressMs, durationMs) -> publishStatus();

    private void attach(CastSession s) {
        if (session == s) return;
        detach(false);
        session = s;
        s.addCastListener(castListener);
        client = s.getRemoteMediaClient();
        if (client != null) {
            client.registerCallback(mediaCallback);
            client.addProgressListener(progressListener, 1000);
        }
        holdWifi(true);
        publishSession();
    }

    private void detach() {
        detach(true);
    }

    private void detach(boolean announce) {
        if (session == null) return;
        session.removeCastListener(castListener);
        if (client != null) {
            client.unregisterCallback(mediaCallback);
            client.removeProgressListener(progressListener);
        }
        session = null;
        client = null;
        background.execute(proxy::stop);
        holdWifi(false);
        if (announce) {
            JSObject event = new JSObject();
            event.put("connected", false);
            notifyListeners("session", event);
        }
    }

    private void publishSession() {
        if (session == null) return;
        JSObject event = new JSObject();
        event.put("connected", true);
        CastDevice device = session.getCastDevice();
        if (device != null) {
            JSObject d = new JSObject();
            d.put("id", routeIdFor(device));
            d.put("name", device.getFriendlyName());
            d.put("model", device.getModelName());
            event.put("device", d);
        }
        try {
            event.put("volume", session.getVolume());
            event.put("muted", session.isMute());
        } catch (IllegalStateException ignored) {}
        notifyListeners("session", event);
    }

    /** The MediaRouter id of the session's device, so the picker can mark it as connected. */
    private String routeIdFor(CastDevice device) {
        if (router != null) {
            for (MediaRouter.RouteInfo route : router.getRoutes()) {
                CastDevice d = CastDevice.getFromBundle(route.getExtras());
                if (d != null && d.getDeviceId().equals(device.getDeviceId())) return route.getId();
            }
        }
        return device.getDeviceId();
    }

    private void publishStatus() {
        if (client == null) return;
        MediaStatus status = client.getMediaStatus();
        if (status == null) return;
        String state;
        switch (status.getPlayerState()) {
            case MediaStatus.PLAYER_STATE_PLAYING:
                state = "playing";
                break;
            case MediaStatus.PLAYER_STATE_PAUSED:
                state = "paused";
                break;
            case MediaStatus.PLAYER_STATE_BUFFERING:
            case MediaStatus.PLAYER_STATE_LOADING:
                state = "buffering";
                break;
            default:
                state = "idle";
        }
        JSObject event = new JSObject();
        event.put("state", state);
        event.put("position", client.getApproximateStreamPosition() / 1000.0);
        event.put("duration", Math.max(0, client.getStreamDuration()) / 1000.0);
        if (state.equals("idle")) {
            switch (status.getIdleReason()) {
                case MediaStatus.IDLE_REASON_FINISHED:
                    event.put("idleReason", "finished");
                    break;
                case MediaStatus.IDLE_REASON_ERROR:
                    event.put("idleReason", "error");
                    break;
                case MediaStatus.IDLE_REASON_CANCELED:
                    event.put("idleReason", "cancelled");
                    break;
                case MediaStatus.IDLE_REASON_INTERRUPTED:
                    event.put("idleReason", "interrupted");
                    break;
                default:
                    break;
            }
        }
        notifyListeners("status", event);
    }

    private void error(String code) {
        JSObject event = new JSObject();
        event.put("message", code);
        notifyListeners("error", event);
    }

    /** Keeps the Wi-Fi awake with the screen off: the speaker streams from this phone. */
    private void holdWifi(boolean hold) {
        try {
            if (hold && wifiLock == null) {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifi.createWifiLock(mode, "Musike:cast");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            } else if (!hold && wifiLock != null) {
                wifiLock.release();
                wifiLock = null;
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Wi-Fi lock", e);
        }
    }

    // --- playback

    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url");
        String mime = call.getString("mime", "audio/mp4");
        String userAgent = call.getString("userAgent", "");
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        String artwork = call.getString("artwork", "");
        double startAt = call.getDouble("startAt", 0.0);
        boolean autoplay = call.getBoolean("autoplay", true);
        main.post(() -> {
            if (session == null || client == null || url == null) {
                call.reject("Not connected to a cast device.");
                return;
            }
            CastDevice device = session.getCastDevice();
            InetAddress address = device != null ? device.getInetAddress() : null;
            background.execute(() -> {
                String deviceUrl;
                try {
                    deviceUrl = proxy.register(url, userAgent, address);
                } catch (Exception e) {
                    call.reject("noNetwork");
                    return;
                }
                main.post(() -> loadOnDevice(call, deviceUrl, mime, title, artist, album, artwork, startAt, autoplay));
            });
        });
    }

    private void loadOnDevice(
        PluginCall call,
        String deviceUrl,
        String mime,
        String title,
        String artist,
        String album,
        String artwork,
        double startAt,
        boolean autoplay
    ) {
        if (client == null) {
            call.reject("Not connected to a cast device.");
            return;
        }
        {
            MediaMetadata metadata = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MUSIC_TRACK);
            metadata.putString(MediaMetadata.KEY_TITLE, title);
            metadata.putString(MediaMetadata.KEY_ARTIST, artist);
            if (!album.isEmpty()) metadata.putString(MediaMetadata.KEY_ALBUM_TITLE, album);
            if (!artwork.isEmpty()) metadata.addImage(new WebImage(Uri.parse(artwork)));
            MediaInfo info = new MediaInfo.Builder(deviceUrl)
                .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(mime)
                .setMetadata(metadata)
                .build();
            MediaLoadRequestData request = new MediaLoadRequestData.Builder()
                .setMediaInfo(info)
                .setAutoplay(autoplay)
                .setCurrentTime(Math.round(startAt * 1000))
                .build();
            client.load(request).setResultCallback(result -> {
                if (result.getStatus().isSuccess()) call.resolve();
                else call.reject("streamFailed");
            });
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        main.post(() -> {
            if (client != null) client.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        main.post(() -> {
            if (client != null) client.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        double position = call.getDouble("position", 0.0);
        main.post(() -> {
            if (client != null) client.seek(new MediaSeekOptions.Builder().setPosition(Math.round(position * 1000)).build());
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        double level = call.getDouble("level", 0.5);
        main.post(() -> {
            try {
                if (session != null) session.setVolume(Math.max(0, Math.min(1, level)));
            } catch (Exception e) {
                Log.w(TAG, "volume", e);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        boolean muted = call.getBoolean("muted", false);
        main.post(() -> {
            try {
                if (session != null) session.setMute(muted);
            } catch (Exception e) {
                Log.w(TAG, "mute", e);
            }
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            if (router != null) router.removeCallback(routerCallback);
            if (castContext != null) castContext.getSessionManager().removeSessionManagerListener(sessionListener, CastSession.class);
            detach(false);
            background.shutdown();
        });
    }

    /** Readable reasons for the Cast SDK's status codes, for the "couldn't connect" message. */
    private static final class CastStatusCodesText {
        static String of(int code) {
            String text = com.google.android.gms.cast.CastStatusCodes.getStatusCodeString(code);
            return text == null || text.isEmpty() ? "Error " + code : text;
        }
    }
}
