/* Capture and mix audio only; display video is never passed to MediaRecorder. */
(() => {
  class RecordingAudioInput {
    constructor({ onEnded = () => {} } = {}) {
      this.onEnded = onEnded;
      this.inputs = [];
      this.nodes = [];
      this.listeners = [];
      this.closed = false;
      this.ended = false;
    }

    async retain(promise) {
      const stream = await promise;
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('录音准备已取消');
      }
      this.inputs.push(stream);
      return stream;
    }

    async start(mode = 'microphone') {
      const devices = navigator.mediaDevices;
      if (!devices?.getUserMedia) throw new Error('当前浏览器不支持录音，请用 Chrome 或 Edge 打开本机网址');
      if (!['microphone', 'mixed', 'system'].includes(mode)) throw new Error('录音来源无效');
      try {
        if (mode !== 'microphone') {
          if (!devices.getDisplayMedia) throw new Error('当前浏览器不提供电脑声音录制，请用 Chrome 或 Edge 打开本机网址');
          // This must be the first permission request in the user's click handler.
          const display = await this.retain(devices.getDisplayMedia({
            video: true,
            audio: { suppressLocalAudioPlayback: false },
            systemAudio: 'include',
            selfBrowserSurface: 'exclude',
            surfaceSwitching: 'exclude',
          }));
          if (!display.getAudioTracks().some((track) => track.readyState === 'live')) {
            throw new Error('没有获取到电脑声音。请重新选择整个屏幕或浏览器标签页，并勾选“共享音频 / 系统音频”');
          }
        }
        if (mode !== 'system') await this.retain(devices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }));
        if (this.inputs.some((stream) => !stream.getAudioTracks().some((track) => track.readyState === 'live'))) {
          throw new Error('声音来源已断开，请重新开始录音');
        }
        if (mode === 'microphone') {
          this.stream = this.inputs[0];
        } else {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextClass) throw new Error('当前浏览器不支持声音混合，请用 Chrome 或 Edge 打开');
          this.context = new AudioContextClass();
          this.destination = this.context.createMediaStreamDestination();
          for (const input of this.inputs) {
            const audio = new MediaStream(input.getAudioTracks());
            const source = this.context.createMediaStreamSource(audio);
            const gain = this.context.createGain();
            // Two full-scale inputs together retain headroom instead of clipping.
            gain.gain.value = 1 / this.inputs.length;
            source.connect(gain);
            gain.connect(this.destination);
            this.nodes.push(source, gain);
          }
          this.stream = this.destination.stream;
          // Never connect captured audio to the speakers: this prevents feedback.
          await this.context.resume();
        }
        if (this.closed) throw new Error('录音准备已取消');
        if (this.inputs.some((input) => !input.getAudioTracks().some((track) => track.readyState === 'live'))) {
          throw new Error('声音来源已断开，请重新开始录音');
        }
        for (const input of this.inputs) {
          for (const track of input.getTracks()) {
            const listener = () => {
              if (this.closed || this.ended) return;
              this.ended = true;
              this.onEnded();
            };
            track.addEventListener('ended', listener);
            this.listeners.push([track, listener]);
          }
        }
        return this.stream;
      } catch (error) {
        this.close();
        if (error.name === 'NotAllowedError') throw new Error('未获得录音权限。请允许麦克风及所选声音来源后重试');
        if (error.name === 'NotFoundError') throw new Error('没有找到可用的录音设备或共享音频来源');
        if (error.name === 'NotSupportedError') throw new Error('此浏览器不支持所选声音来源，请用 Chrome 或 Edge 打开本机网址');
        throw error;
      }
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.listeners.forEach(([track, listener]) => track.removeEventListener('ended', listener));
      this.listeners = [];
      this.nodes.forEach((node) => node.disconnect());
      this.nodes = [];
      for (const stream of new Set([...this.inputs, this.stream].filter(Boolean))) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
    }
  }
  window.RecordingAudioInput = RecordingAudioInput;
})();
