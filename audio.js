//SWITCHING from dB to the linear scale

const TRUMPET = {
  // H1  524 Hz  -38.3 dB → 0.44   H2  1047 Hz -31.5 dB → 1.00 (anchor)
  // H3 1571 Hz  -32.5 dB → 0.89   H4  2095 Hz -46.1 dB → 0.19
  // H5 2618 Hz  -45.7 dB → 0.20   H6  3159 Hz -70.0 dB → 0.03
  // H7 3665 Hz  -54.9 dB → 0.10   H8  4189 Hz -65.9 dB → 0.05
  harmonics:   [[1,0.44],[2,1.00],[3,0.89],[4,0.19],[5,0.20],[6,0.03],[7,0.10],[8,0.05]],
  attack:      0.04,
  release:     0.20,
  vibratoAmt:  0.002,
  vibratoRate: 5.8,
};

const VIOLIN = {
  // H1  522 Hz  -33.4 dB → 1.00 (anchor)  H2 1039 Hz -36.5 dB → 0.73
  // H3 1573 Hz  -37.3 dB → 0.68           H4 2097 Hz -41.8 dB → 0.39
  // H5 2616 Hz  -61.6 dB → 0.05           H6 3154 Hz -43.1 dB → 0.35
  // H7 3626 Hz  -45.6 dB → 0.25           H8 4206 Hz -56.4 dB → 0.09
  harmonics:   [[1,1.00],[2,0.73],[3,0.68],[4,0.39],[5,0.05],[6,0.35],[7,0.25],[8,0.09]],
  attack:      0.10,
  release:     0.30,
  vibratoAmt:  0.006,
  vibratoRate: 6.2,
};

const FLUTE = {
  // H1  529 Hz  -23.1 dB → 1.00 (anchor)  H2 1060 Hz -34.8 dB → 0.29
  // H3 1590 Hz  -46.1 dB → 0.07           H4 2124 Hz -49.3 dB → 0.05
  // H5 2631 Hz  -60.3 dB → 0.02           H6 3162 Hz -68.4 dB → 0.01
  // H7 3684 Hz  -75.2 dB → 0.005          H8 4228 Hz -76.6 dB → 0.004
  harmonics:   [[1,1.00],[2,0.29],[3,0.07],[4,0.05],[5,0.02],[6,0.01],[7,0.005],[8,0.004]],
  attack:      0.12,
  release:     0.35,
  vibratoAmt:  0.003,
  vibratoRate: 5.5,
};

const N_HARMONICS = 8;
const NOTES = ['C','D','E','F','G','A','B'];


const VERTICES = {
  trumpet: { x: 0.18, y: 0.08 },   // top-left
  violin:  { x: 0.82, y: 0.08 },   // top-right
  flute:   { x: 0.50, y: 0.92 },   // bottom-center
};

function _rawBarycentric(px, py) {
  const { trumpet: A, violin: B, flute: C } = VERTICES;
  const denom = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
  const wT = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / denom;
  const wV = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / denom;
  const wF = 1 - wT - wV;
  return { wT, wV, wF };
}


function clampToTriangle(px, py) {
  const { trumpet: A, violin: B, flute: C } = VERTICES;
  let { wT, wV, wF } = _rawBarycentric(px, py);


  if (wT >= 0 && wV >= 0 && wF >= 0) return { x: px, y: py };


  wT = Math.max(0, wT);
  wV = Math.max(0, wV);
  wF = Math.max(0, wF);
  const sum = wT + wV + wF;
  wT /= sum; wV /= sum; wF /= sum;

  return {
    x: wT * A.x + wV * B.x + wF * C.x,
    y: wT * A.y + wV * B.y + wF * C.y,
  };
}


function barycentricWeights(px, py) {
  let { wT, wV, wF } = _rawBarycentric(px, py);
  wT = Math.max(0, wT);
  wV = Math.max(0, wV);
  wF = Math.max(0, wF);
  const sum = wT + wV + wF;
  return { wT: wT / sum, wV: wV / sum, wF: wF / sum };
}


// HARMONIC BLENDING
/**
 * returns an array of 8 blended amplitudes given three instrument weights
 * @param {number} wT - trumpet weight
 * @param {number} wV - violin weight
 * @param {number} wF - flute weight
 * @returns {number[]} 8 amplitudes
 */
function blendHarmonics(wT, wV, wF) {
  return TRUMPET.harmonics.map(([, ampT], i) => {
    const ampV = VIOLIN.harmonics[i][1];
    const ampF = FLUTE.harmonics[i][1];
    return wT * ampT + wV * ampV + wF * ampF;
  });
}



let audioCtx    = null;
let isPlaying   = false;

// Current pad position — starts at centroid (equal mix)
let padX = 0.50;
let padY = 0.37;

