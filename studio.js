/* Deblot Studio v1 — client-side only, no server, no accounts.
   Camera + screen compositing, free backgrounds, free watermark, free clip export. */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');

const state = {
  camStream: null,
  screenStream: null,
  camVideo: null,
  screenVideo: null,
  layout: 'solo',
  bgEnabled: false,
  bgChoice: null,
  watermarkOn: true,
  wmText: 'Deblot',
  wmPos: 'br',
  segmenter: null,
  recorder: null,
  recordedChunks: [],
  recording: false,
  recordStartTime: null,
  timerInterval: null,
  fullBlob: null,
  fullVideoEl: null,
  clipMarkIn: null,
  clips: [],
  peer: null,
  connections: [],   // {id, video, stream}
  isGuest: false,
  youtube: { clientId: null, tokenClient: null, accessToken: null, channelName: null }
};

/* ---------- Backgrounds (free library, no paywall) ---------- */
const BACKGROUNDS = [
  { name: 'None', css: null },
  { name: 'Midnight', css: 'linear-gradient(135deg,#1b1f2b,#0a0c12)' },
  { name: 'Sunset', css: 'linear-gradient(135deg,#ff9966,#ff5e62)' },
  { name: 'Ocean', css: 'linear-gradient(135deg,#2193b0,#6dd5ed)' },
  { name: 'Forest', css: 'linear-gradient(135deg,#134e5e,#71b280)' },
  { name: 'Grape', css: 'linear-gradient(135deg,#41295a,#2f0743)' },
  { name: 'Studio Grey', css: 'linear-gradient(135deg,#3a3a3a,#1a1a1a)' },
  { name: 'Solid Green', css: '#0b7a1c' }
];

function buildBackgroundGrid(){
  const grid = document.getElementById('bgGrid');
  BACKGROUNDS.forEach((bg, i) => {
    const div = document.createElement('div');
    div.className = 'bg-swatch' + (i === 0 ? ' selected' : '');
    div.style.background = bg.css || '#000';
    div.title = bg.name;
    div.addEventListener('click', () => {
      document.querySelectorAll('.bg-swatch').forEach(s => s.classList.remove('selected'));
      div.classList.add('selected');
      state.bgChoice = bg.css;
    });
    grid.appendChild(div);
  });
}
buildBackgroundGrid();

/* ---------- Sources ---------- */
async function toggleCamera(){
  const btn = document.getElementById('camBtn');
  if (state.camStream){
    state.camStream.getTracks().forEach(t => t.stop());
    state.camStream = null;
    state.camVideo = null;
    btn.classList.remove('active');
    return;
  }
  try {
    state.camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const v = document.createElement('video');
    v.srcObject = state.camStream;
    v.muted = true;
    await v.play();
    state.camVideo = v;
    btn.classList.add('active');
  } catch (e) {
    alert('Camera access failed: ' + e.message);
  }
}

async function toggleScreen(){
  const btn = document.getElementById('screenBtn');
  if (state.screenStream){
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
    state.screenVideo = null;
    btn.classList.remove('active');
    return;
  }
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const v = document.createElement('video');
    v.srcObject = state.screenStream;
    v.muted = true;
    await v.play();
    state.screenVideo = v;
    btn.classList.add('active');
    state.screenStream.getVideoTracks()[0].addEventListener('ended', toggleScreen);
  } catch (e) {
    // user cancelled picker — no-op
  }
}

document.getElementById('camBtn').addEventListener('click', toggleCamera);
document.getElementById('screenBtn').addEventListener('click', toggleScreen);

/* ---------- Multi-guest (free, unlimited, via PeerJS public broker — no server of our own) ---------- */
function ensurePeer(){
  if (state.peer) return state.peer;
  state.peer = new Peer(); // random id from PeerJS cloud
  return state.peer;
}

async function ensureCameraForCall(){
  if (!state.camStream) await toggleCamera();
  return state.camStream;
}

function attachGuestVideo(id, remoteStream){
  const v = document.createElement('video');
  v.srcObject = remoteStream;
  v.muted = false;
  v.play();
  const entry = { id, video: v, stream: remoteStream };
  state.connections.push(entry);
  renderGuestList();
  return entry;
}

