package com.example.audioinsight.data;

/** Repository callbacks always arrive on the main thread. */
public interface Callback<T> {
    void onSuccess(T value);
    void onError(String message);
}