// Blended weights — updated on every pad interaction
let weights = { wT: 1/3, wV: 1/3, wF: 1/3 };

let currentNote = 'C';
let currentOct  = 4;
let reverbMix   = 0.3;

// Audio nodes
let masterGain  = null;
let dryGain     = null;
let wetGain     = null;
let reverbBus   = null;
let envGain     = null;
let vibratoOsc  = null;
let vibratoGain = null;

// oscs[i] = { osc, gainNode } — one per harmonic partial
let oscs = [];


// EXTRA FEATURES

function noteToFreq(note, octave) {
  const semis = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  return 440 * Math.pow(2, ((octave + 1) * 12 + semis[note] - 69) / 12);
}

function blendParam(a, b, c, wT, wV, wF) {
  return wT * a + wV * b + wF * c;
}

function buildImpulseResponse(ctx) {
  const len = Math.floor(ctx.sampleRate * 2.0);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
  }
  return buf;
}



function startAudio() {
  if (isPlaying) return;

  audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.7;
  masterGain.connect(audioCtx.destination);

  dryGain = audioCtx.createGain();
  dryGain.gain.value = 1 - reverbMix;
  dryGain.connect(masterGain);

  wetGain = audioCtx.createGain();
  wetGain.gain.value = reverbMix;
  wetGain.connect(masterGain);

  const convolver  = audioCtx.createConvolver();
  convolver.buffer = buildImpulseResponse(audioCtx);
  reverbBus        = audioCtx.createGain();
  reverbBus.gain.value = 1;
  reverbBus.connect(convolver);
  convolver.connect(wetGain);

  envGain = audioCtx.createGain();
  envGain.gain.setValueAtTime(0, audioCtx.currentTime);
  envGain.connect(dryGain);
  envGain.connect(reverbBus);


  vibratoOsc        = audioCtx.createOscillator();
  vibratoOsc.type   = 'sine';
  vibratoGain       = audioCtx.createGain();
  vibratoOsc.connect(vibratoGain);
  vibratoOsc.start();

  // create 8 additive oscillators
  const freq    = noteToFreq(currentNote, currentOct);
  const { wT, wV, wF } = weights;
  const blended = blendHarmonics(wT, wV, wF);

  oscs = TRUMPET.harmonics.map(([h], i) => {
    const osc = audioCtx.createOscillator();
    osc.type            = 'sine';
    osc.frequency.value = freq * h;
    vibratoGain.connect(osc.frequency);

    const gn = audioCtx.createGain();
    gn.gain.value = blended[i];
    osc.connect(gn);
    gn.connect(envGain);
    osc.start();
    return { osc, gainNode: gn };
  });

  updateVibrato(freq);

  // attack
  const attackTime = blendParam(TRUMPET.attack, VIOLIN.attack, FLUTE.attack, wT, wV, wF);
  const t = audioCtx.currentTime;
  envGain.gain.setValueAtTime(0, t);
  envGain.gain.linearRampToValueAtTime(0.85, t + attackTime);

  isPlaying = true;
  setStatus(true);
  document.getElementById('btn-play').classList.add('active');
}

function stopAudio() {
  if (!isPlaying || !audioCtx) return;

  const { wT, wV, wF } = weights;
  const releaseTime = blendParam(TRUMPET.release, VIOLIN.release, FLUTE.release, wT, wV, wF);
  const t = audioCtx.currentTime;

  envGain.gain.cancelScheduledValues(t);
  envGain.gain.setValueAtTime(envGain.gain.value, t);
  envGain.gain.linearRampToValueAtTime(0, t + releaseTime);

  setTimeout(() => {
    oscs.forEach(({ osc }) => { try { osc.stop(); } catch (_) {} });
    try { vibratoOsc.stop(); } catch (_) {}
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
    oscs     = [];
  }, (releaseTime + 0.2) * 1000);

  isPlaying = false;
  setStatus(false);
  document.getElementById('btn-play').classList.remove('active');
}



function applyMix() {
  const { wT, wV, wF } = weights;
  const blended = blendHarmonics(wT, wV, wF);

  // Update oscillator gains smoothly
  if (isPlaying && audioCtx) {
    const t = audioCtx.currentTime;
    oscs.forEach(({ gainNode }, i) => {
      gainNode.gain.setTargetAtTime(blended[i], t, 0.04);
    });
    updateVibrato(noteToFreq(currentNote, currentOct));
  }

  // UI — weights
  const pT = Math.round(wT * 100);
  const pV = Math.round(wV * 100);
  const pF = Math.round(wF * 100);

  document.getElementById('w-trumpet').textContent  = pT + '%';
  document.getElementById('w-violin').textContent   = pV + '%';
  document.getElementById('w-flute').textContent    = pF + '%';
  document.getElementById('bar-trumpet').style.width = pT + '%';
  document.getElementById('bar-violin').style.width  = pV + '%';
  document.getElementById('bar-flute').style.width   = pF + '%';
  document.getElementById('pct-trumpet').textContent = pT + '%';
  document.getElementById('pct-violin').textContent  = pV + '%';
  document.getElementById('pct-flute').textContent   = pF + '%';
  document.getElementById('footer-coords').textContent =
    `T:${wT.toFixed(2)} · V:${wV.toFixed(2)} · F:${wF.toFixed(2)}`;

  updateSpectrum(blended);
}

