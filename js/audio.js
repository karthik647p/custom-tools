// Alarm sounds. Beeps are synthesized into AudioBuffers once, then played (and looped)
// on the audio clock, so alarms don't depend on JS timers staying un-throttled.
let ctx = null;
const buffers = {};
let customBuf = null;
const unlockListeners = new Set();

function getCtx() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C({ latencyHint: 'playback' });
  }
  return ctx;
}

const SPECS = {
  // gentle double "bip"
  soft: { wave: 'sine', freqs: [660, 660], on: 0.2, off: 0.14, tail: 0.95, amp: 0.45, atk: 0.025, rel: 0.12 },
  // piercing alternating siren-style burst
  loud: { wave: 'square', freqs: [1100, 1500, 1100, 1500], on: 0.13, off: 0.07, tail: 0.5, amp: 0.7, atk: 0.004, rel: 0.012 },
};

function synth(kind) {
  const c = getCtx();
  const sr = c.sampleRate;
  const { wave, freqs, on, off, tail, amp, atk, rel } = SPECS[kind];
  const buf = c.createBuffer(1, Math.ceil(sr * (freqs.length * (on + off) + tail)), sr);
  const data = buf.getChannelData(0);
  freqs.forEach((f, i) => {
    const start = Math.floor(i * (on + off) * sr);
    const n = Math.floor(on * sr);
    for (let k = 0; k < n; k++) {
      const t = k / sr;
      const env = Math.max(0, Math.min(1, t / atk, (on - t) / rel));
      const s = Math.sin(2 * Math.PI * f * t);
      data[start + k] = amp * env * (wave === 'sine' ? s : s >= 0 ? 1 : -1);
    }
  });
  return buf;
}

function bufferFor(kind) {
  if (kind === 'custom' && customBuf) return customBuf;
  const k = kind === 'soft' ? 'soft' : 'loud'; // no custom file chosen yet -> loud beep
  return (buffers[k] ||= synth(k));
}

export const alarm = {
  get supported() { return !!(window.AudioContext || window.webkitAudioContext); },
  running: () => !!ctx && ctx.state === 'running',

  /** Call from a user gesture (tap). Browsers keep audio muted until then. */
  async unlock() {
    const c = getCtx();
    if (!c) return;
    if (c.state !== 'running') {
      try { await c.resume(); } catch { /* still locked */ }
      if (c.state === 'running') unlockListeners.forEach((fn) => fn());
    }
  },
  onUnlock(fn) { unlockListeners.add(fn); },

  /** Decode a user-picked audio file for use as the "custom" sound. */
  async loadCustom(blob) {
    const c = getCtx();
    if (!c) throw new Error('Audio not supported');
    const decoded = await c.decodeAudioData(await blob.arrayBuffer());
    // pad with a short silence so looping repeats breathe
    const gap = Math.floor(decoded.sampleRate * 0.6);
    const out = c.createBuffer(decoded.numberOfChannels, decoded.length + gap, decoded.sampleRate);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) out.getChannelData(ch).set(decoded.getChannelData(ch));
    customBuf = out;
    return decoded.duration;
  },
  clearCustom() { customBuf = null; },
  hasCustom: () => !!customBuf,

  /**
   * Play a sound. `delay` (s) schedules it on the audio clock; `loop` repeats it,
   * optionally cut off after `seconds`. Returns a handle, or null if audio is unavailable.
   */
  play({ kind = 'soft', volume = 0.8, loop = false, seconds = 0, delay = 0 } = {}) {
    const c = getCtx();
    if (!c) return null;
    if (c.state !== 'running') c.resume().catch(() => {});
    const src = c.createBufferSource();
    src.buffer = bufferFor(kind);
    src.loop = loop;
    const gain = c.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(c.destination);
    const t0 = c.currentTime + delay;
    src.start(t0);
    if (loop && seconds > 0) src.stop(t0 + seconds);
    const handle = {
      ended: false,
      onended: null,
      stop() {
        handle.onended = null;
        handle.ended = true;
        try { src.stop(); } catch { /* not started */ }
        try { src.disconnect(); gain.disconnect(); } catch { /* already gone */ }
      },
      setVolume(v) { gain.gain.value = v; },
    };
    src.onended = () => { handle.ended = true; handle.onended?.(); };
    return handle;
  },
};

// A silent looping <audio> keeps the page "playing media" so Android is less eager
// to freeze it when the screen turns off mid-countdown.
let keepEl = null;
function silentWavUrl() {
  const rate = 8000, n = rate; // 1 second of silence, 8-bit mono
  const b = new DataView(new ArrayBuffer(44 + n));
  const w = (o, s) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true);
  w(36, 'data'); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

export const keepAlive = {
  start() {
    if (!keepEl) {
      keepEl = new Audio(silentWavUrl());
      keepEl.loop = true;
    }
    if (keepEl.paused) keepEl.play().catch(() => {});
  },
  stop() { keepEl?.pause(); },
};
