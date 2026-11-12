package com.example.audioinsight.data;

import android.content.Context;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Coordinates SQLite, media import, and a durable serial upload queue. */
public final class AppRepository {
    private static volatile AppRepository instance;
    private final Context context;
    private final RecordDatabase database;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final ExecutorService queue = Executors.newSingleThreadExecutor();
    private final CopyOnWriteArrayList<Runnable> observers = new CopyOnWriteArrayList<>();
    private final AtomicBoolean draining = new AtomicBoolean(false);
    private AppRepository(Context context) {
        this.context = context.getApplicationContext();
        database = new RecordDatabase(this.context);
        io.execute(() -> {
            for (RecordInfo record : database.list("", false)) {
                if ("Uploading".equals(record.status) && record.taskId.isEmpty()) {
                    record.status = "UploadInterrupted";
                    record.message = "上次上传中断，请先同步电脑历史检查是否已接收，再决定是否重试";
                    database.save(record);
                }
            }
            drain();
        });
    }
    public static AppRepository get(Context context) {
        if (instance == null) synchronized (AppRepository.class) {
            if (instance == null) instance = new AppRepository(context);
        }
        return instance;
    }
    public void observe(Runnable observer) { observers.addIfAbsent(observer); }
    public void removeObserver(Runnable observer) { observers.remove(observer); }
    private void changed() { main.post(() -> { for (Runnable observer : observers) observer.run(); }); }
    private <T> void success(Callback<T> callback, T value) { if (callback != null) main.post(() -> callback.onSuccess(value)); }
    private void failure(Callback<?> callback, Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) message = "操作未完成，请检查文件和服务连接";
        if (error instanceof java.net.ConnectException || error instanceof java.net.SocketTimeoutException)
            message = "无法连接电脑服务。请运行电脑上的手机连接脚本，并在设置中检查服务地址；录音和已有记录仍已保留。";
        final String text = message;
        if (callback != null) main.post(() -> callback.onError(text));
    }
    private RecordInfo require(long id) throws IOException {
        RecordInfo record = database.get(id);
        if (record == null) throw new IOException("这条本地记录已被删除");
        return record;
    }
    public void loadRecords(String query, boolean favorites, Callback<List<RecordInfo>> callback) {
        io.execute(() -> { try { success(callback, database.list(query, favorites)); } catch (Exception e) { failure(callback, e); } });
    }
    public void loadRecord(long id, Callback<RecordInfo> callback) {
        io.execute(() -> { try { success(callback, require(id)); } catch (Exception e) { failure(callback, e); } });
    }
    public void checkConnection(String server, Callback<JSONObject> callback) {
        io.execute(() -> { try { success(callback, new ApiClient(server).health()); } catch (Exception e) { failure(callback, e); } });
    }

    public void importUri(Uri uri, Callback<RecordInfo> callback) {
        io.execute(() -> {
            File target = null;
            try {
                String name = "导入音频";
                try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        String display = cursor.getString(0);
                        if (display != null && !display.trim().isEmpty()) name = display;
                        if (!cursor.isNull(1) && cursor.getLong(1) > 50L * 1024 * 1024) throw new IOException("文件不能超过50MB");
                    }
                }
                String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                if (!Arrays.asList("mp3","wav","m4a","aac","ogg","webm","mp4","flac","mpeg","mpga").contains(extension))
                    throw new IOException("请选择mp3、wav、m4a、aac、ogg、webm、mp4或flac音视频文件");
                File folder = new File(context.getFilesDir(), "audio");
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("无法创建录音目录");
                target = new File(folder, UUID.randomUUID() + "." + extension);
                try (InputStream input = context.getContentResolver().openInputStream(uri);
                     OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
                    if (input == null) throw new IOException("无法打开所选文件");
                    byte[] buffer = new byte[65536]; long size = 0; int n;
                    while ((n = input.read(buffer)) != -1) {
                        size += n;
                        if (size > 50L * 1024 * 1024) throw new IOException("文件不能超过50MB");
                        output.write(buffer, 0, n);
                    }
                    if (size == 0) throw new IOException("所选文件为空");
                }
                double seconds = mediaDuration(target);
                if (seconds > 300) throw new IOException("当前本地服务每个文件最多5分钟，请先截取后导入");
                RecordInfo record = new RecordInfo();
                record.title = name; record.fileName = name; record.filePath = target.getAbsolutePath();
                record.duration = seconds; record.createdAt = System.currentTimeMillis();
                database.save(record); changed(); success(callback, record);
            } catch (Exception e) { if (target != null && target.isFile()) target.delete(); failure(callback, e); }
        });
    }
    public void addRecording(File file, double seconds, Callback<RecordInfo> callback) {
        io.execute(() -> {
            try {
                File allowed = new File(context.getFilesDir(), "audio").getCanonicalFile();
                if (!file.getCanonicalPath().startsWith(allowed.getPath() + File.separator) || !file.isFile() || file.length() == 0)
                    throw new IOException("录音文件无效");
                RecordInfo record = new RecordInfo();
                record.title = "录音 " + new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(new Date());
                record.fileName = file.getName(); record.filePath = file.getAbsolutePath();
                record.duration = Math.max(0, Math.min(300, seconds)); record.createdAt = System.currentTimeMillis();
                database.save(record); changed(); success(callback, record);
            } catch (Exception e) { failure(callback, e); }
        });
    }
    private double mediaDuration(File file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(file.getAbsolutePath());
            String duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return duration == null ? 0 : Double.parseDouble(duration) / 1000.0;
        } catch (Exception ignored) { return 0; } finally { try { retriever.release(); } catch (Exception ignored) { } }
    }

    public void submit(long id, Callback<RecordInfo> callback) {
        io.execute(() -> {
            try {
                RecordInfo record = require(id);
                if (!record.taskId.isEmpty()) { success(callback, record); refresh(id, null); return; }
                if (record.isActive()) { success(callback, record); return; }
                if (!new File(record.filePath).isFile()) throw new IOException("本地音频已不存在，请重新导入");
                record.serverUrl = ApiClient.normalizeBaseUrl(AppSettings.baseUrl(context));
                record.status = "LocalQueued"; record.message = "已加入手机队列，前一个文件完成后上传";
                database.save(record); changed(); success(callback, record); drain();
            } catch (Exception e) { failure(callback, e); }
        });
    }
    private void drain() {
        if (!draining.compareAndSet(false, true)) return;
        queue.execute(() -> {
            try {
                while (true) {
                    RecordInfo next = null;
                    List<RecordInfo> records = database.list("", false);
                    Collections.reverse(records);
                    for (RecordInfo record : records) {
                        if ("LocalQueued".equals(record.status) || (!record.taskId.isEmpty() && record.isActive())) { next = record; break; }
                    }
                    if (next == null) break;
                    process(next);
                }
            } finally {
                draining.set(false);
                // Close the enqueue-vs-empty-queue race without a busy polling loop.
                for (RecordInfo record : database.list("", false)) if ("LocalQueued".equals(record.status)) { drain(); break; }
            }
        });
    }
    private void process(RecordInfo record) {
        try {
            ApiClient api = new ApiClient(record.serverUrl);
            if (record.taskId.isEmpty()) {
                api.health();
                record.status = "Uploading"; record.message = "正在把音频传给电脑上的本地服务"; saveState(record);
                JSONObject uploaded = api.upload(new File(record.filePath), record.fileName, record.duration);
                record.taskId = uploaded.getString("taskId"); record.status = "Queued";
                record.message = uploaded.optString("message", "电脑已接收，正在排队"); saveState(record);
            }
            poll(record, api);
        } catch (Exception error) {
            record.status = record.taskId.isEmpty() ? ("Uploading".equals(record.status) ? "UploadInterrupted" : "Failed") : "PollingPaused";
            record.message = record.taskId.isEmpty() && "UploadInterrupted".equals(record.status)
                    ? "上传连接中断，请先同步电脑历史检查是否已接收，再决定是否重试。原文件已保留。"
                    : "连接暂时中断，记录和已接受的任务仍保留。请在设置检查连接后刷新。";
            saveState(record);
        }
    }
    private void poll(RecordInfo record, ApiClient api) throws Exception {
        for (int attempt = 0; attempt < 1200; attempt++) {
            if (database.get(record.id) == null) return;
            applyResult(record, api.status(record.taskId));
            saveState(record);
            if (!record.isActive()) return;
            Thread.sleep(1500);
        }
        record.status = "PollingPaused"; record.message = "任务仍在电脑处理，稍后点刷新继续查询"; saveState(record);
    }
    private void applyResult(RecordInfo record, JSONObject result) {
        record.taskId = result.optString("taskId", record.taskId);
        record.status = result.optString("status", record.status);
        record.message = result.optString("message", "");
        if (record.message.isEmpty()) record.message = result.optString("error", "");
        record.duration = result.optDouble("duration", record.duration);
        record.resultJson = result.toString();
    }
    private void saveState(RecordInfo record) {
        RecordInfo current = database.get(record.id);
        if (current == null) return;
        record.title = current.title; record.favorite = current.favorite;
        database.save(record); changed();
    }
    public void refresh(long id, Callback<RecordInfo> callback) {
        io.execute(() -> {
            try {
                RecordInfo record = require(id);
                if (record.taskId.isEmpty()) { success(callback, record); return; }
                applyResult(record, new ApiClient(record.serverUrl).status(record.taskId));
                saveState(record); success(callback, record);
                if (record.isActive()) drain();
            } catch (Exception e) { failure(callback, e); }
        });
    }
    public void syncHistory(Callback<Integer> callback) {
        io.execute(() -> {
            try {
                String server = ApiClient.normalizeBaseUrl(AppSettings.baseUrl(context));
                JSONArray history = new ApiClient(server).history(); int count = 0;
                for (int i = 0; i < history.length(); i++) {
                    JSONObject json = history.optJSONObject(i);
                    if (json == null || json.optString("taskId").isEmpty()) continue;
                    RecordInfo record = database.remote(server, json.optString("taskId"));
                    if (record == null) {
                        record = new RecordInfo(); record.serverUrl = server;
                        record.title = json.optString("displayName", json.optString("fileName", "电脑记录"));
                        record.fileName = json.optString("fileName", "音频");
                        record.createdAt = System.currentTimeMillis() - i;
                        String created = json.optString("createdAt");
                        if (!created.isEmpty()) try { record.createdAt = java.time.OffsetDateTime.parse(created).toInstant().toEpochMilli(); } catch (Exception ignored) { }
                        record.favorite = json.optBoolean("favorite");
                    }
                    applyResult(record, json); database.save(record); count++;
                }
                changed(); success(callback, count); drain();
            } catch (Exception e) { failure(callback, e); }
        });
    }
    public void updateMeta(long id, String title, boolean favorite, Callback<RecordInfo> callback) {
        io.execute(() -> {
            try {
                String text = title == null ? "" : title.trim();
                if (text.isEmpty() || text.length() > 80) throw new IOException("名称需要1到80个字");
                RecordInfo record = require(id); record.title = text; record.favorite = favorite;
                database.save(record); changed(); success(callback, record);
            } catch (Exception e) { failure(callback, e); }
        });
    }
    public void delete(long id, Callback<Void> callback) {
        io.execute(() -> {
            try {
                RecordInfo record = require(id);
                if (record.isActive()) throw new IOException("任务仍在处理，请等待完成后再删除本地记录");
                database.delete(id);
                if (!record.filePath.isEmpty()) {
                    File file = new File(record.filePath).getCanonicalFile();
                    File root = new File(context.getFilesDir(), "audio").getCanonicalFile();
                    if (file.getPath().startsWith(root.getPath() + File.separator)) file.delete();
                }
                changed(); success(callback, null);
            } catch (Exception e) { failure(callback, e); }
        });
    }
    public String mediaUrl(RecordInfo record) {
        if (!record.filePath.isEmpty() && new File(record.filePath).isFile()) return Uri.fromFile(new File(record.filePath)).toString();
        if (record.taskId.isEmpty()) return "";
        return record.serverUrl + "/api/recognition/" + record.taskId + "/media/file";
    }
    public void editSegment(long id, int index, String text, Callback<RecordInfo> callback) {
        loadRecord(id, new Callback<RecordInfo>() {
            public void onSuccess(RecordInfo record) {
                JSONObject segment = record.result().optJSONArray("segments") == null ? null
                        : record.result().optJSONArray("segments").optJSONObject(index);
                if (segment == null) { failure(callback, new IOException("分句已变化，请刷新后重新选择")); return; }
                editSegment(id, index, text, segment.optString("text"), record.result().optInt("segmentStructureRevision"), callback);
            }
            public void onError(String message) { if (callback != null) callback.onError(message); }
        });
    }
    public void editSegment(long id, int index, String text, String expectedText, int expectedStructureRevision, Callback<RecordInfo> callback) {
        io.execute(() -> {
            try {
                RecordInfo record = require(id); requireRemoteIdle(record);
                JSONObject body = new JSONObject().put("segmentIndex", index).put("text", text)
                        .put("expectedText", expectedText).put("expectedStructureRevision", expectedStructureRevision);
                applyResult(record, new ApiClient(record.serverUrl).patch("/api/recognition/"+record.taskId+"/transcript", body));
                saveState(record); success(callback, record);
            } catch (Exception e) { failure(callback, e); }
        });
    }
    public void summarizeSelection(long id, List<Integer> indexes, Callback<JSONObject> callback) {
        loadRecord(id, new Callback<RecordInfo>() {
            public void onSuccess(RecordInfo record) { summarizeSelection(id, indexes, record.result().optInt("segmentStructureRevision"), callback); }
            public void onError(String message) { if (callback != null) callback.onError(message); }
        });
    }
    public void summarizeSelection(long id, List<Integer> indexes, int expectedStructureRevision, Callback<JSONObject> callback) {
        io.execute(() -> {
            try {
                RecordInfo record = require(id); requireRemoteIdle(record);
                JSONObject body = new JSONObject().put("segmentIndices", new JSONArray(indexes))
                        .put("expectedStructureRevision", expectedStructureRevision);
                JSONObject response = new ApiClient(record.serverUrl).post("/api/recognition/"+record.taskId+"/fragment-summary", body);
                success(callback, response);
            } catch (Exception e) { failure(callback, e); }
        });
    }
    public void retrySummary(long id, Callback<RecordInfo> callback) {
        io.execute(() -> {
            try {
                RecordInfo record = require(id); requireRemoteIdle(record);
                new ApiClient(record.serverUrl).post("/api/recognition/"+record.taskId+"/summary", new JSONObject());
                record.status = "Summarizing"; record.message = "正在重新提取重要信息";
                saveState(record); success(callback, record); drain();
            } catch (Exception e) { failure(callback, e); }
        });
    }
    private void requireRemoteIdle(RecordInfo record) throws IOException {
        if (record.taskId.isEmpty()) throw new IOException("请先完成识别");
        if (record.isActive()) throw new IOException("请等待当前识别处理完成");
    }
}