function updateVibrato(freq) {
  if (!vibratoOsc || !vibratoGain) return;
  const { wT, wV, wF } = weights;
  const rate  = blendParam(TRUMPET.vibratoRate, VIOLIN.vibratoRate, FLUTE.vibratoRate, wT, wV, wF);
  const depth = blendParam(TRUMPET.vibratoAmt,  VIOLIN.vibratoAmt,  FLUTE.vibratoAmt,  wT, wV, wF);
  vibratoOsc.frequency.setTargetAtTime(rate,        audioCtx.currentTime, 0.05);
  vibratoGain.gain.setTargetAtTime(freq * depth,    audioCtx.currentTime, 0.05);
}

function retuneOscs() {
  if (!isPlaying || !audioCtx) return;
  const freq = noteToFreq(currentNote, currentOct);
  const t    = audioCtx.currentTime;
  TRUMPET.harmonics.forEach(([h], i) => {
    oscs[i].osc.frequency.setTargetAtTime(freq * h, t, 0.04);
  });
  updateVibrato(freq);
}


// ─────────────────────────────────────────────────────────────────────────────
// 8. CANVAS — draw triangle pad + cursor
// ─────────────────────────────────────────────────────────────────────────────

function drawPad() {
  const canvas = document.getElementById('pad');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Convert normalised vertex positions to canvas pixels
  const A = { x: VERTICES.trumpet.x * W, y: VERTICES.trumpet.y * H };
  const B = { x: VERTICES.violin.x  * W, y: VERTICES.violin.y  * H };
  const C = { x: VERTICES.flute.x   * W, y: VERTICES.flute.y   * H };

  // ── Triangle fill: three corner colour gradients blended inside the shape ──
  const gradients = [
    { pt: A, rgb: '200,146,58'  },   // brass
    { pt: B, rgb: '110,158,189' },   // string
    { pt: C, rgb: '125,171,122' },   // wind
  ];

  // Clip everything to triangle shape
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(A.x, A.y);
  ctx.lineTo(B.x, B.y);
  ctx.lineTo(C.x, C.y);
  ctx.closePath();
  ctx.clip();

  // Dark base inside triangle
  ctx.fillStyle = '#1c1a17';
  ctx.fillRect(0, 0, W, H);

  // Radial gradient from each corner
  const diag = Math.sqrt(W * W + H * H);
  gradients.forEach(({ pt, rgb }) => {
    const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, diag * 0.75);
    g.addColorStop(0,   `rgba(${rgb},0.7)`);
    g.addColorStop(0.5, `rgba(${rgb},0.2)`);
    g.addColorStop(1,   `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });

  ctx.restore();

  // ── Triangle border ──
  ctx.beginPath();
  ctx.moveTo(A.x, A.y);
  ctx.lineTo(B.x, B.y);
  ctx.lineTo(C.x, C.y);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // ── Subtle grid lines (barycentric) ──
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth   = 1;
  const steps = 4;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    // Lines parallel to each edge
    ctx.beginPath();
    ctx.moveTo(A.x + t * (B.x - A.x), A.y + t * (B.y - A.y));
    ctx.lineTo(A.x + t * (C.x - A.x), A.y + t * (C.y - A.y));
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(B.x + t * (A.x - B.x), B.y + t * (A.y - B.y));
    ctx.lineTo(B.x + t * (C.x - B.x), B.y + t * (C.y - B.y));
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(C.x + t * (A.x - C.x), C.y + t * (A.y - C.y));
    ctx.lineTo(C.x + t * (B.x - C.x), C.y + t * (B.y - C.y));
    ctx.stroke();
  }

  // ── Cursor dot ──
  const cx = padX * W;
  const cy = padY * H;

  // Crosshair lines
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 6]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
  ctx.setLineDash([]);

  // Dot — colour blends between the three instrument colours
  const { wT, wV, wF } = weights;
  const dr = Math.round(200 * wT + 110 * wV + 125 * wF);
  const dg = Math.round(146 * wT + 158 * wV + 171 * wF);
  const db = Math.round(58  * wT + 189 * wV + 122 * wF);

  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fillStyle   = `rgb(${dr},${dg},${db})`;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}


// ─────────────────────────────────────────────────────────────────────────────
// 9. PAD INTERACTION
// ─────────────────────────────────────────────────────────────────────────────

function handlePadInput(e) {
  const canvas = document.getElementById('pad');
  const rect   = canvas.getBoundingClientRect();
  const src    = e.touches ? e.touches[0] : e;

  // Raw pointer position in normalised canvas space
  const rawX = Math.max(0, Math.min(1, (src.clientX - rect.left)  / rect.width));
  const rawY = Math.max(0, Math.min(1, (src.clientY - rect.top)   / rect.height));

  // Clamp to triangle boundary — cursor can never leave the triangle
  const clamped = clampToTriangle(rawX, rawY);
  padX = clamped.x;
  padY = clamped.y;

  weights = barycentricWeights(padX, padY);
  drawPad();
  applyMix();
}

function initPad() {
  const canvas  = document.getElementById('pad');
  let dragging  = false;

  canvas.addEventListener('mousedown',  e => { dragging = true;  handlePadInput(e); });
  window.addEventListener('mousemove',  e => { if (dragging) handlePadInput(e); });
  window.addEventListener('mouseup',    () => { dragging = false; });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); dragging = true;  handlePadInput(e); }, { passive: false });
  window.addEventListener('touchmove',  e => { if (dragging) { e.preventDefault(); handlePadInput(e); } }, { passive: false });
  window.addEventListener('touchend',   () => { dragging = false; });

  // Start cursor at centroid — equal blend of all three instruments
  padX = (VERTICES.trumpet.x + VERTICES.violin.x + VERTICES.flute.x) / 3;
  padY = (VERTICES.trumpet.y + VERTICES.violin.y + VERTICES.flute.y) / 3;
  weights = { wT: 1/3, wV: 1/3, wF: 1/3 };
  drawPad();
}


// ─────────────────────────────────────────────────────────────────────────────
// 10. SPECTRUM VISUALISER
// ─────────────────────────────────────────────────────────────────────────────

function initSpectrum() {
  const container = document.getElementById('spec-bars');
  for (let i = 0; i < N_HARMONICS; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'spec-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'spec-bar';
    bar.id        = 'spec-' + i;
    const num = document.createElement('div');
    num.className   = 'spec-bar-num';
    num.textContent = 'H' + (i + 1);
    wrap.appendChild(bar);
    wrap.appendChild(num);
    container.appendChild(wrap);
  }
}

function updateSpectrum(blended) {
  const maxAmp = Math.max(...blended, 0.001);
  const { wT, wV, wF } = weights;

  blended.forEach((amp, i) => {
    const bar    = document.getElementById('spec-' + i);
    bar.style.height = Math.max(2, (amp / maxAmp) * 56) + 'px';

    // Colour blends between all three instrument colours
    const r = Math.round(200 * wT + 110 * wV + 125 * wF);
    const g = Math.round(146 * wT + 158 * wV + 171 * wF);
    const db = Math.round(58  * wT + 189 * wV + 122 * wF);
    bar.style.background = `rgb(${r},${g},${db})`;
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// 11. STATUS + UI WIRING
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(on) {
  document.getElementById('status-pip').className    = 'status-pip' + (on ? ' live' : '');
  document.getElementById('status-text').textContent = on ? 'Live' : 'Stopped';
}

window.addEventListener('DOMContentLoaded', () => {

  // Note buttons
  const grid = document.getElementById('note-grid');
  NOTES.forEach(n => {
    const btn = document.createElement('button');
    btn.className   = 'note-btn' + (n === currentNote ? ' active' : '');
    btn.textContent = n;
    btn.addEventListener('click', () => {
      currentNote = n;
      grid.querySelectorAll('.note-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      retuneOscs();
    });
    grid.appendChild(btn);
  });

  // Octave
  document.getElementById('octave').addEventListener('input', e => {
    currentOct = parseInt(e.target.value, 10);
    document.getElementById('oct-val').textContent = currentOct;
    retuneOscs();
  });

  // Reverb
  document.getElementById('reverb').addEventListener('input', e => {
    reverbMix = parseFloat(e.target.value);
    document.getElementById('rev-val').textContent = reverbMix.toFixed(1);
    if (isPlaying && dryGain && wetGain) {
      dryGain.gain.setTargetAtTime(1 - reverbMix, audioCtx.currentTime, 0.05);
      wetGain.gain.setTargetAtTime(reverbMix,      audioCtx.currentTime, 0.05);
    }
  });

  // Play / Stop
  document.getElementById('btn-play').addEventListener('click', startAudio);
  document.getElementById('btn-stop').addEventListener('click', stopAudio);

  initPad();
  initSpectrum();
  applyMix();
  setStatus(false);
});