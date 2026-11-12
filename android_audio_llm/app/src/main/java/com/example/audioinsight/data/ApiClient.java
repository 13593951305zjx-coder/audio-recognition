package com.example.audioinsight.data;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Uses Android's HTTP client; no credentials or model files are bundled in the APK. */
public final class ApiClient {
    private final String base;
    public ApiClient(String baseUrl) { base = normalizeBaseUrl(baseUrl); }

    public static String normalizeBaseUrl(String value) {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            String scheme = uri.getScheme();
            if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null
                    || uri.getFragment() != null || uri.getPort() > 65535 || uri.getPort() == 0)
                throw new IllegalArgumentException();
            String normalized = uri.toASCIIString();
            while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
            return normalized;
        } catch (Exception error) { throw new IllegalArgumentException("请输入完整服务地址，例如 http://127.0.0.1:8000"); }
    }

    public JSONObject health() throws Exception {
        JSONObject result = object("GET", "/api/health", null);
        if (!result.optBoolean("ok") || !"audio-insight".equals(result.optString("service")))
            throw new IOException("这个地址没有运行音频智记服务，请检查电脑启动脚本");
        return result;
    }

    public JSONObject upload(File file, String fileName, double duration) throws Exception {
        if (!file.isFile() || file.length() == 0) throw new IOException("音频文件不存在或为空");
        if (file.length() > 50L * 1024 * 1024) throw new IOException("文件不能超过50MB");
        String boundary = "AudioInsight" + UUID.randomUUID().toString().replace("-", "");
        HttpURLConnection connection = open("POST", "/api/recognition");
        connection.setDoOutput(true);
        connection.setChunkedStreamingMode(64 * 1024);
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try {
            try (OutputStream output = new BufferedOutputStream(connection.getOutputStream())) {
                field(output, boundary, "duration", String.valueOf((int) Math.ceil(duration)));
                field(output, boundary, "sampleRate", "16000");
                String safe = fileName.replaceAll("[\\r\\n\\\"\\\\/]", "_");
                bytes(output, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"audioFile\"; filename=\""
                        + safe + "\"\r\nContent-Type: application/octet-stream\r\n\r\n");
                try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
                    byte[] buffer = new byte[65536]; int n;
                    while ((n = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("上传已中断");
                        output.write(buffer, 0, n);
                    }
                }
                bytes(output, "\r\n--" + boundary + "--\r\n");
            }
            return new JSONObject(read(connection));
        } finally { connection.disconnect(); }
    }

    public JSONObject status(String taskId) throws Exception {
        return object("GET", "/api/recognition/status?taskId=" + URLEncoder.encode(taskId, "UTF-8"), null);
    }
    public JSONArray history() throws Exception { return new JSONArray(call("GET", "/api/recognition/history", null)); }
    public JSONObject post(String path, JSONObject body) throws Exception { return object("POST", path, body); }
    public JSONObject patch(String path, JSONObject body) throws Exception { return object("PATCH", path, body); }
    private JSONObject object(String method, String path, JSONObject body) throws Exception { return new JSONObject(call(method, path, body)); }
    private String call(String method, String path, JSONObject body) throws Exception {
        HttpURLConnection connection = open(method, path);
        try {
            if (body != null) {
                connection.setDoOutput(true);
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(payload.length);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream output = connection.getOutputStream()) { output.write(payload); }
            }
            return read(connection);
        } finally { connection.disconnect(); }
    }
    private HttpURLConnection open(String method, String path) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(120000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }
    private static String read(HttpURLConnection connection) throws Exception {
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        if (stream != null) try (InputStream input = stream) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = input.read(buffer)) != -1) {
                if (result.size() + n > 16 * 1024 * 1024) throw new IOException("服务返回内容过大，请缩短录音后重试");
                result.write(buffer, 0, n);
            }
        }
        String text = result.toString("UTF-8");
        if (code < 200 || code >= 300) {
            String detail = "";
            try { detail = new JSONObject(text).optString("detail", ""); } catch (Exception ignored) { }
            throw new IOException(detail.isEmpty() ? "服务请求失败（" + code + "），请在设置里检查连接" : detail);
        }
        return text;
    }
    private static void field(OutputStream output, String boundary, String key, String value) throws IOException {
        bytes(output, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + key + "\"\r\n\r\n" + value + "\r\n");
    }
    private static void bytes(OutputStream output, String value) throws IOException { output.write(value.getBytes(StandardCharsets.UTF_8)); }
}
