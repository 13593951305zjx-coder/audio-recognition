package com.example.audioinsight.data;

import android.content.Context;

public final class AppSettings {
    private AppSettings() { }
    public static String baseUrl(Context context) {
        return context.getSharedPreferences("audio_insight_settings", Context.MODE_PRIVATE)
                .getString("server", "http://127.0.0.1:8000");
    }
    public static void setBaseUrl(Context context, String value) {
        String normalized = ApiClient.normalizeBaseUrl(value);
        context.getSharedPreferences("audio_insight_settings", Context.MODE_PRIVATE)
                .edit().putString("server", normalized).apply();
    }
}
