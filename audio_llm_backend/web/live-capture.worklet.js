/* Capture mono speech at 16 kHz without feeding the microphone to the speakers. */
class SpeechPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.remaining = this.ratio;
    this.sum = 0;
    this.buffer = new Float32Array(2048);
    this.position = 0;
    this.flushed = false;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.flushed = true;
        this.send();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }
  send() {
    if (!this.position) return;
    const data = this.buffer.slice(0, this.position);
    this.port.postMessage({ type: "pcm", data }, [data.buffer]);
    this.position = 0;
  }
  process(inputs) {
    if (this.flushed) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let value = 0;
      for (const channel of channels) value += channel[index] / channels.length;
      let available = 1;
      while (available > 1e-8) {
        const amount = Math.min(available, this.remaining);
        this.sum += value * amount;
        this.remaining -= amount;
        available -= amount;
        if (this.remaining < 1e-8) {
          this.buffer[this.position++] = this.sum / this.ratio;
          this.sum = 0;
          this.remaining = this.ratio;
          if (this.position === this.buffer.length) this.send();
        }
      }
    }
    return true;
  }
}
registerProcessor("speech-pcm-capture", SpeechPcmCapture);
