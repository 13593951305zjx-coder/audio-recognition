package com.example.audioinsight.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.ArrayList;
import java.util.List;

/** SQLite is local-first; an unavailable AI service never discards saved recordings. */
final class RecordDatabase extends SQLiteOpenHelper {
    RecordDatabase(Context context) { super(context, "audio_insight_mobile.db", null, 1); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL DEFAULT '',"
                + " title TEXT NOT NULL, file_name TEXT NOT NULL, file_path TEXT NOT NULL DEFAULT '',"
                + " server_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',"
                + " result_json TEXT NOT NULL DEFAULT '{}', duration REAL NOT NULL DEFAULT 0,"
                + " created_at INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE INDEX idx_record_time ON records(created_at DESC)");
        db.execSQL("CREATE UNIQUE INDEX idx_remote_task ON records(server_url,task_id) WHERE task_id<>''");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("数据库需要保留记录进行迁移，不能清空重建");
    }
    synchronized RecordInfo save(RecordInfo record) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
        // History can observe an upload on the server before the upload ACK arrives.
        // Merge that remote-only cache entry atomically into the local recording row.
        if (!record.taskId.isEmpty()) {
            RecordInfo duplicate = remote(record.serverUrl, record.taskId);
            RecordInfo incoming = record.id == 0 ? null : get(record.id);
            if (record.id > 0 && incoming == null && duplicate == null) {
                // A stale async callback must not resurrect a user-deleted row.
                db.setTransactionSuccessful();
                return record;
            }
            if (duplicate != null && duplicate.id != record.id) {
                if (record.filePath.isEmpty()) record.filePath = duplicate.filePath;
                if (record.id == 0 || incoming == null || (incoming.filePath.isEmpty() && !duplicate.filePath.isEmpty())) {
                    if (incoming != null) db.delete("records", "id=?", new String[]{String.valueOf(incoming.id)});
                    record.id = duplicate.id;
                    record.title = duplicate.title;
                    record.favorite = duplicate.favorite;
                    record.createdAt = duplicate.createdAt;
                } else {
                    db.delete("records", "id=?", new String[]{String.valueOf(duplicate.id)});
                }
            }
        }
        ContentValues values = new ContentValues();
        values.put("task_id", record.taskId); values.put("title", record.title); values.put("file_name", record.fileName);
        values.put("file_path", record.filePath); values.put("server_url", record.serverUrl); values.put("status", record.status);
        values.put("message", record.message); values.put("result_json", record.resultJson); values.put("duration", record.duration);
        values.put("created_at", record.createdAt); values.put("favorite", record.favorite ? 1 : 0);
        if (record.id == 0) record.id = db.insertOrThrow("records", null, values);
        else db.update("records", values, "id=?", new String[]{String.valueOf(record.id)});
        db.setTransactionSuccessful();
        return record;
        } finally { db.endTransaction(); }
    }
    synchronized RecordInfo get(long id) {
        try (Cursor cursor = getReadableDatabase().query("records", null, "id=?", new String[]{String.valueOf(id)}, null, null, null)) {
            return cursor.moveToFirst() ? row(cursor) : null;
        }
    }
    synchronized RecordInfo remote(String server, String taskId) {
        try (Cursor cursor = getReadableDatabase().query("records", null, "server_url=? AND task_id=?", new String[]{server,taskId}, null, null, null)) {
            return cursor.moveToFirst() ? row(cursor) : null;
        }
    }
    synchronized List<RecordInfo> list(String query, boolean favorites) {
        String filter = favorites ? "favorite=1" : "1=1";
        List<String> arguments = new ArrayList<>();
        if (query != null && !query.trim().isEmpty()) {
            filter += " AND (title LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\' OR result_json LIKE ? ESCAPE '\\')";
            String pattern = "%" + query.trim().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
            for (int i = 0; i < 3; i++) arguments.add(pattern);
        }
        List<RecordInfo> records = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query("records", null, filter, arguments.toArray(new String[0]), null, null, "created_at DESC, id DESC")) {
            while (cursor.moveToNext()) records.add(row(cursor));
        }
        return records;
    }
    synchronized void delete(long id) { getWritableDatabase().delete("records", "id=?", new String[]{String.valueOf(id)}); }
    private RecordInfo row(Cursor cursor) {
        RecordInfo record = new RecordInfo();
        record.id = cursor.getLong(cursor.getColumnIndexOrThrow("id"));
        record.taskId = cursor.getString(cursor.getColumnIndexOrThrow("task_id"));
        record.title = cursor.getString(cursor.getColumnIndexOrThrow("title"));
        record.fileName = cursor.getString(cursor.getColumnIndexOrThrow("file_name"));
        record.filePath = cursor.getString(cursor.getColumnIndexOrThrow("file_path"));
        record.serverUrl = cursor.getString(cursor.getColumnIndexOrThrow("server_url"));
        record.status = cursor.getString(cursor.getColumnIndexOrThrow("status"));
        record.message = cursor.getString(cursor.getColumnIndexOrThrow("message"));
        record.resultJson = cursor.getString(cursor.getColumnIndexOrThrow("result_json"));
        record.duration = cursor.getDouble(cursor.getColumnIndexOrThrow("duration"));
        record.createdAt = cursor.getLong(cursor.getColumnIndexOrThrow("created_at"));
        record.favorite = cursor.getInt(cursor.getColumnIndexOrThrow("favorite")) == 1;
        return record;
    }
}
