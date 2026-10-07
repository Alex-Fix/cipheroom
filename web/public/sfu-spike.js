// THROWAWAY: Cloudflare Realtime SFU connectivity spike (docs/plans/2026-10-07-cloudflare-sfu-design.md, step 1).
// One RTCPeerConnection = one Cloudflare session: push mic + camera (simulcast f/h/q), pull everyone else in the room,
// switch layers, ICE-restart, and show the selected ICE path and byte counters. Talks to /api/spike/sfu/* only.
'use strict';

const $ = (id) => document.getElementById(id);
const RIDS = ['f', 'h', 'q'];

let pc = null;
let sessionId = null;
let room = '';
let local = null;
let timers = [];
const pulled = new Map(); // trackName -> { mid, sessionId (publisher), name, kind }
const tiles = new Map(); // publisher sessionId -> { el, stream, video, stats }

// Cloudflare requires mutations on one session to be ordered: every SFU call goes through this queue.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

function log(text, isError = false) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  if (isError) line.className = 'err';
  $('log').prepend(line);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(`/api/spike/sfu${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.errorCode ?? ''} ${json?.errorDescription ?? ''}`);
  return json;
}

function showEnvironment() {
  const sender = window.RTCRtpSender?.prototype ?? {};
  $('env').textContent = [
    `RTCRtpScriptTransform: ${'RTCRtpScriptTransform' in window}`,
    `createEncodedStreams: ${'createEncodedStreams' in sender}`,
    `VP8: ${!!RTCRtpSender.getCapabilities?.('video')?.codecs.some((c) => /vp8/i.test(c.mimeType))}`,
    navigator.userAgent,
  ].join(' · ');
}

function preferVp8(transceiver) {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const vp8 = codecs.filter((c) => /vp8/i.test(c.mimeType));
  transceiver.setCodecPreferences([...vp8, ...codecs.filter((c) => !/vp8/i.test(c.mimeType))]);
}

function tileFor(key, title, isLocal = false) {
  let tile = tiles.get(key);
  if (tile) return tile;
  const el = document.createElement('div');
  el.className = 'tile';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  const stream = new MediaStream();
  video.srcObject = stream;
  const stats = document.createElement('div');
  stats.className = 'stats';
  el.append(heading, video, stats);
  $('tiles').append(el);
  tile = { el, stream, video, stats, layers: null };
  tiles.set(key, tile);
  return tile;
}

function addLayerButtons(tile, info) {
  if (tile.layers) return;
  tile.layers = document.createElement('div');
  tile.layers.className = 'row';
  for (const rid of RIDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = rid;
    button.onclick = () => selectLayer(info, rid).catch((e) => log(e.message, true));
    tile.layers.append(button);
  }
  tile.el.append(tile.layers);
}

