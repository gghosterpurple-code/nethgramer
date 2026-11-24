package com.nethgram.app;

/** Открыто ли приложение на экране: тогда системные уведомления не нужны. */
final class AppState {
    static volatile boolean visible;

    private AppState() {}
}
