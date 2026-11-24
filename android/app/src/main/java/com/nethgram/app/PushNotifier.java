package com.nethgram.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

/** Показывает уведомления: отдельное на каждый чат, сгруппированные как в мессенджерах. */
final class PushNotifier {
    static final String EXTRA_CHAT = "chatId";
    static final int SERVICE_ID = 1;
    private static final int MESSAGE_ID = 2, SUMMARY_ID = 3;
    private static final String CHANNEL_MESSAGES = "messages", CHANNEL_SERVICE = "service", GROUP = "nethgram_messages";
    private static final int MAX_LINES = 7;

    private record Line(String sender, String text, long ts) {}

    private static final Map<String, ArrayDeque<Line>> history = new LinkedHashMap<>();

    private PushNotifier() {}

    static void createChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel messages = new NotificationChannel(CHANNEL_MESSAGES,
                c.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
        messages.enableVibration(true);
        NotificationChannel service = new NotificationChannel(CHANNEL_SERVICE,
                c.getString(R.string.channel_service), NotificationManager.IMPORTANCE_MIN);
        service.setShowBadge(false);
        service.setDescription(c.getString(R.string.channel_service_desc));
        nm.createNotificationChannel(messages);
        nm.createNotificationChannel(service);
    }

    static Notification serviceNotification(Context c) {
        return new NotificationCompat.Builder(c, CHANNEL_SERVICE)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(c.getString(R.string.app_name))
                .setContentText(c.getString(R.string.service_text))
                .setContentIntent(openIntent(c, null))
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setShowWhen(false)
                .setOngoing(true)
                .build();
    }

    static synchronized void show(Context c, String chatId, String title, String sender, String body, long ts) {
        if (ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && android.os.Build.VERSION.SDK_INT >= 33) return;

        ArrayDeque<Line> lines = history.computeIfAbsent(chatId, k -> new ArrayDeque<>());
        lines.addLast(new Line(sender != null ? sender : title, body, ts));
        while (lines.size() > MAX_LINES) lines.removeFirst();

        Person me = new Person.Builder().setName(c.getString(R.string.you)).build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me)
                .setConversationTitle(sender != null ? title : null)
                .setGroupConversation(sender != null);
        for (Line l : lines) {
            style.addMessage(l.text(), l.ts(), new Person.Builder().setName(l.sender()).build());
        }

        Notification n = new NotificationCompat.Builder(c, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setColor(0xFF2AABEE)
                .setStyle(style)
                .setContentTitle(title)
                .setContentText(body)
                .setWhen(ts)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setGroup(GROUP)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openIntent(c, chatId))
                .build();
        Notification summary = new NotificationCompat.Builder(c, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setColor(0xFF2AABEE)
                .setContentTitle(c.getString(R.string.app_name))
                .setContentText(c.getString(R.string.new_messages))
                .setGroup(GROUP)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(openIntent(c, null))
                .build();
        try {
            NotificationManagerCompat nm = NotificationManagerCompat.from(c);
            nm.notify(chatId, MESSAGE_ID, n);
            nm.notify(SUMMARY_ID, summary);
        } catch (SecurityException ignored) {
            // разрешение отозвано
        }
    }

    /** Убирает уведомления о сообщениях; значок фоновой службы остаётся */
    static synchronized void clearMessages(Context c) {
        history.clear();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        for (StatusBarNotification s : nm.getActiveNotifications()) {
            if (s.getId() != SERVICE_ID) nm.cancel(s.getTag(), s.getId());
        }
    }

    private static PendingIntent openIntent(Context c, String chatId) {
        Intent i = new Intent(c, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (chatId != null) i.putExtra(EXTRA_CHAT, chatId);
        int request = chatId == null ? 0 : chatId.hashCode();
        return PendingIntent.getActivity(c, request, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
