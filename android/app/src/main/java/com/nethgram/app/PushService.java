package com.nethgram.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import androidx.annotation.NonNull;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Держит лёгкое соединение с сервером, чтобы уведомления приходили без Firebase.
 * Через него идут только новые сообщения, поэтому расход батареи и трафика небольшой.
 */
public class PushService extends Service {
    static final String ACTION_RECONNECT = "com.nethgram.app.RECONNECT";
    private static final long WATCHDOG_MS = 15 * 60 * 1000;
    private static final long MAX_BACKOFF_MS = 60 * 1000;
    private static final int MAX_SEEN = 300;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    private final Runnable reconnect = this::connect;

    private PushStore store;
    private OkHttpClient client;
    private ConnectivityManager connectivity;
    private WebSocket socket;
    private boolean ready;
    private int generation, failures;

    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(@NonNull Network network) {
            main.post(() -> {
                failures = 0;
                if (!ready) {
                    main.removeCallbacks(reconnect);
                    connect();
                }
            });
        }
    };

    /** Запустить службу, если пользователь вошёл. Система может запретить запуск из фона. */
    static void start(Context context, String action) {
        if (new PushStore(context).token() == null) return;
        Intent i = new Intent(context, PushService.class).setAction(action);
        try {
            ContextCompat.startForegroundService(context, i);
        } catch (RuntimeException ignored) {
            // запуск из фона запрещён: повторим при следующем открытии приложения
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, PushService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = new PushStore(this);
        PushNotifier.createChannels(this);
        enterForeground();
        client = new OkHttpClient.Builder()
                .pingInterval(2, TimeUnit.MINUTES)
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
        connectivity = getSystemService(ConnectivityManager.class);
        NetworkRequest request = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build();
        connectivity.registerNetworkCallback(request, networkCallback);
    }

    private void enterForeground() {
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        ServiceCompat.startForeground(this, PushNotifier.SERVICE_ID, PushNotifier.serviceNotification(this), type);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        enterForeground();
        if (store.token() == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        scheduleWatchdog();
        if (intent != null && ACTION_RECONNECT.equals(intent.getAction())) {
            closeSocket();
            connect();
        } else if (!ready) {
            connect();
        }
        return START_STICKY;
    }

    private void connect() {
        main.removeCallbacks(reconnect);
        String token = store.token();
        if (token == null) {
            stopSelf();
            return;
        }
        closeSocket();
        final int gen = ++generation;
        String url = BuildConfig.SERVER_URL.replaceFirst("^https", "wss");
        Request request = new Request.Builder().url(url)
                .header("User-Agent", "NethgramApp/" + BuildConfig.VERSION_NAME).build();
        socket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(@NonNull WebSocket ws, @NonNull Response response) {
                try {
                    ws.send(new JSONObject()
                            .put("type", "push_subscribe")
                            .put("deviceId", store.deviceId())
                            .put("token", token)
                            .put("since", store.since()).toString());
                } catch (JSONException e) {
                    ws.cancel();
                }
            }

            @Override
            public void onMessage(@NonNull WebSocket ws, @NonNull String text) {
                main.post(() -> {
                    if (gen == generation) handle(text);
                });
            }

            @Override
            public void onClosing(@NonNull WebSocket ws, int code, @NonNull String reason) {
                ws.close(1000, null);
                main.post(() -> lost(gen));
            }

            @Override
            public void onClosed(@NonNull WebSocket ws, int code, @NonNull String reason) {
                main.post(() -> lost(gen));
            }

            @Override
            public void onFailure(@NonNull WebSocket ws, @NonNull Throwable t, Response response) {
                main.post(() -> lost(gen));
            }
        });
    }

    private void lost(int gen) {
        if (gen != generation) return;
        ready = false;
        socket = null;
        failures++;
        long delay = Math.min(MAX_BACKOFF_MS, 2000L << Math.min(failures - 1, 5));
        main.removeCallbacks(reconnect);
        main.postDelayed(reconnect, delay);
    }

    private void handle(String raw) {
        try {
            JSONObject m = new JSONObject(raw);
            switch (m.optString("type")) {
                case "push_ok" -> {
                    ready = true;
                    failures = 0;
                    // первый запуск: точка отсчёта — время сервера
                    if (store.since() == 0) store.setSince(m.optLong("now"));
                }
                case "push_denied" -> {
                    // вход отозван: прекращаем попытки
                    store.clearToken();
                    PushNotifier.clearMessages(this);
                    stopSelf();
                }
                case "push" -> onPush(m);
                default -> { }
            }
        } catch (JSONException ignored) {
            // повреждённое сообщение пропускаем
        }
    }

    private void onPush(JSONObject m) {
        String id = m.optString("id");
        String chatId = m.optString("chatId");
        if (id.isEmpty() || chatId.isEmpty() || !seen.add(id)) return;
        if (seen.size() > MAX_SEEN) {
            String oldest = seen.iterator().next();
            seen.remove(oldest);
        }
        long ts = m.optLong("ts", System.currentTimeMillis());
        store.setSince(Math.min(ts, System.currentTimeMillis()));
        if (AppState.visible) return;
        String sender = m.isNull("sender") ? null : m.optString("sender");
        PushNotifier.show(this, chatId, m.optString("title", getString(R.string.app_name)), sender, m.optString("body"), ts);
    }

    /** Будильник на случай, если система усыпила соединение и таймеры */
    private void scheduleWatchdog() {
        AlarmManager alarms = getSystemService(AlarmManager.class);
        Intent i = new Intent(this, PushReceiver.class).setAction(PushReceiver.ACTION_WATCHDOG);
        PendingIntent pi = PendingIntent.getBroadcast(this, 1, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + WATCHDOG_MS, pi);
    }

    private void closeSocket() {
        ready = false;
        generation++;
        if (socket != null) {
            socket.cancel();
            socket = null;
        }
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        closeSocket();
        try {
            connectivity.unregisterNetworkCallback(networkCallback);
        } catch (IllegalArgumentException ignored) {
            // уже отписаны
        }
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
