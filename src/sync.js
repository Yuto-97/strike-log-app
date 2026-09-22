// Keeps an account holder's records in the cloud so they follow the person
// to a new phone.
//
// The app itself still reads and writes localStorage exactly as before
// (fast, and works with no signal at a bowling alley). This module:
//   1. on login, downloads the account's cloud copy and merges it with what
//      is on this phone (startSync)
//   2. afterwards, mirrors every local change up to the cloud, queueing
//      changes on the phone and retrying automatically if the upload fails
//
// Only used for account holders — device-only users are unaffected.

export const GAMES_KEY = "games";
export const SYNCED_KV_KEYS = ["my-balls", "my-shoes", "profile", "player-name", "ball-config", "shoe-config"];
export const SYNCED_KEYS = [GAMES_KEY, ...SYNCED_KV_KEYS];
const OWNER_KEY = "sync-owner-uid"; // which account this phone's records belong to
const PENDING_KEY = "sync-pending"; // changes not yet confirmed by the server
const UPLOAD_CHUNK = 200;
const RETRY_MS = 30000;

let ctx = { tracking: false, enabled: false, deviceId: null, getToken: null, onInactive: null };
let flushing = false;
let flushAgain = false;
let retryTimer = null;

const uniq = (a) => Array.from(new Set(a));

function parseGames(raw) {
  try {
    const a = JSON.parse(raw || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function sortGames(list) {
  return list.sort(
    (a, b) => String(a.date || "").localeCompare(String(b.date || "")) || (a.gameNumber || 1) - (b.gameNumber || 1)
  );
}

function readPending() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    if (p) return { upserts: p.upserts || [], deletes: p.deletes || [], kv: p.kv || [] };
  } catch (e) {
    // corrupted queue — start fresh; startSync's merge covers anything missed
  }
  return { upserts: [], deletes: [], kv: [] };
}

function writePending(p) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(p));
}

// Called by the app's storage wrapper on every write to a synced key, with
// the value before and after. Records exactly which games changed.
export function noteLocalWrite(key, prevRaw, nextRaw) {
  if (!ctx.tracking || !SYNCED_KEYS.includes(key)) return;
  const p = readPending();
  if (key === GAMES_KEY) {
    const prev = new Map(parseGames(prevRaw).map((g) => [g.id, JSON.stringify(g)]));
    const next = new Map(parseGames(nextRaw).map((g) => [g.id, JSON.stringify(g)]));
    for (const [id, json] of next) {
      if (prev.get(id) !== json) {
        p.upserts.push(id);
        p.deletes = p.deletes.filter((d) => d !== id);
      }
    }
    for (const id of prev.keys()) {
      if (!next.has(id)) {
        p.deletes.push(id);
        p.upserts = p.upserts.filter((u) => u !== id);
      }
    }
  } else {
    p.kv.push(key);
  }
  p.upserts = uniq(p.upserts);
  p.deletes = uniq(p.deletes);
  p.kv = uniq(p.kv);
  writePending(p);
  scheduleFlush();
}

async function api(method, body) {
  const token = await ctx.getToken();
  const res = await fetch("/api/data", {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Device-Id": ctx.deviceId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 409) {
    // Another phone logged into this account — this one must stop.
    const cb = ctx.onInactive;
    stopSync();
    if (cb) cb();
    const err = new Error("inactive");
    err.inactive = true;
    throw err;
  }
  if (!res.ok) throw new Error(`sync failed: ${res.status}`);
  return res.json();
}

export function scheduleFlush() {
  if (!ctx.enabled) return;
  if (flushing) {
    flushAgain = true;
    return;
  }
  flush();
}

async function flush() {
  flushing = true;
  try {
    do {
      flushAgain = false;
      const p = readPending();
      if (!p.upserts.length && !p.deletes.length && !p.kv.length) break;

      const local = new Map(parseGames(localStorage.getItem(GAMES_KEY)).map((g) => [g.id, g]));
      const upserts = p.upserts.map((id) => local.get(id)).filter(Boolean);
      const kv = {};
      for (const k of p.kv) kv[k] = localStorage.getItem(k);

      // Chunk big uploads (e.g. the first upload of years of games).
      const chunks = [];
      for (let i = 0; i < upserts.length; i += UPLOAD_CHUNK) chunks.push(upserts.slice(i, i + UPLOAD_CHUNK));
      if (!chunks.length) chunks.push([]);
      for (let i = 0; i < chunks.length; i++) {
        await api("POST", {
          upserts: chunks[i],
          deletes: i === 0 ? p.deletes : [],
          kv: i === 0 ? kv : {},
        });
      }

      // Clear only what the server now has. Anything changed again while
      // uploading stays queued for the next round.
      const sent = new Map(upserts.map((g) => [g.id, JSON.stringify(g)]));
      const nowLocal = new Map(parseGames(localStorage.getItem(GAMES_KEY)).map((g) => [g.id, JSON.stringify(g)]));
      const now = readPending();
      now.upserts = now.upserts.filter((id) => {
        if (!p.upserts.includes(id)) return true;
        if (!nowLocal.has(id)) return false; // deleted meanwhile — the delete is queued
        return nowLocal.get(id) !== sent.get(id);
      });
      now.deletes = now.deletes.filter((id) => !(p.deletes.includes(id) && !nowLocal.has(id)));
      now.kv = now.kv.filter((k) => !(p.kv.includes(k) && localStorage.getItem(k) === kv[k]));
      writePending(now);
    } while (flushAgain && ctx.enabled);
  } catch (e) {
    if (!e.inactive) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(scheduleFlush, RETRY_MS);
    }
  } finally {
    flushing = false;
  }
}