function removeGuest(id){
  state.connections = state.connections.filter(c => c.id !== id);
  renderGuestList();
}

function renderGuestList(){
  const el = document.getElementById('guestList');
  if (!el) return;
  el.textContent = state.connections.length
    ? `${state.connections.length} guest(s) connected`
    : 'No guests connected yet';
}

document.getElementById('inviteBtn').addEventListener('click', async () => {
  await ensureCameraForCall();
  const peer = ensurePeer();
  const box = document.getElementById('inviteBox');
  const linkInput = document.getElementById('inviteLink');

  function showLink(){
    const url = new URL(window.location.href);
    url.searchParams.set('join', peer.id);
    linkInput.value = url.toString();
    box.style.display = 'block';
  }

  if (peer.id){ showLink(); }
  else { peer.on('open', showLink); }

  peer.on('call', call => {
    call.answer(state.camStream);
    call.on('stream', remoteStream => attachGuestVideo(call.peer, remoteStream));
    call.on('close', () => removeGuest(call.peer));
  });
});

async function initGuestModeIfNeeded(){
  const params = new URLSearchParams(window.location.search);
  const hostId = params.get('join');
  if (!hostId) return;
  state.isGuest = true;
  document.getElementById('guestSection').innerHTML =
    '<h3>Guest Mode</h3><div class="hint">Connecting to host…</div>';
  await ensureCameraForCall();
  const peer = ensurePeer();
  peer.on('open', () => {
    const call = peer.call(hostId, state.camStream);
    call.on('stream', () => {
      document.getElementById('guestSection').innerHTML =
        '<h3>Guest Mode</h3><div class="hint">Connected — you are live in the host\'s scene.</div>';
    });
    call.on('close', () => {
      document.getElementById('guestSection').innerHTML =
        '<h3>Guest Mode</h3><div class="hint">Disconnected from host.</div>';
    });
  });
}
initGuestModeIfNeeded();

/* ---------- YouTube authentication (client-side OAuth via Google Identity Services) ----------
   Actual RTMP push to YouTube Live still needs a relay server (browsers can't emit RTMP),
   but auth + creating the broadcast/stream key is pure client-side. */
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';
const ytStatusEl = document.getElementById('ytStatus');
const ytConnectBtn = document.getElementById('ytConnectBtn');
const ytClientIdBox = document.getElementById('ytClientIdBox');
const ytClientIdInput = document.getElementById('ytClientId');

function loadSavedClientId(){
  const saved = localStorage.getItem('deblot_yt_client_id');
  if (saved) state.youtube.clientId = saved;
  return saved;
}

function initTokenClient(){
  if (!window.google || !google.accounts || !google.accounts.oauth2) return null;
  state.youtube.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.youtube.clientId,
    scope: YT_SCOPE,
    callback: async (resp) => {
      if (resp.error){
        ytStatusEl.textContent = 'Connection failed: ' + resp.error;
        return;
      }
      state.youtube.accessToken = resp.access_token;
      await confirmYouTubeConnection();
    }
  });
  return state.youtube.tokenClient;
}

async function confirmYouTubeConnection(){
  ytStatusEl.textContent = 'Verifying…';
  try {
    const r = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: 'Bearer ' + state.youtube.accessToken } }
    );
    const data = await r.json();
    if (data.items && data.items.length){
      state.youtube.channelName = data.items[0].snippet.title;
      ytStatusEl.textContent = `Connected as ${state.youtube.channelName}`;
      ytConnectBtn.textContent = 'Reconnect YouTube';
      ytConnectBtn.classList.add('active');
    } else {
      ytStatusEl.textContent = 'Connected, but no YouTube channel found on this account.';
    }
  } catch (e) {
    ytStatusEl.textContent = 'Verification failed: ' + e.message;
  }
}

ytConnectBtn.addEventListener('click', () => {
  const saved = loadSavedClientId();
  if (!saved){
    ytClientIdBox.style.display = 'block';
    return;
  }
  const client = state.youtube.tokenClient || initTokenClient();
  if (client) client.requestAccessToken();
  else ytStatusEl.textContent = 'Google sign-in library still loading — try again in a moment.';
});

