package com.nethgram.app;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Отдаёт картинки, подарки и стикеры прямо из APK, если они там есть:
 * приложение открывается быстрее и меньше нагружает сервер.
 * Если файла в APK нет, запрос просто уходит на сервер.
 */
final class LocalAssets {
    private static final Pattern PATH = Pattern.compile("^/(assets|gifts|stickers)/([A-Za-z0-9._-]+)$");

    private final AssetManager manager;
    private final String host;
    private final Map<String, Set<String>> index = new HashMap<>();

    LocalAssets(AssetManager manager, String host) {
        this.manager = manager;
        this.host = host;
    }

    WebResourceResponse open(Uri url, String method) {
        if (!"GET".equalsIgnoreCase(method) || !"https".equals(url.getScheme()) || !host.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null) return null;
        Matcher m = PATH.matcher(path);
        if (!m.matches()) return null;
        String dir = m.group(1), file = m.group(2);
        if (!files(dir).contains(file)) return null;
        try {
            String mime = mimeOf(file);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "public, max-age=86400");
            return new WebResourceResponse(mime, mime.startsWith("image/") ? null : "UTF-8", 200, "OK",
                    headers, manager.open("web/" + dir + "/" + file));
        } catch (IOException e) {
            return null;
        }
    }

    private synchronized Set<String> files(String dir) {
        Set<String> names = index.get(dir);
        if (names == null) {
            names = new HashSet<>();
            try {
                String[] list = manager.list("web/" + dir);
                if (list != null) names.addAll(Arrays.asList(list));
            } catch (IOException ignored) {
                // папки нет — всё загрузится с сервера
            }
            index.put(dir, names);
        }
        return names;
    }

    private static String mimeOf(String file) {
        String f = file.toLowerCase(Locale.ROOT);
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
        if (f.endsWith(".webp")) return "image/webp";
        if (f.endsWith(".gif")) return "image/gif";
        if (f.endsWith(".svg")) return "image/svg+xml";
        if (f.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }
}
