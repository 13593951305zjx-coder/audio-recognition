/* Original-timeline playback shared by transcript, review and keyword results. */
(() => {
  class SourceMediaPlayer {
    constructor({ container, video, audio, title, caption, error, onChange, formatTime }) {
      Object.assign(this, { container, video, audio, title, caption, error, onChange, formatTime });
      this.serial = 0;
      for (const element of [audio, video]) {
        element.addEventListener("play", () => {
          if (element !== this.element) { element.pause(); return; }
          if (this.range) { this.range.state = "playing"; this.emit(); this.scheduleEnd(); }
        });
        element.addEventListener("pause", () => {
          clearTimeout(this.endTimer);
          if (this.range && element === this.element) { this.range.state = "paused"; this.emit(); }
        });
        element.addEventListener("timeupdate", () => { if (element === this.element) this.checkEnd(); });
        element.addEventListener("ratechange", () => { if (element === this.element) this.scheduleEnd(); });
        element.addEventListener("ended", () => { if (element === this.element) this.finish(); });
        element.addEventListener("seeking", () => {
          if (element !== this.element || !this.range) return;
          // Seeking outside the chosen sentence deliberately returns to normal playback.
          if (element.currentTime < this.range.start - 0.15 || element.currentTime > this.range.end + 0.15) {
            this.range = null; clearTimeout(this.endTimer); this.emit(); this.caption.textContent = "正在浏览原文件，可点击句子重新定位。";
          }
        });
        element.addEventListener("seeked", () => { if (element === this.element) this.scheduleEnd(); });
        element.addEventListener("error", () => {
          if (element === this.element && element.getAttribute("src")) {
            this.stop(); this.showError(this.info?.kind === "video" ? "浏览器无法播放此视频的编码，请转换为 H.264 编码的 MP4 后重新导入。" : "浏览器无法播放此音频，请转换为 MP3 或 WAV 后重新导入。");
          }
        });
      }
    }
    emit() { this.onChange(this.range ? { ...this.range, taskId: this.taskId } : null, this.info); }
    showError(message) { this.error.textContent = message; this.error.hidden = !message; }
    stop() {
      this.serial++; clearTimeout(this.endTimer); this.range = null;
      this.audio.pause(); this.video.pause(); this.emit();
    }
    prepare(taskId, fileName) {
      if (this.taskId === taskId && !this.error.textContent) return this.ready;
      this.stop(); this.controller?.abort(); this.taskId = taskId; this.info = null; this.element = null;
      for (const element of [this.audio, this.video]) { element.removeAttribute("src"); element.load(); element.hidden = true; }
      this.container.hidden = !taskId; this.title.textContent = fileName || "原始音视频"; this.showError("");
      if (!taskId) { this.ready = Promise.resolve(null); return this.ready; }
      this.caption.textContent = "正在读取原文件，点击转写句子即可定位播放。";
      const controller = new AbortController(); this.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 20000);
      this.ready = (async () => {
        try {
          const response = await fetch(`/api/recognition/${encodeURIComponent(taskId)}/media`, { signal: controller.signal });
          const info = await response.json();
          if (this.taskId !== taskId || controller.signal.aborted) return null;
          if (!response.ok) throw new Error(info.detail || "无法打开原文件");
          this.info = info; this.element = info.kind === "video" ? this.video : this.audio;
          this.element.hidden = false; this.element.src = info.url; this.element.load();
          this.caption.textContent = `${info.kind === "video" ? "视频" : "音频"}原文件 · 点击一句转写，从该句开始播放，到句尾暂停。`;
          this.emit(); return info;
        } catch (error) {
          if (this.taskId === taskId && this.controller === controller) this.showError(error.name === "AbortError" ? "原文件读取超时，请重新打开记录" : error.message);
          return null;
        } finally { clearTimeout(timeout); }
      })();
      return this.ready;
    }
    async waitMetadata(element, serial) {
      if (element.readyState >= 1) return;
      if (element.error) throw new Error("浏览器无法载入此文件，请检查文件格式");
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); element.removeEventListener("loadedmetadata", loaded); element.removeEventListener("error", failed); };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("无法载入原文件，请检查浏览器是否支持其编码")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("等待播放器载入超时，请重试")); }, 20000);
        element.addEventListener("loadedmetadata", loaded, {once:true}); element.addEventListener("error", failed, {once:true});
        if (serial !== this.serial) { cleanup(); resolve(); }
      });
    }
    async playRange(index, start, end) {
      if (![start, end].every(Number.isFinite) || start < 0 || end <= start) return;
      if (this.range?.index === index && this.range.state !== "paused") { this.stop(); return; }
      this.stop(); const serial = this.serial;
      this.range = { index, start, end, state: "loading" }; this.emit(); this.showError("");
      try {
        const info = await this.ready;
        if (serial !== this.serial) return;
        if (!info || !this.element) throw new Error(this.error.textContent || "没有可播放的原文件");
        const element = this.element;
        await this.waitMetadata(element, serial);
        if (serial !== this.serial) return;
        if (Number.isFinite(element.duration)) {
          if (start >= element.duration) throw new Error("这句话的时间超出了原文件范围");
          this.range.end = Math.min(end, element.duration);
        }
        element.currentTime = start;
        this.caption.textContent = `本次播放：${this.formatTime(start)}–${this.formatTime(this.range.end)} · 到句尾自动暂停`;
        this.container.scrollIntoView({block:"nearest", behavior:"smooth"});
        await element.play();
        if (serial !== this.serial) return;
        this.range.state = "playing"; this.emit(); this.scheduleEnd();
      } catch (error) {
        if (serial !== this.serial) return;
        this.stop(); this.showError(error.message || "原文件播放失败，请重试");
      }
    }
    checkEnd() {
      if (!this.range || !this.element || this.element.seeking) return;
      if (this.element.currentTime >= this.range.end - 0.015) this.finish();
    }
    scheduleEnd() {
      clearTimeout(this.endTimer);
      if (!this.range || !this.element || this.element.paused || this.element.seeking) return;
      const remaining = this.range.end - this.element.currentTime;
      if (remaining <= 0.015) { this.finish(); return; }
      this.endTimer = setTimeout(() => {
        this.checkEnd(); if (this.range) this.scheduleEnd();
      }, Math.max(20, remaining / Math.max(0.1, this.element.playbackRate) * 1000));
    }
    finish() {
      if (!this.range) return;
      const end = this.range.end; this.stop();
      if (this.element && Number.isFinite(end)) this.element.currentTime = end;
      this.caption.textContent = `已播放到 ${this.formatTime(end)}，点击其他句子可继续定位。`;
    }
  }
  window.SourceMediaPlayer = SourceMediaPlayer;
})();