document.getElementById('ytSaveClientId').addEventListener('click', () => {
  const id = ytClientIdInput.value.trim();
  if (!id){ alert('Paste your OAuth Client ID first.'); return; }
  localStorage.setItem('deblot_yt_client_id', id);
  state.youtube.clientId = id;
  ytClientIdBox.style.display = 'none';
  const client = initTokenClient();
  if (client) client.requestAccessToken();
});

loadSavedClientId();

/* ---------- Layout ---------- */
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.layout = btn.dataset.layout;
  });
});

/* ---------- Watermark ---------- */
document.getElementById('wmText').addEventListener('input', e => state.wmText = e.target.value);
document.getElementById('wmPos').addEventListener('change', e => state.wmPos = e.target.value);
document.getElementById('wmToggle').addEventListener('click', e => {
  state.watermarkOn = !state.watermarkOn;
  e.target.classList.toggle('active', state.watermarkOn);
  e.target.textContent = state.watermarkOn ? 'Watermark On' : 'Watermark Off';
});

/* ---------- Background replace (free, MediaPipe Selfie Segmentation) ---------- */
document.getElementById('bgToggle').addEventListener('click', async e => {
  state.bgEnabled = !state.bgEnabled;
  e.target.classList.toggle('active', state.bgEnabled);
  e.target.textContent = state.bgEnabled ? 'Disable Replace' : 'Enable Replace';
  if (state.bgEnabled && !state.segmenter && window.SelfieSegmentation){
    state.segmenter = new SelfieSegmentation({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`
    });
    state.segmenter.setOptions({ modelSelection: 1 });
    state.segmenter.onResults(onSegmentResults);
  }
});

let lastSegMask = null;
function onSegmentResults(results){ lastSegMask = results.segmentationMask; }

/* ---------- Compositor (runs every frame) ---------- */
function drawSourceWithMask(video, x, y, w, h){
  if (state.bgEnabled && lastSegMask && video === state.camVideo){
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    // draw background fill first
    ctx.fillStyle = state.bgChoice && state.bgChoice.startsWith('#') ? state.bgChoice : '#000';
    if (state.bgChoice && state.bgChoice.startsWith('linear-gradient')){
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, '#333'); g.addColorStop(1, '#111');
      ctx.fillStyle = g;
    }
    ctx.fillRect(x, y, w, h);
    // composite person using mask as alpha
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(lastSegMask, x, y, w, h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(video, x, y, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  } else {
    ctx.drawImage(video, x, y, w, h);
  }
}

function drawWatermark(){
  if (!state.watermarkOn) return;
  ctx.save();
  ctx.font = 'bold 22px -apple-system, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 4;
  const text = state.wmText || 'Deblot';
  const metrics = ctx.measureText(text);
  const pad = 18;
  let x, y;
  if (state.wmPos === 'br'){ x = canvas.width - metrics.width - pad; y = canvas.height - pad; }
  else if (state.wmPos === 'bl'){ x = pad; y = canvas.height - pad; }
  else if (state.wmPos === 'tr'){ x = canvas.width - metrics.width - pad; y = pad + 22; }
  else { x = pad; y = pad + 22; }
  ctx.fillText(text, x, y);
  ctx.restore();
}

async function renderLoop(){
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.bgEnabled && state.segmenter && state.camVideo && state.camVideo.readyState >= 2){
    await state.segmenter.send({ image: state.camVideo });
  }

  const cam = state.camVideo, scr = state.screenVideo;

  if (state.layout === 'solo'){
    if (scr) drawSourceWithMask(scr, 0, 0, canvas.width, canvas.height);
    else if (cam) drawSourceWithMask(cam, 0, 0, canvas.width, canvas.height);
  } else if (state.layout === 'pip'){
    if (scr) drawSourceWithMask(scr, 0, 0, canvas.width, canvas.height);
    else if (cam) drawSourceWithMask(cam, 0, 0, canvas.width, canvas.height);
    if (cam && scr){
      const w = canvas.width * 0.26, h = w * 0.75;
      const x = canvas.width - w - 24, y = canvas.height - h - 24;
      ctx.save();
      ctx.strokeStyle = '#5b8cff'; ctx.lineWidth = 3;
      drawSourceWithMask(cam, x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  } else if (state.layout === 'side'){
    const halfW = canvas.width / 2;
    if (scr) drawSourceWithMask(scr, 0, 0, halfW, canvas.height);
    if (cam) drawSourceWithMask(cam, halfW, 0, halfW, canvas.height);
  } else if (state.layout === 'grid'){
    const tiles = [];
    if (cam) tiles.push(cam);
    state.connections.forEach(c => { if (c.video.readyState >= 2) tiles.push(c.video); });
    if (scr) tiles.unshift(scr); // screen share gets first, larger slot if present

    if (tiles.length){
      const cols = Math.ceil(Math.sqrt(tiles.length));
      const rows = Math.ceil(tiles.length / cols);
      const tw = canvas.width / cols, th = canvas.height / rows;
      tiles.forEach((t, i) => {
        const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
        drawSourceWithMask(t, x, y, tw, th);
        ctx.strokeStyle = '#262a35';
        ctx.strokeRect(x, y, tw, th);
      });
    }
  }

  if (!cam && !scr && !state.connections.length){
    ctx.fillStyle = '#666';
    ctx.font = '20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Enable Camera or Screen Share to begin', canvas.width/2, canvas.height/2);
    ctx.textAlign = 'left';
  }

  drawWatermark();
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

/* ---------- Recording ---------- */
const recBtn = document.getElementById('recBtn');
const markBtn = document.getElementById('markBtn');
const timerEl = document.getElementById('timer');

function mixedAudioStream(){
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const sources = [state.camStream, state.screenStream, ...state.connections.map(c => c.stream)];
  sources.forEach(s => {
    if (s && s.getAudioTracks().length){
      ac.createMediaStreamSource(s).connect(dest);
    }
  });
  return dest.stream;
}

recBtn.addEventListener('click', () => {
  if (!state.recording) startRecording(); else stopRecording();
});

function startRecording(){
  if (!state.camVideo && !state.screenVideo){
    alert('Enable a camera or screen share first.');
    return;
  }
  const canvasStream = canvas.captureStream(30);
  const audio = mixedAudioStream();
  audio.getAudioTracks().forEach(t => canvasStream.addTrack(t));

  state.recordedChunks = [];
  state.recorder = new MediaRecorder(canvasStream, { mimeType: 'video/webm;codecs=vp9,opus' });
  state.recorder.ondataavailable = e => { if (e.data.size) state.recordedChunks.push(e.data); };
  state.recorder.onstop = onRecordingStop;
  state.recorder.start();

  state.recording = true;
  state.recordStartTime = Date.now();
  recBtn.textContent = '■ Stop Recording';
  recBtn.classList.add('danger', 'active');
  markBtn.disabled = false;
  statusEl.textContent = 'Recording';
  statusEl.classList.add('live');

  state.timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - state.recordStartTime) / 1000);
    const mm = String(Math.floor(s/60)).padStart(2,'0');
    const ss = String(s%60).padStart(2,'0');
    timerEl.textContent = `${mm}:${ss}`;
  }, 250);
}

function stopRecording(){
  state.recorder.stop();
  state.recording = false;
  recBtn.textContent = '● Start Recording';
  recBtn.classList.remove('danger', 'active');
  markBtn.disabled = true;
  markBtn.textContent = 'Mark Clip Start';
  state.clipMarkIn = null;
  statusEl.textContent = 'Idle';
  statusEl.classList.remove('live');
  clearInterval(state.timerInterval);
}

function onRecordingStop(){
  state.fullBlob = new Blob(state.recordedChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(state.fullBlob);

  // offer the full recording as a download
  addClipEntry('Full Recording', url, state.fullBlob);

  // prep hidden video element for potential clip trimming
  state.fullVideoEl = document.createElement('video');
  state.fullVideoEl.src = url;
  state.fullVideoEl.muted = false;

  setupTrimUI(url);
}

/* ---------- Post-recording trim (free, unlimited exports) ---------- */
function setupTrimUI(url){
  const section = document.getElementById('trimSection');
  const preview = document.getElementById('trimPreview');
  const inSlider = document.getElementById('trimIn');
  const outSlider = document.getElementById('trimOut');
  const inLabel = document.getElementById('trimInLabel');
  const outLabel = document.getElementById('trimOutLabel');

  preview.src = url;
  section.style.display = 'block';

  preview.addEventListener('loadedmetadata', () => {
    const dur = preview.duration;
    inSlider.max = dur; outSlider.max = dur;
    inSlider.value = 0; outSlider.value = dur;
    inLabel.textContent = '0.0s';
    outLabel.textContent = dur.toFixed(1) + 's';
  }, { once: true });

  inSlider.addEventListener('input', () => {
    inLabel.textContent = parseFloat(inSlider.value).toFixed(1) + 's';
    if (parseFloat(inSlider.value) >= parseFloat(outSlider.value)){
      inSlider.value = outSlider.value - 0.1;
    }
    preview.currentTime = parseFloat(inSlider.value);
  });
  outSlider.addEventListener('input', () => {
    outLabel.textContent = parseFloat(outSlider.value).toFixed(1) + 's';
    if (parseFloat(outSlider.value) <= parseFloat(inSlider.value)){
      outSlider.value = parseFloat(inSlider.value) + 0.1;
    }
    preview.currentTime = parseFloat(outSlider.value);
  });

  document.getElementById('trimExportBtn').onclick = () => {
    exportSingleClip({ in: parseFloat(inSlider.value), out: parseFloat(outSlider.value) });
  };
}

/* ---------- Clip marking (free, unlimited, no watermark lock beyond your own toggle) ---------- */
markBtn.addEventListener('click', () => {
  const elapsed = (Date.now() - state.recordStartTime) / 1000;
  if (state.clipMarkIn === null){
    state.clipMarkIn = elapsed;
    markBtn.textContent = 'Mark Clip End (' + elapsed.toFixed(1) + 's in)';
  } else {
    const inT = state.clipMarkIn, outT = elapsed;
    state.clips.push({ in: inT, out: outT });
    markBtn.textContent = 'Mark Clip Start';
    state.clipMarkIn = null;
    statusEl.textContent = `Recording (clip marked ${inT.toFixed(1)}s–${outT.toFixed(1)}s, exports after stop)`;
  }
});

function addClipEntry(label, url, blob){
  const list = document.getElementById('clipsList');
  const item = document.createElement('div');
  item.className = 'clip-item';
  const a = document.createElement('a');
  a.href = url;
  a.download = label.replace(/\s+/g,'_') + '.webm';
  a.textContent = '⬇ ' + label;
  item.appendChild(a);
  const size = document.createElement('span');
  size.textContent = (blob.size / (1024*1024)).toFixed(1) + ' MB';
  item.appendChild(size);
  list.prepend(item);
}

/* After a recording stops, export any marked clips by re-playing the
   segment through a canvas + MediaRecorder pair — fully client-side,
   no ffmpeg, no server, no paywall. */
async function exportMarkedClips(){
  if (!state.clips.length || !state.fullVideoEl) return;
  for (const clip of state.clips.splice(0)){
    await exportSingleClip(clip);
  }
}

function exportSingleClip(clip){
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.src = state.fullVideoEl.src;
    v.muted = false;
    const cw = 1280, ch = 720;
    const c2 = document.createElement('canvas');
    c2.width = cw; c2.height = ch;
    const c2x = c2.getContext('2d');

    v.addEventListener('loadedmetadata', () => {
      v.currentTime = clip.in;
    });

    v.addEventListener('seeked', () => {
      const stream = c2.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        addClipEntry(`Clip ${clip.in.toFixed(1)}s–${clip.out.toFixed(1)}s`, url, blob);
        resolve();
      };
      rec.start();
      v.play();

      function paint(){
        if (v.currentTime >= clip.out || v.ended){
          rec.stop();
          v.pause();
          return;
        }
        c2x.drawImage(v, 0, 0, cw, ch);
        requestAnimationFrame(paint);
      }
      requestAnimationFrame(paint);
    }, { once: true });
  });
}

// hook clip export into the stop flow
const _origStop = stopRecording;
stopRecording = function(){
  _origStop();
  setTimeout(() => { if (state.clips.length) exportMarkedClips(); }, 500);
};
