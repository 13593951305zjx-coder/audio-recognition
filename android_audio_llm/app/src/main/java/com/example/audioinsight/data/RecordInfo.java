package com.example.audioinsight.data;

import org.json.JSONObject;
import java.util.Locale;

/** A local SQLite record. Original media paths and full server payload are retained. */
public final class RecordInfo {
    public long id, createdAt;
    public String taskId = "", title = "", fileName = "", filePath = "", serverUrl = "";
    public String status = "Draft", message = "尚未提交识别", resultJson = "{}";
    public double duration;
    public boolean favorite;

    public JSONObject result() {
        try { return new JSONObject(resultJson); } catch (Exception ignored) { return new JSONObject(); }
    }
    public String transcript() { return result().optString("transcript", ""); }
    public boolean hasResult() { return !transcript().trim().isEmpty() || result().has("pitchStats"); }
    public boolean isVideo() {
        String name = fileName.toLowerCase(Locale.ROOT);
        return name.endsWith(".mp4") || name.endsWith(".webm") || name.endsWith(".mpeg");
    }
    public boolean isActive() {
        return !("Draft".equals(status) || "Success".equals(status) || "Partial".equals(status)
                || "Failed".equals(status) || "Cancelled".equals(status) || "UploadInterrupted".equals(status)
                || "PollingPaused".equals(status));
    }
    public static String statusLabel(String status) {
        switch (status == null ? "" : status) {
            case "Draft": return "待识别";
            case "LocalQueued": return "手机队列中";
            case "Uploading": return "正在上传";
            case "Queued": return "服务队列中";
            case "Analyzing": return "分析音频";
            case "Recognizing": return "转写中";
            case "Summarizing": return "提取重点";
            case "Diarizing": return "区分说话人";
            case "Reviewing": return "复核语音";
            case "Enriching": return "声音标签分析";
            case "Success": return "已完成";
            case "Partial": return "部分完成";
            case "Failed": return "未完成";
            case "Cancelled": return "已取消";
            case "UploadInterrupted": return "上传待确认";
            case "PollingPaused": return "等待重新连接";
            default: return status == null ? "待处理" : status;
        }
    }
}