// Runs once per login on this phone. Downloads the account's cloud copy
// and merges it with local records:
//   - this phone already belonged to this account → the cloud is the truth
//     (it has what was added/deleted on other phones), plus any local
//     changes that never made it up
//   - this phone's records were never linked to an account (e.g. an existing
//     user creating an account) → keep everything from both, and upload
//   - this phone belonged to a DIFFERENT account → don't mix their records
//     in; use this account's cloud copy only
export async function startSync({ uid, deviceId, getToken, onInactive }) {
  ctx = { tracking: true, enabled: false, deviceId, getToken, onInactive };
  clearTimeout(retryTimer);

  const server = await api("GET");
  const serverGames = Array.isArray(server.games) ? server.games : [];
  const serverKv = server.kv || {};
  const owner = localStorage.getItem(OWNER_KEY);
  const localGames = parseGames(localStorage.getItem(GAMES_KEY));
  let pending = readPending();
  let merged;
  const kvOut = {};

  if (owner === uid) {
    const map = new Map(serverGames.map((g) => [g.id, g]));
    const localMap = new Map(localGames.map((g) => [g.id, g]));
    for (const id of pending.upserts) if (localMap.has(id)) map.set(id, localMap.get(id));
    for (const id of pending.deletes) map.delete(id);
    merged = [...map.values()];
    for (const k of SYNCED_KV_KEYS) {
      const localVal = localStorage.getItem(k);
      if (pending.kv.includes(k)) kvOut[k] = localVal;
      else if (serverKv[k] !== undefined) kvOut[k] = serverKv[k];
      else kvOut[k] = localVal;
    }
  } else if (!owner) {
    const map = new Map(serverGames.map((g) => [g.id, g]));
    const serverJson = new Map(serverGames.map((g) => [g.id, JSON.stringify(g)]));
    const toUpload = [];
    for (const g of localGames) {
      if (!map.has(g.id)) map.set(g.id, g);
      if (serverJson.get(g.id) !== JSON.stringify(map.get(g.id))) toUpload.push(g.id);
    }
    merged = [...map.values()];
    pending = { upserts: uniq([...pending.upserts, ...toUpload]), deletes: [], kv: [...pending.kv] };
    for (const k of SYNCED_KV_KEYS) {
      const localVal = localStorage.getItem(k);
      if (serverKv[k] !== undefined) {
        kvOut[k] = serverKv[k];
      } else {
        kvOut[k] = localVal;
        if (localVal !== null) pending.kv.push(k);
      }
    }
    pending.kv = uniq(pending.kv);
  } else {
    merged = serverGames.slice();
    pending = { upserts: [], deletes: [], kv: [] };
    for (const k of SYNCED_KV_KEYS) kvOut[k] = serverKv[k] !== undefined ? serverKv[k] : null;
  }

  // Write straight to localStorage (not through the app's storage wrapper),
  // so this download isn't itself mistaken for a local change.
  localStorage.setItem(GAMES_KEY, JSON.stringify(sortGames(merged)));
  for (const [k, v] of Object.entries(kvOut)) {
    if (v === null || v === undefined) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  }
  localStorage.setItem(OWNER_KEY, uid);
  writePending(pending);

  ctx.enabled = true;
  scheduleFlush();
}

export function stopSync() {
  ctx.tracking = false;
  ctx.enabled = false;
  clearTimeout(retryTimer);
}