async function join(event) {
  event.preventDefault();
  room = $('room').value.trim();
  const name = $('name').value.trim() || 'anon';
  $('join').querySelector('[type=submit]').disabled = true;
  showEnvironment();

  try {
    const config = await api('/config');
    pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: $('relay').checked ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    });
    pc.ontrack = onTrack;
    pc.oniceconnectionstatechange = () => log(`ice: ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => log(`connection: ${pc.connectionState}`);

    local = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const self = tileFor('self', `${name} (you)`, true);
    local.getTracks().forEach((t) => self.stream.addTrack(t));

    const audio = pc.addTransceiver(local.getAudioTracks()[0], { direction: 'sendonly' });
    const video = pc.addTransceiver(local.getVideoTracks()[0], {
      direction: 'sendonly',
      sendEncodings: $('simulcast').checked
        ? [
            { rid: 'f', maxBitrate: 1_200_000 },
            { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 400_000 },
            { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
          ]
        : [{ maxBitrate: 1_200_000 }],
    });
    preferVp8(video);

    sessionId = (await api('/sessions', 'POST')).sessionId;
    log(`session ${sessionId}`);
    const prefix = sessionId.slice(0, 8);
    const trackNames = [`${prefix}-mic`, `${prefix}-cam`];

    await serial(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      const res = await api(`/sessions/${sessionId}/tracks`, 'POST', {
        sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
        tracks: [
          { location: 'local', mid: audio.mid, trackName: trackNames[0] },
          { location: 'local', mid: video.mid, trackName: trackNames[1] },
        ],
      });
      res.tracks?.filter((t) => t.errorCode).forEach((t) => log(`push ${t.mid}: ${t.errorCode}`, true));
      await pc.setRemoteDescription(res.sessionDescription);
    });
    await api(`/rooms/${room}/publishers`, 'POST', { sessionId, name, trackNames });
    log('published mic + cam');

    $('leave').disabled = false;
    addRestartButton();
    timers.push(setInterval(() => poll().catch((e) => log(e.message, true)), 2000));
    timers.push(setInterval(() => showStats().catch(() => {}), 2000));
    await poll();
  } catch (e) {
    log(e.message ?? String(e), true);
    $('join').querySelector('[type=submit]').disabled = false;
  }
}

async function poll() {
  const publishers = await api(`/rooms/${room}/publishers`);
  const others = publishers.filter((p) => p.sessionId !== sessionId);

  // Gone publishers: drop their tiles (Cloudflare garbage-collects inactive tracks after 30 s).
  for (const [key, tile] of tiles) {
    if (key !== 'self' && !others.some((p) => p.sessionId === key)) {
      tile.el.remove();
      tiles.delete(key);
      for (const [trackName, info] of pulled) if (info.sessionId === key) pulled.delete(trackName);
      log(`publisher ${key.slice(0, 8)} left`);
    }
  }

  const wanted = others.flatMap((p) =>
    p.trackNames.filter((t) => !pulled.has(t)).map((trackName) => ({ ...p, trackName })),
  );
  if (wanted.length) await serial(() => pull(wanted));
}

async function pull(wanted) {
  const res = await api(`/sessions/${sessionId}/tracks`, 'POST', {
    tracks: wanted.map((w) => ({
      location: 'remote',
      sessionId: w.sessionId,
      trackName: w.trackName,
      ...(w.trackName.endsWith('-cam') && $('simulcast').checked
        ? { simulcast: { preferredRid: 'h', priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } }
        : {}),
    })),
  });
  for (const t of res.tracks ?? []) {
    if (t.errorCode) {
      log(`pull ${t.trackName}: ${t.errorCode} ${t.errorDescription ?? ''}`, true);
      continue;
    }
    const source = wanted.find((w) => w.trackName === t.trackName);
    pulled.set(t.trackName, { mid: t.mid, sessionId: source.sessionId, name: source.name, trackName: t.trackName });
  }
  if (res.requiresImmediateRenegotiation) {
    await pc.setRemoteDescription(res.sessionDescription);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await api(`/sessions/${sessionId}/renegotiate`, 'PUT', { sessionDescription: { type: 'answer', sdp: answer.sdp } });
  }
  log(`pulled ${wanted.map((w) => w.trackName).join(', ')}`);
}

function onTrack(event) {
  const info = [...pulled.values()].find((p) => p.mid === event.transceiver.mid);
  if (!info) return log(`track for unknown mid ${event.transceiver.mid}`, true);
  const tile = tileFor(info.sessionId, info.name);
  tile.stream.addTrack(event.track);
  tile.video.play().catch(() => log('autoplay blocked — tap the video', true));
  if (event.track.kind === 'video' && $('simulcast').checked) addLayerButtons(tile, info);
}

function selectLayer(info, rid) {
  return serial(async () => {
    const res = await api(`/sessions/${sessionId}/tracks/update`, 'PUT', {
      tracks: [
        {
          location: 'remote',
          sessionId: info.sessionId,
          trackName: info.trackName,
          mid: info.mid,
          simulcast: { preferredRid: rid, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' },
        },
      ],
    });
    res.tracks?.filter((t) => t.errorCode).forEach((t) => log(`layer ${rid}: ${t.errorCode}`, true));
    log(`${info.name}: preferred layer ${rid}`);
  });
}

function addRestartButton() {
  if ($('restart')) return;
  const button = document.createElement('button');
  button.id = 'restart';
  button.type = 'button';
  button.textContent = 'ICE restart';
  button.onclick = () =>
    serial(async () => {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      const res = await api(`/sessions/${sessionId}/renegotiate`, 'PUT', {
        sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
      });
      await pc.setRemoteDescription(res.sessionDescription);
      log('ICE restart done');
    }).catch((e) => log(`ICE restart: ${e.message}`, true));
  $('join').append(button);
}

async function showStats() {
  if (!pc) return;
  const report = await pc.getStats();
  const byId = new Map([...report.values()].map((s) => [s.id, s]));
  let sent = 0;
  let received = 0;
  const outbound = [];
  const inbound = new Map();

  for (const s of report.values()) {
    if (s.type === 'transport') {
      const pair = byId.get(s.selectedCandidatePairId);
      const l = byId.get(pair?.localCandidateId);
      const r = byId.get(pair?.remoteCandidateId);
      if (pair) {
        $('path').textContent =
          `path: ${l?.candidateType}${l?.relayProtocol ? `/TURN-${l.relayProtocol}` : ''} (${l?.protocol}) ⇄ ` +
          `${r?.candidateType} ${r?.address ?? ''}:${r?.port ?? ''} · rtt ${pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : '?'} ms`;
      }
      sent += s.bytesSent ?? 0;
      received += s.bytesReceived ?? 0;
    }
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      outbound.push(`${s.rid ?? '-'} ${s.frameWidth ?? 0}x${s.frameHeight ?? 0}@${Math.round(s.framesPerSecond ?? 0)} ${s.qualityLimitationReason ?? ''}`);
    }
    if (s.type === 'inbound-rtp') inbound.set(s.mid, s);
  }

  const self = tiles.get('self');
  if (self) self.stats.textContent = `sending: ${outbound.join(' | ')}\nbytes ↑ ${mb(sent)} ↓ ${mb(received)}`;

  for (const info of pulled.values()) {
    const s = inbound.get(info.mid);
    const tile = tiles.get(info.sessionId);
    if (!s || !tile) continue;
    if (s.kind === 'video') {
      tile.stats.textContent = `video ${s.frameWidth ?? 0}x${s.frameHeight ?? 0}@${Math.round(s.framesPerSecond ?? 0)} · ${mb(s.bytesReceived)}`;
    }
  }
}

const mb = (bytes) => `${((bytes ?? 0) / 1_000_000).toFixed(1)} MB`;

async function leave() {
  timers.forEach(clearInterval);
  timers = [];
  if (sessionId) await api(`/rooms/${room}/publishers/${sessionId}/leave`, 'POST').catch(() => {});
  local?.getTracks().forEach((t) => t.stop());
  pc?.close();
  pc = null;
  sessionId = null;
  pulled.clear();
  tiles.forEach((t) => t.el.remove());
  tiles.clear();
  $('restart')?.remove();
  $('leave').disabled = true;
  $('join').querySelector('[type=submit]').disabled = false;
  log('left');
}

$('join').addEventListener('submit', join);
$('leave').addEventListener('click', () => void leave());
window.addEventListener('pagehide', () => {
  if (sessionId) navigator.sendBeacon?.(`/api/spike/sfu/rooms/${room}/publishers/${sessionId}/leave`);
});
showEnvironment();
