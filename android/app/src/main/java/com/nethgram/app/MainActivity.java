package com.nethgram.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends ComponentActivity {
    private static final Uri SERVER = Uri.parse(BuildConfig.SERVER_URL);
    private static final String ORIGIN = SERVER.getScheme() + "://" + SERVER.getHost();
    private static final long RETRY_MS = 5000;
    private static final int MAX_IMAGE_BYTES = 25 * 1024 * 1024;
    private static final Pattern DATA_IMAGE =
            Pattern.compile("^data:image/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$");

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Runnable retry = this::reload;

    private View root, loadingView, errorView;
    private WebView web;
    private LocalAssets localAssets;
    private String bridgeJs = "";
    private boolean mainFrameFailed;
    private ValueCallback<Uri[]> fileCallback;
    private PendingImage pendingImage;
    private PushStore pushStore;
    private boolean pageReady;
    private String pendingChat;

    private record PendingImage(String dataUrl, String name) {}

    private final ActivityResultLauncher<Intent> filePicker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                if (fileCallback == null) return;
                fileCallback.onReceiveValue(pickedFiles(result.getResultCode(), result.getData()));
                fileCallback = null;
            });

    private final ActivityResultLauncher<String> storagePermission = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                PendingImage image = pendingImage;
                pendingImage = null;
                if (image == null) return;
                if (granted) saveImage(image.dataUrl(), image.name());
                else toast(R.string.save_denied);
            });

    private final ActivityResultLauncher<String> notificationPermission = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                PushService.start(this, null);
                askBatteryExemption();
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_main);

        root = findViewById(R.id.root);
        web = findViewById(R.id.web);
        loadingView = findViewById(R.id.loading);
        errorView = findViewById(R.id.error);
        findViewById(R.id.retry).setOnClickListener(v -> reload());

        applySystemBars(ContextCompat.getColor(this, R.color.surface));
        // Панели системы и клавиатура не должны перекрывать интерфейс
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets i = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        localAssets = new LocalAssets(getAssets(), SERVER.getHost());
        pushStore = new PushStore(this);
        // deviceId — только буквы, цифры и дефисы (UUID), поэтому безопасно вставлять в скрипт
        bridgeJs = "window.__nethgramDevice='" + pushStore.deviceId() + "';\n" + readAsset("bridge.js");
        PushNotifier.createChannels(this);
        readChatExtra(getIntent());
        configureWebView();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBack();
            }
        });

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(BuildConfig.SERVER_URL);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "RequiresFeature"})
    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.surface));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHapticFeedbackEnabled(false);
        // Долгое нажатие открывает меню сообщения; выделение текста остаётся только в поле ввода
        web.setOnLongClickListener(v -> web.getHitTestResult().getType() != WebView.HitTestResult.EDIT_TEXT_TYPE);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setSafeBrowsingEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " NethgramApp/" + BuildConfig.VERSION_NAME);

        Set<String> origins = Collections.singleton(ORIGIN);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "NethgramNative", origins,
                    (view, message, sourceOrigin, isMainFrame, reply) -> {
                        if (isMainFrame && ORIGIN.equals(sourceOrigin.toString().replaceAll("/$", ""))) {
                            onBridgeMessage(message.getData());
                        }
                    });
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, bridgeJs, origins);
        }

        web.setWebViewClient(new AppWebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    filePicker.launch(params.createIntent());
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    toast(R.string.no_file_app);
                    return false;
                }
            }
        });
    }

    private final class AppWebViewClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return localAssets.open(request.getUrl(), request.getMethod());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if ("https".equals(url.getScheme()) && SERVER.getHost().equals(url.getHost())) return false;
            // Внешние ссылки открываем в браузере, другие схемы (intent:, file: …) блокируем
            if ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException ignored) {
                    // браузера нет
                }
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            // Запасной путь для старых версий WebView без скрипта при старте документа
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                view.evaluateJavascript(bridgeJs, null);
            }
            if (!mainFrameFailed) {
                loadingView.setVisibility(View.GONE);
                errorView.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                pageReady = true;
                openPendingChat();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError();
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) showError();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Движок страницы упал или выгружен системой: пересоздаём экран вместо падения приложения
            ((ViewGroup) view.getParent()).removeView(view);
            view.destroy();
            web = null;
            recreate();
            return true;
        }
    }

    private void showError() {
        mainFrameFailed = true;
        web.setVisibility(View.INVISIBLE);
        loadingView.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
        main.removeCallbacks(retry);
        main.postDelayed(retry, RETRY_MS);
    }

    private void reload() {
        if (web == null) return;
        main.removeCallbacks(retry);
        mainFrameFailed = false;
        errorView.setVisibility(View.GONE);
        loadingView.setVisibility(View.VISIBLE);
        String current = web.getUrl();
        if (current == null || current.startsWith("data:") || current.equals("about:blank")) {
            web.loadUrl(BuildConfig.SERVER_URL);
        } else {
            web.reload();
        }
    }

    /** Назад: сначала закрываем открытое окно или чат на странице, потом сворачиваем приложение */
    private void onBack() {
        if (web == null || mainFrameFailed) {
            moveTaskToBack(true);
            return;
        }
        web.evaluateJavascript("window.__nethgramBack ? window.__nethgramBack() : false", value -> {
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }

    private void onBridgeMessage(String raw) {
        if (raw == null) return;
        try {
            JSONObject m = new JSONObject(raw);
            switch (m.optString("type")) {
                case "theme" -> {
                    Integer color = parseColor(m.optString("color"));
                    if (color != null) applySystemBars(color);
                }
                case "copy" -> {
                    String text = m.optString("text");
                    if (text.length() > 100_000) return;
                    ClipboardManager cm = getSystemService(ClipboardManager.class);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Nethgram", text));
                }
                case "save" -> requestSave(m.optString("dataUrl"), m.optString("name"));
                case "push_token" -> onPushToken(m.optString("token"));
                case "push_logout" -> {
                    pushStore.clearToken();
                    PushService.stop(this);
                    PushNotifier.clearMessages(this);
                }
                default -> { }
            }
        } catch (JSONException ignored) {
            // чужой формат просто игнорируем
        }
    }

    private void onPushToken(String token) {
        if (!token.matches("[0-9a-f]{64}")) return;
        boolean changed = pushStore.setToken(token);
        PushService.start(this, changed ? PushService.ACTION_RECONNECT : null);
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS);
        } else {
            askBatteryExemption();
        }
    }

    /** Один раз просим не усыплять приложение, иначе система может обрывать соединение */
    @SuppressLint("BatteryLife")
    private void askBatteryExemption() {
        if (pushStore.askedBattery()) return;
        pushStore.setAskedBattery();
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException ignored) {
            // на этой прошивке экрана нет
        }
    }

    private void readChatExtra(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra(PushNotifier.EXTRA_CHAT);
        if (id != null && id.matches("[A-Za-z0-9_-]{1,64}")) pendingChat = id;
        intent.removeExtra(PushNotifier.EXTRA_CHAT);
    }

    private void openPendingChat() {
        if (web == null || !pageReady || pendingChat == null) return;
        String id = pendingChat;
        pendingChat = null;
        web.evaluateJavascript("window.__nethgramOpenChat && window.__nethgramOpenChat('" + id + "')", null);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readChatExtra(intent);
        openPendingChat();
    }

    private static Integer parseColor(String v) {
        if (v == null || !v.trim().matches("#[0-9a-fA-F]{6}")) return null;
        return Color.parseColor(v.trim());
    }

    private void applySystemBars(int color) {
        root.setBackgroundColor(color);
        boolean light = (Color.red(color) * 299 + Color.green(color) * 587 + Color.blue(color) * 114) / 1000 > 140;
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), root);
        c.setAppearanceLightStatusBars(light);
        c.setAppearanceLightNavigationBars(light);
    }

    private void requestSave(String dataUrl, String name) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            pendingImage = new PendingImage(dataUrl, name);
            storagePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE);
            return;
        }
        saveImage(dataUrl, name);
    }

    /** Сохраняет фото из просмотрщика в галерею: Pictures/Nethgram */
    private void saveImage(String dataUrl, String rawName) {
        io.execute(() -> {
            boolean ok = false;
            try {
                Matcher m = DATA_IMAGE.matcher(dataUrl);
                if (m.matches()) {
                    byte[] bytes = Base64.decode(m.group(2), Base64.DEFAULT);
                    if (bytes.length <= MAX_IMAGE_BYTES) {
                        String type = m.group(1).toLowerCase(Locale.ROOT).replace("jpg", "jpeg");
                        String ext = type.equals("jpeg") ? "jpg" : type;
                        String base = rawName.replaceAll("\\.[A-Za-z0-9]+$", "").replaceAll("[^A-Za-z0-9_-]", "_");
                        if (base.isEmpty()) base = "nethgram-" + System.currentTimeMillis();
                        if (base.length() > 80) base = base.substring(0, 80);
                        writeToGallery(bytes, base + "." + ext, "image/" + type);
                        ok = true;
                    }
                }
            } catch (IOException | IllegalArgumentException | SecurityException ignored) {
                ok = false;
            }
            final boolean saved = ok;
            main.post(() -> toast(saved ? R.string.saved : R.string.save_failed));
        });
    }

    private void writeToGallery(byte[] bytes, String fileName, String mime) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Images.Media.MIME_TYPE, mime);
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Nethgram");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri item = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (item == null) throw new IOException("insert failed");
            try (OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) throw new IOException("no stream");
                out.write(bytes);
            } catch (IOException e) {
                resolver.delete(item, null, null);
                throw e;
            }
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(item, values, null, null);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Nethgram");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdir failed");
            File file = new File(dir, fileName);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            MediaScannerConnection.scanFile(this, new String[]{file.getPath()}, new String[]{mime}, null);
        }
    }

    private static Uri[] pickedFiles(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) return null;
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri[] uris = new Uri[clip.getItemCount()];
            for (int i = 0; i < uris.length; i++) uris[i] = clip.getItemAt(i).getUri();
            return uris;
        }
        return data.getData() != null ? new Uri[]{data.getData()} : null;
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return "";
        }
    }

    private void toast(int text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        ViewCompat.requestApplyInsets(root);
    }

    @Override
    protected void onStart() {
        super.onStart();
        AppState.visible = true;
        PushNotifier.clearMessages(this);
        PushService.start(this, null);
    }

    @Override
    protected void onStop() {
        AppState.visible = false;
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        io.shutdown();
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
