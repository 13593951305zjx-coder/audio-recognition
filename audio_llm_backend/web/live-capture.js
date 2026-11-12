/* Short overlapping windows use the local ASR endpoint; the full recording stays intact. */
(() => {
  const RATE = 16000;
  function encodeWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, samples.length * 2, true);
    samples.forEach((value, index) => { const sample = Math.max(-1, Math.min(1, value)); view.setInt16(44 + index * 2, sample * (sample < 0 ? 32768 : 32767), true); });
    return new Blob([buffer], { type: "audio/wav" });
  }
  class LocalLiveTranscription {
    constructor({ onUpdate, maxSeconds = 300 }) {
      this.onUpdate = onUpdate;
      this.samples = new Float32Array(Math.max(1, maxSeconds) * RATE);
      this.total = 0; this.cursor = 0; this.lines = [];
      this.stopped = false; this.cancelled = false; this.pumping = false; this.failed = false;
      this.error = ""; this.retryCount = 0;
    }
    emit(state) {
      if (!this.cancelled) this.onUpdate({ state, error: this.error, lines: this.lines,
        processedSeconds: this.cursor / RATE, totalSeconds: this.total / RATE });
    }
    async start(stream) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass || !window.AudioWorkletNode) throw new Error("此浏览器不支持本地实时采音，可停录后上传识别");
      this.context = new AudioContextClass();
      try {
        await this.context.audioWorklet.addModule("/static/live-capture.worklet.js");
        this.node = new AudioWorkletNode(this.context, "speech-pcm-capture");
        this.source = this.context.createMediaStreamSource(stream);
        this.node.port.onmessage = (event) => {
          if (event.data.type === "flushed") { this.flushDone?.(); return; }
          if (this.cancelled || event.data.type !== "pcm") return;
          const data = event.data.data.subarray(0, this.samples.length - this.total);
          this.samples.set(data, this.total); this.total += data.length;
          this.pump();
        };
        this.node.onprocessorerror = () => { this.failed = true; this.error = "实时采音中断，完整录音仍可停录后上传识别"; this.emit("error"); };
        this.source.connect(this.node);
        this.node.connect(this.context.destination); // The processor produces silence.
        await this.context.resume();
        this.emit("listening");
      } catch (error) { await this.closeCapture(false); throw error; }
    }
    async closeCapture(flush = true) {
      if (!this.context || this.context.state === "closed") return;
      if (flush && this.node) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 500);
          this.flushDone = () => { clearTimeout(timer); resolve(); };
          this.node.port.postMessage("flush");
        });
      }
      this.source?.disconnect(); this.node?.disconnect();
      this.node?.port.close();
      await this.context.close();
    }
    async stop() {
      await this.closeCapture();
      this.stopped = true;
      this.pump();
    }
    cancel() {
      this.cancelled = true;
      this.requestController?.abort();
      this.closeCapture(false).catch(() => {});
    }
    async pump() {
      if (this.pumping || this.cancelled || this.failed) return;
      this.pumping = true;
      try {
        while (!this.cancelled && !this.failed) {
          const remaining = this.total - this.cursor;
          if (remaining < (this.stopped ? RATE / 4 : RATE * 4)) break;
          const start = Math.max(0, this.cursor - RATE);
          const end = Math.min(this.total, this.cursor + RATE * (remaining > RATE * 8 ? 8 : 4));
          const cut = (this.cursor - start) / RATE;
          this.emit(this.stopped ? "finishing" : "recognizing");
          const controller = new AbortController(); this.requestController = controller;
          const timer = setTimeout(() => controller.abort(), 90000);
          try {
            const response = await fetch("/api/live/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeWav(this.samples.subarray(start, end)), signal: controller.signal });
            const data = await response.json().catch(() => null);
            if (this.cancelled) return;
            if (response.status === 409 && this.retryCount++ < 8) {
              this.emit("waiting"); await new Promise((resolve) => setTimeout(resolve, 1500)); continue;
            }
            if (!response.ok) throw new Error(data?.detail || `实时转写请求失败（${response.status}）`);
            this.retryCount = 0;
            const text = (data.words || []).filter((word) => (word.start + word.end) / 2 >= cut).map((word) => word.word).join("").trim();
            if (text) this.lines.push({ start: this.cursor / RATE, end: end / RATE, text });
            this.cursor = end;
            this.emit(this.stopped ? "finishing" : "listening");
          } catch (error) {
            if (this.cancelled) return;
            this.failed = true;
            this.error = error.name === "AbortError" ? "实时转写等待超时，录音仍可停止后完整识别" : `${error.message}。录音仍可停止后完整识别。`;
            this.emit("error");
          } finally { clearTimeout(timer); }
        }
      } finally {
        this.pumping = false;
        if (!this.cancelled && !this.failed) this.emit(this.stopped ? "complete" : "listening");
      }
    }
  }
  window.LocalLiveTranscription = LocalLiveTranscription;
})();
