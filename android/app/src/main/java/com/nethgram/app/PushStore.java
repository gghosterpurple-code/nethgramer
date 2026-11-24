package com.nethgram.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

/** Настройки фоновых уведомлений. Токен годится только для получения уведомлений. */
final class PushStore {
    private static final String FILE = "push";
    private final SharedPreferences prefs;

    PushStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    String deviceId() {
        String id = prefs.getString("device", null);
        if (id == null) {
            id = UUID.randomUUID().toString();
            prefs.edit().putString("device", id).apply();
        }
        return id;
    }

    String token() {
        return prefs.getString("token", null);
    }

    /** @return true, если токен изменился */
    boolean setToken(String token) {
        if (token == null || token.equals(token())) return false;
        // Новый вход: старые сообщения повторно не показываем
        prefs.edit().putString("token", token).putLong("since", System.currentTimeMillis()).apply();
        return true;
    }

    void clearToken() {
        prefs.edit().remove("token").remove("since").apply();
    }

    long since() {
        return prefs.getLong("since", 0);
    }

    void setSince(long ts) {
        if (ts > since()) prefs.edit().putLong("since", ts).apply();
    }

    boolean askedBattery() {
        return prefs.getBoolean("asked_battery", false);
    }

    void setAskedBattery() {
        prefs.edit().putBoolean("asked_battery", true).apply();
    }
}
