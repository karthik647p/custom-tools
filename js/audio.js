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
    // the phone may suspend audio while the screen is off; tell listeners when it wakes so they can reschedule
    ctx.addEventListener('statechange', () => { if (ctx.state === 'running') unlockListeners.forEach((fn) => fn()); });
  }
  return ctx;
}

const SPECS = {
  // gentle double "bip"
  soft: { wave: 'sine', freqs: [660, 660], on: 0.2, off: 0.14, tail: 0.95, amp: 0.3, atk: 0.025, rel: 0.12 },
  // piercing alternating siren-style burst
  loud: { wave: 'square', freqs: [1100, 1500, 1100, 1500, 1100, 1500], on: 0.14, off: 0.05, tail: 0.4, amp: 0.95, atk: 0.003, rel: 0.01 },
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

/**
 * Slider (0-1) to gain. Hearing is logarithmic, so a linear slider barely seems to change anything
 * (50% would only be -6 dB). This maps the slider linearly in decibels: 100% = full, 50% = -15 dB, 5% = -28 dB.
 */
export const volToGain = (v) => 10 ** ((-30 * (1 - Math.min(1, Math.max(0, v)))) / 20);

/** Loudness (dBFS RMS, over the beep part only) of a built-in sound at a slider setting; used for testing. */
export function levelDb(kind, volume = 1) {
  const buf = bufferFor(kind);
  const d = buf.getChannelData(0);
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1e-4) { sum += d[i] * d[i]; n++; }
  return 10 * Math.log10(sum / n) + 20 * Math.log10(volToGain(volume));
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
    // normalise: a quiet recording would otherwise ignore the volume setting's range
    let peak = 0;
    for (let ch = 0; ch < out.numberOfChannels; ch++) for (const s of out.getChannelData(ch)) peak = Math.max(peak, Math.abs(s));
    if (peak > 0) {
      const k = Math.min(8, 0.9 / peak);
      for (let ch = 0; ch < out.numberOfChannels; ch++) { const d = out.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= k; }
    }
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
    gain.gain.value = volToGain(volume);
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
      setVolume(v) { gain.gain.value = volToGain(v); },
    };
    src.onended = () => { handle.ended = true; handle.onended?.(); };
    return handle;
  },
};

// Keep-alive: a looping <audio> that Chrome counts as real playback, so Android doesn't freeze the
// page when the screen turns off. Pure digital silence does NOT work: Chrome treats it as "not
// playing audio" and freezes the page anyway. So this is a 20 Hz tone at about -50 dBFS: well above
// Chrome's silence threshold (~-72 dBFS) but far below hearing and below what phone speakers can produce.
export const KEEPALIVE = { rate: 8000, hz: 20, amp: 0.004 };

/** 1 second of mono 16-bit PCM WAV; exactly 20 whole cycles, so the loop has no click. */
export function keepAliveWav() {
  const { rate, hz, amp } = KEEPALIVE;
  const bytes = rate * 2;
  const b = new DataView(new ArrayBuffer(44 + bytes));
  const w = (o, s) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  w(36, 'data'); b.setUint32(40, bytes, true);
  for (let i = 0; i < rate; i++) b.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767), true);
  return new Blob([b], { type: 'audio/wav' });
}

let keepEl = null;
export const keepAlive = {
  start() {
    if (!keepEl) {
      keepEl = new Audio(URL.createObjectURL(keepAliveWav()));
      keepEl.loop = true;
    }
    if (keepEl.paused) keepEl.play().catch(() => {});
  },
  stop() { keepEl?.pause(); },
  get playing() { return !!keepEl && !keepEl.paused; },
};
