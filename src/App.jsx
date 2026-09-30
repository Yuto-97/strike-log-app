import React, { useState, useEffect, useRef, useCallback } from "react";
import { Camera, History, BarChart3, Loader2, Check, X, Pencil, Trophy, TrendingUp, Calendar, CircleDot, Hash, User, Target, Trash2, ShieldCheck, CircleCheck, MessageCircle, Send, Settings, Crop, ImageOff, UserX, Bell, ImagePlus, ChevronDown, Download } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { auth } from "./firebaseClient.js";
import { noteLocalWrite, startSync, stopSync, scheduleFlush } from "./sync.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "firebase/auth";

// ---------- palette ----------
// ink:      #201811  (deep walnut, headers/text)
// oak:      #A9713F  (lane wood, structural accents)
// cream:    #F6EFE2  (pin ivory, background)
// strike:   #D5482B  (pin-stripe red, primary accent / strikes)
// gold:     #D9A441  (foul-line gold, secondary accent / spares)

const COLORS = {
  ink: "#152238",
  oak: "#B89968",
  cream: "#F5F1E4",
  strike: "#FFFFFF",
  gold: "#E0A800",
  navyBg: "#232C4D",
  navyLight: "#374873",
  danger: "#C0392B",
};

// Main action buttons (記録を保存, 保存, 追加する): navy inside with gold text
// and a gold outline, so they stand out on the dark background. When the
// button can't be pressed yet, it turns dim so that's obvious too.
function primaryButtonStyle(enabled = true) {
  return enabled
    ? { background: COLORS.ink, color: COLORS.gold, fontWeight: 700, border: `1.5px solid ${COLORS.gold}` }
    : {
        background: "rgba(40, 55, 95, 0.55)",
        color: "rgba(245, 241, 228, 0.45)",
        fontWeight: 700,
        border: "1px solid rgba(184, 153, 104, 0.5)",
      };
}

// Style for "pick one" buttons (ハウス/マイボール, レンタル/マイシューズ, 期間, etc.).
// The chosen one has gold text and a gold outline (navy inside) — the same
// signal as the active tab in the bottom bar — so it's obvious at a glance which is selected. The ring is drawn with
// box-shadow rather than a thicker border, so nothing shifts when switching.
function toggleStyle(active) {
  return active
    ? {
        background: COLORS.ink,
        color: COLORS.gold,
        border: `1px solid ${COLORS.gold}`,
        boxShadow: `inset 0 0 0 1px ${COLORS.gold}`,
        fontWeight: 700,
      }
    : {
        background: "rgba(40, 55, 95, 0.55)",
        color: "rgba(245, 241, 228, 0.7)",
        border: `1px solid rgba(184, 153, 104, 0.6)`,
        fontWeight: 700,
      };
}

const STORAGE_KEY = "games";

// Drop-in replacement for the Claude-artifact-only `window.storage` API,
// backed by the browser's localStorage instead. Keeps the same shape
// ({ key, value } | null) so the rest of the app didn't need to change.
// localStorage stays the app's working copy (fast, works offline). For
// account holders, every write is also reported to the sync module, which
// mirrors it to the cloud so records follow the person to a new phone.
const storage = {
  async get(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return { key, value: raw };
  },
  async set(key, value) {
    const prev = localStorage.getItem(key);
    localStorage.setItem(key, value);
    noteLocalWrite(key, prev, value);
    return { key, value };
  },
  async delete(key) {
    const prev = localStorage.getItem(key);
    localStorage.removeItem(key);
    noteLocalWrite(key, prev, null);
    return { key, deleted: true };
  },
};


function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// The registrant ID is now generated server-side as a random 7-character
// string (digits 1-9 only, no 0) — this just handles the "not assigned yet" case.
function formatRequestNumber(n) {
  return n ? String(n) : "-------";
}

// ---------- date helpers for period selection ----------
// Formats using local date components (not toISOString, which shifts to UTC
// and can land on the wrong day depending on the person's timezone).
function toLocalISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISODate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Monday-start, Sunday-end week containing the given date.
function getWeekRange(dateStr) {
  const d = parseISODate(dateStr);
  const day = d.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: toLocalISODate(monday), end: toLocalISODate(sunday) };
}

// 1st to last day of the given "yyyy-mm" month string.
function getMonthRange(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  return { start: toLocalISODate(first), end: toLocalISODate(last) };
}

function shiftDate(dateStr, days) {
  const d = parseISODate(dateStr);
  d.setDate(d.getDate() + days);
  return toLocalISODate(d);
}

function shiftMonth(monthStr, months) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + months, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

// Label lookups for the structured "own ball" characteristic fields.
const CORE_LABELS = { symmetric: "シンメトリック", asymmetric: "アシンメトリック" };
const COVERSTOCK_LABELS = { reactive: "リアクティブレジン", urethane: "ウレタン", plastic: "プラスチック", particle: "パーティクル" };
const MOTION_LABELS = { straight: "ストレート", mild_curve: "マイルドカーブ", hook: "フック", backup: "バックアップ" };
const LANE_LABELS = { dry: "ドライレーン向き", medium: "ミディアムレーン向き", oily: "オイリーレーン向き" };
function formatMD(dateStr) {
  const d = parseISODate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function formatMDWeekday(dateStr) {
  const d = parseISODate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_JA[d.getDay()]})`;
}

function sharpen(ctx, w, h) {
  // Simple 3x3 unsharp-mask style convolution. Helps recover edge definition
  // in phone photos that are slightly out of focus or shot at an angle,
  // which is common when someone quickly snaps a TV screen mid-game.
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  const sd = src.data;
  const dd = dst.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        dd[i] = sd[i];
        dd[i + 1] = sd[i + 1];
        dd[i + 2] = sd[i + 2];
        dd[i + 3] = sd[i + 3];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * w + (x + kx)) * 4 + c;
            sum += sd[idx] * kernel[k];
            k++;
          }
        }
        dd[i + c] = Math.max(0, Math.min(255, sum));
      }
      dd[i + 3] = sd[i + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });
}

const HEIC_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];

// Loads the original, full-resolution photo once. We keep this around so a
// user-selected crop can be cut from the camera's full pixels rather than
// from an already-shrunk copy — that's where the extra legibility comes from.
function loadImageFromFile(file) {
  return new Promise(async (resolve, reject) => {
    const looksHeic = HEIC_TYPES.includes((file.type || "").toLowerCase()) || /\.heic$|\.heif$/i.test(file.name || "");
    if (looksHeic) {
      reject(
        new Error(
          "HEIC形式の画像はこのアプリで読み込めません。iPhoneの「設定 > カメラ > フォーマット」を「互換性優先」に変更するか、写真アプリで共有時に「JPEGとして保存」を選んでから、もう一度お試しください。"
        )
      );
      return;
    }
    let dataUrl;
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch (e) {
      reject(e);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      reject(new Error("画像を読み込めませんでした。対応形式(JPEG/PNG)の写真かご確認のうえ、もう一度お試しください。"));
    };
    img.src = dataUrl;
  });
}

// Renders a region of the original photo (or the whole thing when `region`
// is null) into the JPEG we send to the AI.
// region: { x, y, w, h } in source-image pixels.
function renderImageForAI(img, region) {
  const sx = region ? region.x : 0;
  const sy = region ? region.y : 0;
  const sw = region ? region.w : img.width;
  const sh = region ? region.h : img.height;
  // Target ~1568px on the long side: Claude's vision encoder works best
  // around this size (larger images get shrunk to it anyway), so we scale
  // up small crops and scale down oversized photos.
  const targetLong = 1568;
  const scale = targetLong / Math.max(sw, sh);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Mild contrast/brightness boost helps distinguish LED-style digits
  // and faint pencil marks on paper scoresheets from the background.
  ctx.filter = "contrast(130%) brightness(110%)";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  ctx.filter = "none";
  // Only worth sharpening when we've upscaled a small region.
  if (scale > 1.1 && w * h < 4_000_000) {
    try {
      sharpen(ctx, w, h);
    } catch (sharpenErr) {
      // Sharpening is a bonus step; fall back to the plain image if it fails.
    }
  }
  let outUrl;
  try {
    outUrl = canvas.toDataURL("image/jpeg", 1.0);
  } catch (e) {
    throw new Error("画像の処理中にエラーが発生しました。別の写真でお試しください。");
  }
  return { base64: outUrl.split(",")[1], mediaType: "image/jpeg" };
}

// Builds the image(s) sent to the AI for one analysis.
// cropRect: user's selection in 0..1 coordinates of the photo, or null.
// With a crop we send (1) the selected area and, for a wide row-shaped
// selection, (2) a zoomed copy of its right side — frames 6-10 and the
// total, where the tiny 10th-frame marks live. Both are small images, so
// together they cost less to analyze than one full photo.
function buildAnalysisImages(img, cropRect) {
  if (!cropRect) return { images: [renderImageForAI(img, null)], cropped: false, zoomed: false };
  const padX = img.width * 0.015;
  const padY = img.height * 0.015;
  const x0 = Math.max(0, cropRect.x * img.width - padX);
  const y0 = Math.max(0, cropRect.y * img.height - padY);
  const x1 = Math.min(img.width, (cropRect.x + cropRect.w) * img.width + padX);
  const y1 = Math.min(img.height, (cropRect.y + cropRect.h) * img.height + padY);
  const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const images = [renderImageForAI(img, region)];
  const zoomed = region.w / region.h >= 2.5;
  if (zoomed) {
    const zw = region.w * 0.45;
    images.push(renderImageForAI(img, { x: region.x + region.w - zw, y: region.y, w: zw, h: region.h }));
  }
  return { images, cropped: true, zoomed };
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("うまく読み取れませんでした。もう一度お試しください。");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error(
      "解析結果を読み取れませんでした。写真に写っているゲーム数が多いと起きやすいので、ゲーム数を分けて撮影するか、もう一度お試しください。"
    );
  }
}

// ---------- official scoring rules ----------
// Converts any raw roll value (from AI extraction or manual edit — could be
// "X", "/", "-", "G" (gutter), "F" (foul), or a plain number string) into a
// pin count, using the previous roll in the same spare pair as context when
// needed. Gutter and foul both credit 0 pins, same as a plain miss.
function toPinCount(raw, prevPins) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (raw === "X" || raw === "x") return 10;
  if (raw === "-" || raw === "G" || raw === "g" || raw === "F" || raw === "f") return 0;
  if (raw === "/") return prevPins == null ? null : 10 - prevPins;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, n));
}

function displayPin(pins) {
  if (pins === null || pins === undefined) return "";
  return pins === 0 ? "-" : String(pins);
}

// A plain 0-pin roll could be a miss ("-"), a gutter ball ("G"), or a foul
// ("F") — all score 0 pins the same way, but the label on the sheet (and
// what gets counted for stats) should reflect which one it actually was.
function rollLabel(raw, pins) {
  if (raw === "G" || raw === "g") return "G";
  if (raw === "F" || raw === "f") return "F";
  return displayPin(pins);
}

// Normalizes one frame's raw rolls into official scoresheet notation
// (X / strike, / spare, - miss, G gutter, F foul) and the underlying pin
// counts used for scoring. Handles the 10th frame's bonus-roll rules.
function normalizeFrame(rawRolls, isTenth) {
  const r = rawRolls || [];
  if (!isTenth) {
    const p1 = toPinCount(r[0]);
    if (p1 === null) return { display: [r[0] ?? "", r[1] ?? ""], pins: [null, null] };
    if (p1 === 10) return { display: ["X", ""], pins: [10, null] };
    const p2 = toPinCount(r[1], p1);
    if (p2 === null) return { display: [rollLabel(r[0], p1), r[1] ?? ""], pins: [p1, null] };
    if (p1 + p2 === 10) return { display: [rollLabel(r[0], p1), "/"], pins: [p1, p2] };
    return { display: [rollLabel(r[0], p1), rollLabel(r[1], p2)], pins: [p1, p2] };
  }
  const p1 = toPinCount(r[0]);
  if (p1 === null) return { display: [r[0] ?? "", r[1] ?? "", r[2] ?? ""], pins: [null, null, null] };
  if (p1 === 10) {
    const p2 = toPinCount(r[1]);
    if (p2 === null) return { display: ["X", r[1] ?? "", r[2] ?? ""], pins: [10, null, null] };
    const d2 = p2 === 10 ? "X" : rollLabel(r[1], p2);
    if (p2 === 10) {
      const p3 = toPinCount(r[2]);
      const d3 = p3 === null ? r[2] ?? "" : p3 === 10 ? "X" : rollLabel(r[2], p3);
      return { display: ["X", d2, d3], pins: [10, 10, p3] };
    }
    const p3 = toPinCount(r[2], p2);
    if (p3 === null) return { display: ["X", d2, r[2] ?? ""], pins: [10, p2, null] };
    const d3 = p2 + p3 === 10 ? "/" : rollLabel(r[2], p3);
    return { display: ["X", d2, d3], pins: [10, p2, p2 + p3 === 10 ? 10 - p2 : p3] };
  }
  const d1 = rollLabel(r[0], p1);
  const p2 = toPinCount(r[1], p1);
  if (p2 === null) return { display: [d1, r[1] ?? "", r[2] ?? ""], pins: [p1, null, null] };
  if (p1 + p2 === 10) {
    const p3 = toPinCount(r[2]);
    const d3 = p3 === null ? r[2] ?? "" : p3 === 10 ? "X" : rollLabel(r[2], p3);
    return { display: [d1, "/", d3], pins: [p1, 10 - p1, p3] };
  }
  return { display: [d1, rollLabel(r[1], p2)], pins: [p1, p2] };
}

// Standard "flattened rolls with lookahead" bowling scoring algorithm.
// pinFrames: 10 arrays of pin counts (numbers or null if unknown/unplayed).
function computeGameScores(pinFrames) {
  const flat = [];
  const startIdx = [];
  pinFrames.forEach((f) => {
    startIdx.push(flat.length);
    f.forEach((p) => {
      if (p !== null && p !== undefined) flat.push(p);
    });
  });
  const scores = [];
  let cumulative = 0;
  let broken = false;
  for (let i = 0; i < 10; i++) {
    if (broken) {
      scores.push(null);
      continue;
    }
    const start = startIdx[i];
    if (i < 9) {
      const r1 = flat[start];
      if (r1 === undefined) {
        broken = true;
        scores.push(null);
        continue;
      }
      if (r1 === 10) {
        const b1 = flat[start + 1];
        const b2 = flat[start + 2];
        if (b1 === undefined || b2 === undefined) {
          broken = true;
          scores.push(null);
          continue;
        }
        cumulative += 10 + b1 + b2;
      } else {
        const r2 = flat[start + 1];
        if (r2 === undefined) {
          broken = true;
          scores.push(null);
          continue;
        }
        if (r1 + r2 === 10) {
          const b1 = flat[start + 2];
          if (b1 === undefined) {
            broken = true;
            scores.push(null);
            continue;
          }
          cumulative += 10 + b1;
        } else {
          cumulative += r1 + r2;
        }
      }
    } else {
      const frameRolls = pinFrames[9];
      if (frameRolls.some((p) => p === null || p === undefined)) {
        scores.push(null);
        continue;
      }
      cumulative += frameRolls.reduce((a, b) => a + b, 0);
    }
    scores.push(cumulative);
  }
  return scores;
}

// Runs a full game through normalization + official scoring. Safe to call
// repeatedly (e.g. on every keystroke) since normalization is idempotent.
// Falls back to the AI's originally reported per-frame score whenever our
// own calculation can't complete a frame (e.g. bonus-roll data missing),
// so the sheet never shows a blank score through frame 10.
// Computes score + detail stats for any set of games (used for the overall
// period summary and for individual per-game breakdowns on "day" view).
// Spare chances in the 10th frame. Every time a full rack is thrown at and not
// struck, AND another ball follows in the frame, that's one chance at a spare
// — e.g. X, 9, / is 1 chance (after the strike re-racks); 9, /, X is 1;
// X, X, X is 0. Counting only "the first ball wasn't a strike" missed the
// X, 9, / case, while its spare was still counted — inflating spare rates.
function tenthFrameSpareChances(rolls) {
  let chances = 0;
  let fresh = true;
  for (let k = 0; k < rolls.length; k++) {
    const v = rolls[k];
    if (v === undefined || v === "") break;
    if (fresh) {
      if (v === "X") continue; // strike re-racks; next ball is fresh again
      const next = rolls[k + 1];
      if (next !== undefined && next !== "") chances += 1;
      fresh = false;
    } else {
      fresh = true; // only a spare gives another ball, and that one is fresh
    }
  }
  return chances;
}

function computeGameSetStats(gamesList) {
  const totals = gamesList.map((g) => g.total);
  const avg = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0;
  const highGame = totals.length ? Math.max(...totals) : 0;
  const lowGame = totals.length ? Math.min(...totals) : 0;

  let strikes = 0;
  let spareChances = 0;
  let spares = 0;
  let openFrames = 0;
  let frameCount = 0;
  let splitFrames = 0;
  let splitOpenCount = 0;
  let splitCovers = 0;
  let totalBalls = 0;
  let gutters = 0;
  let fouls = 0;
  gamesList.forEach((g) => {
    (g.frames || []).forEach((f, fi) => {
      const r0 = f.rolls?.[0];
      if (fi === 9) spareChances += tenthFrameSpareChances(f.rolls || []);
      if (r0 !== undefined && r0 !== "") {
        frameCount += 1;
        if (r0 === "X") {
          strikes += 1;
        } else {
          if (fi !== 9) spareChances += 1; // the 10th is counted above
          // Open frame (official rule): neither a strike nor a spare — some
          // pins were left standing after this frame's rolls.
          if (f.rolls?.[1] !== "/") openFrames += 1;
        }
      }
      // Count every "/" mark in the frame, not just index 1 — the 10th
      // frame can show a spare at index 2 when it opens with a strike and
      // the two bonus balls (open + spare) land on a spare (e.g. X, 7, /).
      (f.rolls || []).forEach((val) => {
        if (val === "/") spares += 1;
      });
      // A split can occur on any ball. Total count is per-ball across the
      // whole frame; "cover" specifically tracks the traditional case where
      // the split happened on the frame's opening ball and the second ball
      // turned it into a spare.
      const splitRolls = f.splitRolls || [];
      splitRolls.forEach((isSplit) => {
        if (isSplit) splitFrames += 1;
      });
      if (splitRolls[0]) {
        splitOpenCount += 1;
        if (f.rolls?.[1] === "/") splitCovers += 1;
      }
      (f.rolls || []).forEach((val) => {
        if (val === undefined || val === "") return;
        totalBalls += 1;
        if (val === "G") gutters += 1;
        if (val === "F") fouls += 1;
      });
    });
  });
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return {
    gameCount: gamesList.length,
    avg,
    highGame,
    lowGame,
    frameCount,
    spareChances,
    splitOpenCount,
    strikeCount: strikes, strikeRate: pct(strikes, frameCount),
    spareCount: spares, spareRate: pct(spares, spareChances),
    openFrameCount: openFrames, openFrameRate: pct(openFrames, frameCount),
    splitCount: splitFrames, splitRate: pct(splitFrames, frameCount),
    splitCoverCount: splitCovers, splitCoverRate: pct(splitCovers, splitOpenCount),
    gutterCount: gutters, gutterRate: pct(gutters, totalBalls),
    foulCount: fouls, foulRate: pct(fouls, totalBalls),
  };
}

// ---------- ball sets (per-ball stats) ----------
// Finds the registered ball a saved game refers to: by its stored id (games
// saved from now on), else by name (older games only stored the name).
function ballRegistryIdFor(b, myBalls) {
  if (!b) return null;
  if (b.registryId && myBalls.some((x) => x.id === b.registryId)) return b.registryId;
  if (!b.label) return null;
  const t = b.type || "own";
  return (myBalls.find((x) => x.label === b.label && (x.type || "own") === t) || myBalls.find((x) => x.label === b.label))?.id || null;
}

// Registered role of the ball a saved game refers to: "strike" (1stボール),
// "spare" (スペアボール), or null when not set.
function ballRoleOf(b, myBalls) {
  const id = ballRegistryIdFor(b, myBalls);
  const reg = id ? myBalls.find((x) => x.id === id) : null;
  return reg && (reg.role === "strike" || reg.role === "spare") ? reg.role : null;
}

// If a game lists its balls in reverse (spare ball first, strike ball second),
// swap them so the 1st ball is always the strike ball. Only acts when the
// registered roles make it clear; otherwise the recorded order is kept.
function normalizeBallOrder(g, myBalls) {
  if (!g || !g.ball || !g.ball2) return g;
  const r1 = ballRoleOf(g.ball, myBalls);
  const r2 = ballRoleOf(g.ball2, myBalls);
  const reversed = (r1 === "spare" && r2 !== "spare") || (r2 === "strike" && r1 !== "strike");
  return reversed ? { ...g, ball: g.ball2, ball2: g.ball } : g;
}

// One ball of a game, as { key, name, weight }. The key is what makes two
// games count as "the same ball": the registered ball when it can be found
// (so renaming a ball keeps its history together), otherwise its saved name.
function resolveBallRef(b, myBalls) {
  if (!b) return null;
  const type = b.type || "own";
  const regId = ballRegistryIdFor(b, myBalls);
  const reg = regId ? myBalls.find((x) => x.id === regId) : null;
  if (reg) return { key: `id:${reg.id}`, name: reg.label, weight: reg.weight ?? b.weight ?? null };
  if (b.registryId) return { key: `id:${b.registryId}`, name: b.label || "(削除したボール)", weight: b.weight ?? null };
  if (b.label) return { key: `label:${type}:${b.label}`, name: b.label, weight: b.weight ?? null };
  return { key: `none:${type}`, name: type === "house" ? "ハウスボール(未選択)" : "マイボール(未選択)", weight: null };
}

const BALL_STATS_MIN_GAMES = 3; // fewer games than this = shown as 参考値

// Ball analysis by role. People use at most two balls per game:
//   main  (1st ball) — thrown for strikes         → strike rate
//   spare (2nd ball) — thrown to pick up spares   → spare rate
//     (a game with no 2nd ball: the main ball took the spares too)
//   set  (main + spare together)                  → final score (average, high)
// A 3rd ball or later is left out of this analysis.
const NO_BALL = { key: "__none__", name: "ボールの記録なし", weight: null };

function groupBy(gamesList, keyOf) {
  const m = new Map();
  for (const g of gamesList) {
    const k = keyOf(g);
    if (!m.has(k.key)) m.set(k.key, { ...k, games: [] });
    m.get(k.key).games.push(g);
  }
  return [...m.values()].map((grp) => ({
    ...grp,
    stats: computeGameSetStats(grp.games),
    roles: roleCounters(grp.games),
    reliable: grp.games.length >= BALL_STATS_MIN_GAMES,
  }));
}

// Enough games first, then 参考値; within each, by the given measure (high → low).
const byReliableThen = (measure) => (a, b) =>
  a.reliable !== b.reliable ? (a.reliable ? -1 : 1) : measure(b) - measure(a) || b.games.length - a.games.length;

// Every roll of a game tagged as the 1st or 2nd ball of its rack of pins.
// Frames 1–9 are simple (1st roll, 2nd roll). In the 10th frame, a ball
// thrown after a strike or spare faces a fresh rack, so it counts as a 1st
// ball — e.g. X, 7, / is: 1st (strike), 1st (new rack), 2nd (spare).
function rollsByRole(game) {
  const out = [];
  (game.frames || []).forEach((f, i) => {
    const rolls = f.rolls || [];
    const splits = f.splitRolls || [];
    if (i < 9) {
      rolls.forEach((label, idx) => {
        if (label === undefined || label === "") return;
        out.push({ label, first: idx === 0, split: !!splits[idx] });
      });
      return;
    }
    const pins = normalizeFrame(rolls, true).pins;
    let nextIsFirst = true;
    rolls.forEach((label, idx) => {
      if (label === undefined || label === "") return;
      const first = nextIsFirst;
      out.push({ label, first, split: !!splits[idx] });
      // A 1st ball that isn't a strike leaves pins → next is its 2nd ball.
      // After a 2nd ball (or a strike) the pins are reset.
      nextIsFirst = first ? (pins[idx] ?? 0) === 10 : true;
    });
  });
  return out;
}

// Counts by role, over a list of games.
//   1st balls: splits left, gutters, fouls
//   2nd balls: split covers (split picked up for a spare), gutters, fouls
function roleCounters(gamesList) {
  const c = { firstBalls: 0, splits: 0, firstGutters: 0, firstFouls: 0, secondBalls: 0, splitChances: 0, splitCovers: 0, secondGutters: 0, secondFouls: 0 };
  for (const g of gamesList) {
    let pendingSplit = false;
    for (const r of rollsByRole(g)) {
      if (r.first) {
        c.firstBalls += 1;
        if (r.split) c.splits += 1;
        if (r.label === "G") c.firstGutters += 1;
        if (r.label === "F") c.firstFouls += 1;
        pendingSplit = r.split;
      } else {
        c.secondBalls += 1;
        if (pendingSplit) {
          c.splitChances += 1;
          if (r.label === "/") c.splitCovers += 1;
        }
        if (r.label === "G") c.secondGutters += 1;
        if (r.label === "F") c.secondFouls += 1;
        pendingSplit = false;
      }
    }
  }
  return c;
}

function computeBallRoleStats(gamesListRaw, myBalls) {
  const gamesList = gamesListRaw.map((g) => normalizeBallOrder(g, myBalls));
  const mainOf = (g) => resolveBallRef(g.ball, myBalls) || NO_BALL;
  const spareOf = (g) => resolveBallRef(g.ball2, myBalls) || mainOf(g);

  const mains = groupBy(gamesList, (g) => mainOf(g)).sort(byReliableThen((x) => x.stats.strikeRate));
  const spares = groupBy(gamesList, (g) => spareOf(g)).sort(byReliableThen((x) => x.stats.spareRate));
  const sets = groupBy(gamesList, (g) => {
    const m = mainOf(g);
    const s = g.ball2 ? resolveBallRef(g.ball2, myBalls) : null;
    return { key: `${m.key}>${s ? s.key : "same"}`, main: m, spare: s };
  }).sort(byReliableThen((x) => x.stats.avg));
  return { mains, spares, sets };
}

// ---------- achievements (celebration triggers) ----------
// Compares all-time stats before and after newly saved games, and returns
// the milestones that were just crossed. Only called when saving NEW games
// (not when editing old ones), so nothing re-fires on edits.
const MILESTONE_STEP = 100;

function detectAchievements(prevGames, nextGames, newGames, { goalAverage, goalScore }) {
  const out = [];
  if (!newGames.length) return out;
  const newTotals = newGames.map((g) => Number(g.total) || 0);
  const bestNew = Math.max(...newTotals);

  if (newTotals.includes(300)) {
    out.push({ kind: "perfect", title: "パーフェクトゲーム!", detail: "300点達成、おめでとうございます!" });
  }

  const prevBest = prevGames.length ? Math.max(...prevGames.map((g) => Number(g.total) || 0)) : null;
  if (prevBest !== null && bestNew > prevBest) {
    out.push({ kind: "best", title: "自己ベスト更新!", detail: `${bestNew}点(これまで${prevBest}点)` });
  }

  const goalS = Number(goalScore);
  if (goalS > 0) {
    const hits = newTotals.filter((t) => t >= goalS).length;
    if (hits > 0) {
      out.push({
        kind: "goalScore",
        title: "目標スコア達成!",
        detail: hits > 1 ? `${hits}ゲームで目標${goalS}点を突破` : `${bestNew}点 / 目標${goalS}点`,
      });
    }
  }

  const before = computeGameSetStats(prevGames);
  const after = computeGameSetStats(nextGames);

  const goalA = Number(goalAverage);
  if (goalA > 0 && prevGames.length > 0 && before.avg < goalA && after.avg >= goalA) {
    out.push({ kind: "goalAverage", title: "目標アベレージ達成!", detail: `通算アベレージ${after.avg} / 目標${goalA}` });
  }

  const crossed = (a, b) => Math.floor(b / MILESTONE_STEP) > Math.floor(a / MILESTONE_STEP);
  if (crossed(before.strikeCount, after.strikeCount)) {
    const n = Math.floor(after.strikeCount / MILESTONE_STEP) * MILESTONE_STEP;
    out.push({ kind: "strikes", title: `ストライク通算${n}本!`, detail: "積み重ねの成果です" });
  }
  if (crossed(before.spareCount, after.spareCount)) {
    const n = Math.floor(after.spareCount / MILESTONE_STEP) * MILESTONE_STEP;
    out.push({ kind: "spares", title: `スペア通算${n}本!`, detail: "確実に拾える力がついています" });
  }
  return out;
}

function normalizeGame(frames) {
  const arr = Array.from({ length: 10 }).map((_, i) => (frames && frames[i]) || { rolls: [] });
  const normalized = arr.map((f, i) => normalizeFrame(f.rolls, i === 9));
  const pinFrames = normalized.map((n) => n.pins);
  const computed = computeGameScores(pinFrames);
  const scores = computed.map((s, i) => (s !== null && s !== undefined ? s : arr[i].score ?? null));
  const newFrames = normalized.map((n, i) => ({
    rolls: n.display,
    score: scores[i],
    // Which roll(s) in this frame show a circled split mark. A split can
    // happen on any ball (including a 10th-frame bonus ball), not just the
    // frame's opening roll, so this is tracked per roll index.
    splitRolls: arr[i].splitRolls || [],
  }));
  const reversedScores = [...scores].reverse();
  const total = reversedScores.find((s) => s !== null && s !== undefined) ?? null;
  return { frames: newFrames, total };
}

// ---------- auto-correction from the board's cumulative numbers ----------
// The big cumulative numbers on a scoreboard are easy to read; the small
// per-roll marks (especially a "G" / "-" squeezed into the 10th frame) are
// where the AI slips. When the AI's rolls don't add up to the total shown on
// screen, but the per-frame cumulative numbers it transcribed DO line up with
// that total, we search for the rolls that reproduce those numbers exactly
// while changing as few of the AI's rolls as possible. Pure arithmetic in the
// browser — no extra AI call, no extra cost.
const RECONCILE_MAX_CHANGES = 4; // beyond this, too speculative — leave it to the user
const RECONCILE_NODE_LIMIT = 400000; // safety cap so a weird input can never freeze the UI

const NORMAL_FRAME_OPTIONS = (() => {
  const out = [[10]];
  for (let a = 0; a <= 9; a++) for (let b = 0; b <= 10 - a; b++) out.push([a, b]);
  return out;
})();

const TENTH_FRAME_OPTIONS = (() => {
  const out = [];
  for (let b = 0; b <= 10; b++) {
    if (b === 10) for (let c = 0; c <= 10; c++) out.push([10, 10, c]);
    else for (let c = 0; c <= 10 - b; c++) out.push([10, b, c]);
  }
  for (let a = 0; a <= 9; a++) {
    for (let c = 0; c <= 10; c++) out.push([a, 10 - a, c]);
    for (let b = 0; b < 10 - a; b++) out.push([a, b]);
  }
  return out;
})();

function countRollChanges(candidate, aiPins) {
  const len = Math.max(candidate.length, (aiPins || []).length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    const a = candidate[i];
    const b = aiPins ? aiPins[i] : undefined;
    if ((a ?? null) !== (b ?? null)) diff++;
  }
  return diff;
}

// Checks frames 0..upTo whose score can already be determined from the rolls
// chosen so far, against the cumulative numbers read off the screen.
function prefixMatchesReadScores(chosen, upTo, read) {
  const flat = [];
  const starts = [];
  for (let i = 0; i <= upTo; i++) {
    starts.push(flat.length);
    flat.push(...chosen[i]);
  }
  let cum = 0;
  for (let j = 0; j <= upTo; j++) {
    const s = starts[j];
    let val;
    if (j === 9) {
      val = chosen[9].reduce((a, b) => a + b, 0);
    } else {
      const r1 = flat[s];
      if (r1 === 10) {
        if (flat[s + 1] === undefined || flat[s + 2] === undefined) return true;
        val = 10 + flat[s + 1] + flat[s + 2];
      } else {
        const r2 = flat[s + 1];
        if (r1 + r2 === 10) {
          if (flat[s + 2] === undefined) return true;
          val = 10 + flat[s + 2];
        } else {
          val = r1 + r2;
        }
      }
    }
    cum += val;
    if (cum !== read[j]) return false;
  }
  return true;
}

// Turns corrected pin counts back into roll labels. Keeps the AI's own label
// for any roll it got right (so a correctly-read "G" or "F" stays a G/F);
// a newly-corrected 0 becomes "-" since we can't tell gutter from miss.
function pinsToRolls(pins, aiPins, aiRolls) {
  return pins.map((p, idx) => {
    if (aiPins && aiPins[idx] === p && aiRolls && aiRolls[idx] !== undefined && aiRolls[idx] !== "") return aiRolls[idx];
    if (p === 10) return "X";
    if (p === 0) return "-";
    return String(p);
  });
}

// Returns { frames, changedFrames } when exactly one fix fits the numbers,
// { frames: null, suspectFrames } when the numbers allow several answers,
// or null when the read numbers themselves can't be trusted.
function reconcileRollsWithReadScores(frames, target) {
  if (!Array.isArray(frames) || frames.length < 10 || !Number.isFinite(target)) return null;
  const read = frames.slice(0, 10).map((f) => Number(f?.score));
  if (read.some((s) => !Number.isFinite(s))) return null;
  if (read[9] !== target) return null; // the two independent reads of the total disagree — don't guess
  let prev = 0;
  for (const s of read) {
    if (s - prev < 0 || s - prev > 30) return null; // cumulative numbers themselves look misread
    prev = s;
  }

  const aiPins = frames.slice(0, 10).map((f, i) => normalizeFrame(f.rolls, i === 9).pins);
  const options = aiPins.map((ap, i) =>
    (i === 9 ? TENTH_FRAME_OPTIONS : NORMAL_FRAME_OPTIONS)
      .map((pins) => ({ pins, cost: countRollChanges(pins, ap) }))
      .sort((a, b) => a.cost - b.cost)
  );

  let best = null;
  let bestCost = RECONCILE_MAX_CHANGES + 1;
  let nodes = 0;
  const chosen = [];
  const dfs = (i, cost) => {
    if (++nodes > RECONCILE_NODE_LIMIT) return;
    if (i === 10) {
      best = chosen.slice();
      bestCost = cost;
      return;
    }
    for (const opt of options[i]) {
      if (cost + opt.cost >= bestCost) break; // options are sorted by cost
      chosen[i] = opt.pins;
      if (prefixMatchesReadScores(chosen, i, read)) dfs(i + 1, cost + opt.cost);
    }
    chosen.length = i;
  };
  dfs(0, 0);
  if (!best || bestCost === 0) return null;

  const changedFrames = [];
  for (let i = 0; i < 10; i++) if (countRollChanges(best[i], aiPins[i]) > 0) changedFrames.push(i);

  // Uniqueness check: the cumulative numbers only pin down how many points a
  // frame scored, not always how they split across rolls (e.g. a 10th frame
  // of X,9,/ and X,-,/ both add 20). Holding every frame the AI read
  // correctly fixed, if the changed frames could be filled in more than one
  // way, the numbers can't tell us which is right — so we don't guess; we
  // just point the user at those frames instead.
  const restricted = best.map((pins, i) => (changedFrames.includes(i) ? options[i] : [{ pins, cost: 0 }]));
  let solutions = 0;
  let nodes2 = 0;
  let exhausted = false;
  const trial = [];
  const countSolutions = (i) => {
    if (solutions > 1) return;
    if (++nodes2 > RECONCILE_NODE_LIMIT) {
      exhausted = true;
      return;
    }
    if (i === 10) {
      solutions++;
      return;
    }
    for (const opt of restricted[i]) {
      trial[i] = opt.pins;
      if (prefixMatchesReadScores(trial, i, read)) countSolutions(i + 1);
      if (solutions > 1 || exhausted) break;
    }
    trial.length = i;
  };
  countSolutions(0);
  if (solutions !== 1 || exhausted) return { frames: null, suspectFrames: changedFrames };

  const fixedFrames = frames.slice(0, 10).map((f, i) => {
    if (!changedFrames.includes(i)) return f;
    const splitRolls = (f.splitRolls || []).map((isSplit, idx) => (isSplit && best[i][idx] !== 10 ? isSplit : false));
    return { ...f, rolls: pinsToRolls(best[i], aiPins[i], f.rolls), splitRolls };
  });
  return { frames: fixedFrames, changedFrames };
}

// Checks every frame — not just the total — against the cumulative numbers
// the AI copied off the screen. A matching total can hide mistakes inside
// the game (e.g. a spare misread as a strike, offset by a misread 10th
// frame), and those would silently corrupt strike/spare stats.
// Returns null when everything agrees, or { frames: [...] } listing the
// frames (0-based) whose own score disagrees with the screen. An empty
// list means "something's off but we can't say where".
function findReadIssue(normFrames, readScores, ocrTotal, normTotal) {
  const pinFrames = normFrames.map((f, i) => normalizeFrame(f.rolls, i === 9).pins);
  const computed = computeGameScores(pinFrames);
  const hasTotal = Number.isFinite(ocrTotal);

  const read = Array.isArray(readScores) ? readScores.slice(0, 10).map(Number) : [];
  let readUsable = read.length === 10 && read.every(Number.isFinite) && (!hasTotal || read[9] === ocrTotal);
  if (readUsable) {
    let prev = 0;
    for (const s of read) {
      if (s - prev < 0 || s - prev > 30) readUsable = false;
      prev = s;
    }
  }

  if (!readUsable) {
    // Unfinished game or unreliable transcription: fall back to the old
    // total-only check so we never raise a warning we can't justify.
    return normTotal !== null && hasTotal && normTotal !== ocrTotal ? { frames: [] } : null;
  }

  // A misread *roll* shifts the running total for every frame after it.
  // A mis-copied *number* on the screen affects only that one number. So if
  // the running totals agree everywhere except at isolated single frames
  // (and the final total agrees), the rolls are right and it was just a
  // transcription slip — don't send the user hunting for a non-problem.
  const cumOff = [];
  for (let i = 0; i < 10; i++) if (computed[i] !== read[i]) cumOff.push(i);
  if (
    cumOff.length > 0 &&
    computed[9] === read[9] &&
    cumOff.every((i) => i < 9 && !cumOff.includes(i - 1) && !cumOff.includes(i + 1))
  ) {
    return null;
  }

  const bad = [];
  let prevC = 0;
  let prevR = 0;
  for (let i = 0; i < 10; i++) {
    const c = computed[i];
    const own = c === null || c === undefined ? null : c - prevC;
    if (own === null || own !== read[i] - prevR) bad.push(i);
    if (c !== null && c !== undefined) prevC = c;
    prevR = read[i];
  }
  return bad.length ? { frames: bad } : null;
}

// Tells the server who is making an AI call (so usage and cost can be
// recorded per person): the account's login token if signed in, plus this
// phone's device id.
async function usageHeaders() {
  const h = {};
  try {
    const id = localStorage.getItem("device-id");
    if (id) h["X-Device-Id"] = id;
  } catch (e) {
    // storage unavailable — record anonymously
  }
  try {
    if (auth?.currentUser) h.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
  } catch (e) {
    // token unavailable — fall back to the device id
  }
  return h;
}

// Reports how an analysis turned out (unrelated photo, needed checking,
// auto-corrected, corrected by hand). Never blocks or breaks the app.
function reportAnalysisOutcome(outcome) {
  if (!Object.values(outcome).some((n) => n > 0)) return;
  usageHeaders()
    .then((h) =>
      fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...h },
        body: JSON.stringify({ report: outcome }),
      })
    )
    .catch(() => {});
}

// ---------- friendly error messages ----------
// The server only ever sends a category (never raw API errors); these turn
// it into plain Japanese for the user. Photos taken from inside the app are
// not saved to the phone, so while analysis is paused we suggest shooting
// with the phone's own camera app, so the photo can be analyzed later.
const SAVE_PHOTO_TIP = "記録漏れを防ぐため、スコアはスマホのカメラアプリで撮って保存しておいてください。あとからその写真を選んで解析できます。";
// Every analysis-related error ends with the tip above, whatever the cause —
// otherwise a failure means that game's score is simply lost.
function withPhotoTip(msg) {
  const m = String(msg || "解析中にエラーが発生しました。").trim();
  return m.includes(SAVE_PHOTO_TIP) ? m : `${m}\n${SAVE_PHOTO_TIP}`;
}
function friendlyAiError(code, what) {
  if (code === "service_paused") return `ただいま${what}を一時停止しています。時間をおいて、もう一度お試しください。`;
  if (code === "busy") return `AIが混み合っています。少し時間をおいて、もう一度お試しください。`;
  if (code === "network") return `通信に失敗しました。電波の良い場所で、もう一度お試しください。`;
  return `${what}に失敗しました。時間をおいて、もう一度お試しください。`;
}

async function analyzeScoreImage(images, playerName, { cropped = false, zoomed = false } = {}) {
  const nameInstruction = cropped
    ? `この画像は、ユーザー本人が写真の中から自分のスコアの部分を指で囲んで切り抜いたものです。${
        playerName ? `複数の行が写っている場合は、名前「${playerName}」に最も一致する行を読み取ってください。` : ""
      }切り抜きの都合で名前やフレーム番号の見出しが写っていないことがありますが、その場合も player_matched は true とし、写っているスコアの行(複数行あれば最も上の行)を対象プレイヤーとして読み取ってください。`
    : playerName
    ? `この画像には複数人のスコアが表示されている可能性があります。名前「${playerName}」の行/列のスコアだけを読み取ってください。表記ゆれ(ひらがな・カタカナ・ローマ字・ニックネームなど)も考慮して、最も一致する列を選んでください。`
    : `この画像には1人分のスコアのみが表示されていると仮定して読み取ってください。`;

  const zoomInstruction = zoomed
    ? `

画像は2枚あります。1枚目は切り抜いたスコア全体、2枚目は1枚目の右側(後半のフレームと合計)を拡大したものです。後半のフレーム、特に10フレーム目の小さな記号(X・G・-・F・スペアの三角形)は、必ず2枚目の拡大画像で確認してください。1枚目と2枚目で読み取りが食い違う場合は、2枚目を優先してください。2枚目は同じスコアの拡大なので、別のゲームとして数えないこと。`
    : "";

  const prompt = `これはボウリングのスコア画面またはスコアシートの写真です。${nameInstruction}${zoomInstruction}

この写真には、対象プレイヤーの**1ゲーム分だけ**が写っている場合と、**複数ゲーム分(例: 1ゲーム目・2ゲーム目・3ゲーム目)がまとめて**写っている場合があります。まず、対象プレイヤーについて写っているゲームがいくつあるかを確認し、写っている**すべてのゲーム**を、それぞれ独立した10フレームのデータとして読み取ってください。

電光掲示板でよくある表示の特徴(該当する場合のみ考慮):
- 表の一番上に「1 2 3 4 5 6 7 8 9 10」のようなフレーム番号のヘッダー行がある場合、それを基準にして各列がどのフレームかを機械的に特定すること。ヘッダーがずれて見えても、フレーム数は必ず10個であることを前提に列を数え直して位置合わせする。フレームの取り違えは起きないよう、この基準を最優先で使う
- **複数のプレイヤーの行が縦に並んでいる場合、行の取り違えが最も起きやすい失敗パターンなので特に注意する。**対象プレイヤーの名前が書かれている行の左端(Y座標)を最初に特定し、フレーム1から10まで、**その同じY座標の高さを機械的に維持したまま**横方向にだけ視線を動かして読み取ること。読み取り中に別のプレイヤーの行の数字が視界に入っても、絶対にそちらの数字を使わない。名前の行とスコアの行が上下2段になっている場合は、名前の行のすぐ下にある数字の段だけを見る
- 複数ゲームが表示されている場合、「1G」「2G」「3G」やゲーム番号の見出しで区切られていることが多い。見出しを基準に、どこからどこまでが1ゲーム分かを正しく区切ること
- 投球結果の記号の意味(電光掲示板・紙のスコアシート共通)。記号を1つ読むたびに、必ずこの対応表と照らし合わせること:
  - ストライク:「X」のほか、蝶ネクタイ(リボン)型・三角形・矢印型のアイコンで表示されることがある → "X"
  - スペア:「/」のほか、直角三角形(◢のような形)のアイコンで表示されることがある → "/"
  - ガター(溝に落ちて0本):「G」 → "G"
  - ファール(0本):「F」 → "F"
  - ミス(1本も倒れなかった、0本):「-」(ハイフン) → "-"。ハイフンはスペアではなく0本の意味なので注意
  - スプリット:数字が丸で囲まれている(⑧など) → その数字として読み、split_roll_index に位置を記録
  - 上記以外の数字:倒したピンの本数 → "0"〜"9"
  - 「G」「F」「-」はどれも0本だが、"0" に置き換えず記号のまま出力すること(ガター・ファールの集計に使うため)
- 10フレーム目は、1つのセルに最大3投分の記号が小さく詰めて並ぶ(例:「X G 8」「9 / X」「X X X」)。3投目まで投げている場合は、必ず左から順に3つの記号をすべて読み取ること。小さな「G」「-」「F」を読み飛ばすと、後ろの投球が1つずつ前にずれて全体がずれるので特に注意する。10フレーム目でストライクかスペアを出していれば必ず3投、どちらも出していなければ2投である
- 各フレームのセルが上下2段になっていることが多い。上段は投球結果の記号、下段はそのフレーム終了時点の累計スコア(数字)。同じ累計の数字の行が、さらに下にもう1段繰り返し表示されていることもある(補助表示)
- 上段の記号アイコンが小さく判読しにくい場合は、下段の累計スコアの数字を最優先で正確に読み取ること。累計スコアの数字は判読しやすく、フレーム間の差分からストライク/スペア/オープンフレームをかなり正確に推定できる
- プレイヤー名の直後に区分ラベルらしき1文字の英字(例:「A」)が付いていることがある。これは名前そのものではない可能性があるため、名前照合の際は末尾の1文字英字を無視して比較する
- 「HDCP」はハンディキャップの略で、スコアそのものではない。「レーン合計」や複数ゲームの累計列も同様にゲームのスコアではない。読み取るべき合計スコアは、各ゲームの10フレーム分のスコア推移の直後にある「TOTAL」列の値のみで、HDCP・レーン合計・累計・順位などの列は無視する
- 写真が斜め・手ブレ・多少ぼやけている・画面の一部が反射で見えにくい場合でも、諦めずに文字の形状、周囲の数字との整合性、フレームの位置関係から可能な限り推測すること。多少画質が粗くても、数字の並び(1桁刻みで増える累計スコアなど)から妥当な値を推定できることが多い
- それでも判読が困難な箇所は、無理に確定せず、そのゲームの confidence_notes に具体的に記載する(例:「5フレーム目のマークが不鮮明」)

読み取りは、写っている**ゲームごとに**以下の手順で慎重に行ってください:
1. まず画面の種類(電光掲示板のデジタル表示か、紙のスコアシートか)と、対象プレイヤーの列/行の位置、そのゲームが何ゲーム目かを確認する。他のプレイヤーの行が近くにある場合は、対象プレイヤーの行の高さ(Y座標)をここでしっかり固定する
2. フレーム1から10まで、1フレームずつ順番に投球結果を読み取る。数字の間違えやすい組み合わせ(例: 6と8、1と7、Xと数字)は特に注意して見る。フレームが進むごとに、今読んでいる数字が手順1で固定した行の高さから外れていないか都度確認する。すぐ近くに紛らわしい別の行(繰り返し表示されている行、別プレイヤーの行、ポップアップの陰など)がある場合は、フレームごとに「これは本当に対象プレイヤーの行か」を都度確認し直す
3. 各フレームを読み終えたら、そのフレームの累計スコアが「前のフレームの累計 + このフレームで倒したピン数」と矛盾していないか自分で検算する。矛盾があれば、累計スコアの数字(大きく表示され読み間違いにくい)は画面表示が正しい前提として、投球記号の読み取り(特に小さな「G」「-」「F」の見落としや、10フレーム目の記号のずれ)を見直して修正する
4. 全フレームを読み終えたら、10フレーム目の累計スコア(または画面に「TOTAL」列がある場合はその数字)と、以下の複数の視点で突き合わせて検算する。1つの視点だけに頼ると、その視点が苦手なパターンの間違いを見逃すため、必ず全視点を行うこと:
   - **前から読む(手順1〜3で既に実施済み)**:フレーム1→10の順に投球マークと累計を読む
   - **後ろから遡る**:最も読み間違えにくい「最終合計」(10フレーム目の累計、または画面下部に別途表示されている合計があればそれも参考にする)を基準に、フレーム10→1の順に遡り、どこから数字が矛盾し始めるかを特定する
   - **増分だけで検算する**:投球マークを見ずに、「前フレームの累計との差」だけを各フレームについて計算する。差がマイナスになる、30点を超える(1フレームの得点はストライクのボーナス込みでも最大30点)など、明らかにおかしい差があるフレームを機械的に洗い出す
   - **マークと増分を突き合わせる**:読み取った投球マーク(ストライク/スペア/オープン等)から計算される得点と、増分検算で出した差が一致するか、フレームごとに照らし合わせる。一致しなければ、マークの読み間違いか数字の読み間違いのどちらかがあるということなので、そのフレームを再度見直す
   
   これらの視点で矛盾が見つかったフレームがあれば、frame_by_frame_readingを修正し、最終合計と一致するまで繰り返す。TOTAL表示や最終フレームの累計は画像上で最も読み取りやすい数字であることが多いため、最終的な正解の基準として扱う
5. 他にゲームが写っていれば、同じ手順を繰り返す
6. 最後に、読み取った内容を次のJSON形式のみで出力する。前置き・説明・マークダウンの記号は一切含めない

{
  "screen_type": "digital" または "paper"(ボウリングのスコアが写っていない画像なら "none"),
  "player_matched": true,
  "matched_name_on_screen": "画面上に表示されていた実際の表記",
  "other_players_detected": ["画面にいた他の人の名前など"],
  "games": [
    {
      "game_label": "1ゲーム目のように画面上のラベル、なければ null",
      "detected_date": "画面や紙に印字・記入されている日付があれば YYYY-MM-DD 形式に変換して。西暦2桁表記(例: 26/8/9)は20を補って西暦4桁にする。年が書かれておらず月日のみの場合は、その月日と今日の日付から最も自然な年を推測する。日付が一切見当たらない場合は null",
      "frame_by_frame_reading": ["1F: 7,スペア → 累計17", "2F: ストライク → 累計37", "...", "10F: ストライク,G(ガター),8 → 累計210"],
      "frames": [
        {"rolls": ["7","/"], "score": 17, "split_roll_index": null},
        {"rolls": ["X"], "score": 37, "split_roll_index": null},
        {"rolls": ["8","1"], "score": 46, "split_roll_index": 0},
        {"rolls": ["X","G","8"], "score": 210, "split_roll_index": null}
      ],
      "total_score": 178,
      "confidence_notes": ""
    }
  ]
}

ルール:
- games は配列。写っているゲームが1つだけでも、必ず配列(要素数1)として返す。複数ゲームが写っていれば、その数だけ要素を含める
- rolls の値は "0"〜"9" の数字文字列、ストライクは "X"、スペアは "/"、ガターは "G"、ファールは "F"、ミス(0本)は "-"。画面の記号と上の対応表に従って、記号をそのまま出力する
- frames は必ず10フレーム分(読み取れる範囲まで)
- 10フレーム目は最大3投
- score は、画面に表示されている各フレームの累計スコアの数字を、そのまま書き写す(自分で計算し直した値ではなく、表示どおりの値。投球記号の読み取りと矛盾していても、表示どおりの数字を書くこと)。10フレーム目まで画像に表示されている場合は、必ず10個分のscoreを埋めること。最終フレームの累計が画面上の「TOTAL」の値と一致するか必ず確認する
- split_roll_index は、そのフレームの中で数字が丸で囲まれている(スプリットを示す)投球が何投目か(0始まりのインデックス)を表す。スプリットは1投目とは限らず、10フレーム目のボーナス球(2投目・3投目)に付くこともあるので、実際に丸が付いている投球の位置を必ず確認すること。丸が付いた投球がなければ null
- frame_by_frame_reading は手順2〜3の思考過程を1フレームずつ短い日本語で記載する(この項目を必ず frames より先に埋めること)
- 画像にボウリングのスコア(電光掲示板・スコアシート)が写っていない場合(料理・風景・人物など無関係な写真)は、screen_type を "none"、player_matched を false、games を空配列にする。これが最優先で、名前の照合は行わない
- 指定された名前に一致する列が画面内に見つからない場合は player_matched を false にし、games は空配列、confidence_notes に「該当する名前が見つかりませんでした」等を記載(この場合 confidence_notes はJSONの一番外側に置いてよい)
- 名前の指定がない場合は player_matched を true とし、画面内の(唯一の、または最初の)プレイヤーのスコアを読み取る
- 数字がかすれている・反射で見えにくいなど読み取りに自信がない箇所は、そのゲームの confidence_notes に短く日本語で記載(なければ空文字)
- JSON以外は一切出力しない`;

  let response;
  try {
    response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await usageHeaders()) },
      body: JSON.stringify({ images, prompt }),
    });
  } catch (networkErr) {
    throw new Error(friendlyAiError("network", "スコア解析"));
  }

  if (!response.ok) {
    let code = "";
    try {
      code = (await response.json())?.error || "";
    } catch (_) {
      // body wasn't JSON — fall through to the generic message
    }
    throw new Error(friendlyAiError(code, "スコア解析"));
  }

  let data;
  try {
    data = await response.json();
  } catch (parseErr) {
    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch (_) {
      // ignore
    }
    console.error("analyze: response was not JSON:", (bodyText || parseErr.message || "").slice(0, 300));
    throw new Error(friendlyAiError("", "スコア解析"));
  }

  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    console.error("analyze: empty result:", JSON.stringify(data).slice(0, 300));
    throw new Error("うまく読み取れませんでした。もう一度お試しください。");
  }
  return extractJson(textBlock.text);
}

const PLAYER_NAME_KEY = "player-name";
const BALL_CONFIG_KEY = "ball-config";
const PROFILE_KEY = "profile";
const MY_BALLS_KEY = "my-balls";
const SHOE_CONFIG_KEY = "shoe-config";
const MY_SHOES_KEY = "my-shoes";

// ---------- scoreboard-style marks ----------
// Split: a circle around the pin count, matching the "⑧" style circled
// number used on paper scoresheets and many electronic boards.
function SplitWrap({ children }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: "50%",
        border: `1.5px solid ${COLORS.ink}`,
      }}
    >
      {children}
    </span>
  );
}

function RollMark({ val, split, markColor = COLORS.ink, size = 17 }) {
  if (val === undefined || val === "") return null;
  let content;
  if (val === "X") {
    // Strike: two triangles meeting point-to-point (bowtie shape), the
    // classic strike icon seen on paper scoresheets and electronic boards.
    content = (
      <svg width={size} height={size} viewBox="0 0 17 17" style={{ display: "block" }}>
        <polygon points="2,2 2,15 8.5,8.5" fill={markColor} />
        <polygon points="15,2 15,15 8.5,8.5" fill={markColor} />
      </svg>
    );
  } else if (val === "/") {
    // Spare: a single solid triangle filling the cell's corner.
    content = (
      <svg width={size} height={size} viewBox="0 0 17 17" style={{ display: "block" }}>
        <polygon points="2,15 15,15 15,2" fill={markColor} />
      </svg>
    );
  } else {
    content = val === "0" ? "-" : val;
  }
  return split ? <SplitWrap>{content}</SplitWrap> : content;
}

// ---------- frame box (signature scoresheet element) ----------
function FrameBox({ frame, index, isTenth, editable, activeCell, onCellTap }) {
  const rolls = frame?.rolls || [];
  const slots = isTenth ? 3 : 2;
  const splitRolls = frame?.splitRolls || [];
  return (
    <div
      style={{
        border: `2px solid ${COLORS.ink}`,
        background: COLORS.cream,
        minWidth: isTenth ? 74 : 54,
        flex: isTenth ? "0 0 74px" : "1 0 54px",
      }}
      className="flex flex-col"
    >
      <div className="text-center tracking-widest py-0.5" style={{ color: COLORS.ink, fontFamily: "'Oswald', sans-serif", fontSize: 12 }}>
        {index + 1}
      </div>
      <div className="flex border-t" style={{ borderColor: COLORS.ink }}>
        {Array.from({ length: slots }).map((_, i) => {
          const val = rolls[i];
          const isStrike = val === "X";
          const isSpare = val === "/";
          const cellColor = isStrike ? COLORS.strike : isSpare ? COLORS.gold : COLORS.ink;
          const circleThisCell = !!splitRolls[i];
          const isActive = editable && activeCell && activeCell.frameIdx === index && activeCell.rollIdx === i;
          return editable ? (
            <button
              key={i}
              type="button"
              onClick={() => onCellTap(index, i)}
              className="flex-1 flex items-center justify-center text-sm"
              style={{
                height: 28,
                borderRight: i < slots - 1 ? `1px solid ${COLORS.ink}` : "none",
                background: isActive ? "#EFE4CC" : "transparent",
                boxShadow: isActive ? `inset 0 0 0 2px ${COLORS.gold}` : "none",
                color: cellColor,
                fontWeight: 700,
                fontFamily: "'Oswald', sans-serif",
              }}
            >
              <RollMark val={val} split={circleThisCell} />
            </button>
          ) : (
            <div
              key={i}
              className="flex-1 flex items-center justify-center text-sm"
              style={{
                height: 28,
                borderRight: i < slots - 1 ? `1px solid ${COLORS.ink}` : "none",
                color: cellColor,
                fontWeight: 700,
                fontFamily: "'Oswald', sans-serif",
              }}
            >
              <RollMark val={val} split={circleThisCell} />
            </div>
          );
        })}
      </div>
      <div
        className="text-center text-base py-1 border-t"
        style={{ borderColor: COLORS.ink, color: COLORS.ink, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}
      >
        {frame?.score ?? ""}
      </div>
    </div>
  );
}

function ScoreSheet({ frames, editable, activeCell, onCellTap }) {
  return (
    <div className="flex w-full overflow-x-auto pb-1" style={{ gap: 2 }}>
      {Array.from({ length: 10 }).map((_, i) => (
        <FrameBox
          key={i}
          frame={frames[i]}
          index={i}
          isTenth={i === 9}
          editable={editable}
          activeCell={activeCell}
          onCellTap={onCellTap}
        />
      ))}
    </div>
  );
}

// ---------- roll picker (on-screen "keyboard" for correcting a roll) ----------
function RollPicker({ frameIdx, rollIdx, splitEligible, onSelect, onSplitToggle, splitActive, onClear, onClose }) {
  const numberBtn = (label, value) => (
    <button
      key={label}
      type="button"
      onClick={() => onSelect(value)}
      className="glass-card rounded-lg py-1"
      style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13 }}
    >
      {label}
    </button>
  );
  return (
    <div className="glass-card rounded-xl p-2 space-y-1.5">
      <div className="flex items-center justify-between" style={{ color: COLORS.strike, fontSize: 11 }}>
        <span>
          フレーム{frameIdx + 1} ・ {rollIdx + 1}投目を選択
        </span>
        <button type="button" onClick={onClose} className="flex items-center gap-1" style={{ color: COLORS.strike }}>
          <X size={12} /> 閉じる
        </button>
      </div>

      <div className="grid grid-cols-6 gap-1">
        {Array.from({ length: 11 }).map((_, n) => numberBtn(String(n), String(n)))}
        <button
          type="button"
          onClick={() => onSelect("X")}
          className="glass-card rounded-lg py-1 flex flex-col items-center justify-center gap-0.5"
          style={{ color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
        >
          <RollMark val="X" markColor={COLORS.strike} size={13} />
          <span style={{ fontSize: 8 }}>ストライク</span>
        </button>
      </div>

      <div className="grid grid-cols-5 gap-1">
        <button
          type="button"
          onClick={() => onSelect("/")}
          className="glass-card rounded-lg py-1 flex flex-col items-center justify-center gap-0.5"
          style={{ color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
        >
          <RollMark val="/" markColor={COLORS.strike} size={13} />
          <span style={{ fontSize: 8 }}>スペア</span>
        </button>
        <button
          type="button"
          onClick={() => onSelect("G")}
          className="glass-card rounded-lg py-1 px-0.5 whitespace-nowrap"
          style={{ color: COLORS.cream, fontWeight: 700, fontSize: 9.5 }}
        >
          G(ガーター)
        </button>
        <button
          type="button"
          onClick={() => onSelect("F")}
          className="glass-card rounded-lg py-1 px-0.5 whitespace-nowrap"
          style={{ color: COLORS.strike, fontWeight: 700, fontSize: 9.5 }}
        >
          F(ファール)
        </button>
        <button
          type="button"
          onClick={() => onSelect("-")}
          className="glass-card rounded-lg py-1 px-0.5 whitespace-nowrap"
          style={{ color: COLORS.cream, fontWeight: 700, fontSize: 9.5 }}
        >
          -(オープン)
        </button>
        <button
          type="button"
          onClick={onClear}
          className="glass-card rounded-lg py-1 px-0.5 whitespace-nowrap"
          style={{ color: COLORS.strike, fontWeight: 700, fontSize: 9.5 }}
        >
          クリア
        </button>
      </div>

      {splitEligible && (
        <button
          type="button"
          onClick={onSplitToggle}
          className="w-full rounded-lg py-1.5 flex items-center justify-center gap-2"
          style={{
            background: splitActive ? COLORS.gold : "rgba(40, 55, 95, 0.55)",
            border: `1px solid rgba(224, 168, 0, 0.55)`,
            color: splitActive ? "white" : COLORS.cream,
            fontWeight: 700,
            fontSize: 11,
          }}
        >
          スプリット(⑧のように丸で囲む){splitActive ? ": ON" : ""}
        </button>
      )}
    </div>
  );
}

// ---------- お知らせ (announcements) helpers ----------
// Which announcements this phone has already seen in the bell, and which
// event pop-ups the user chose "don't show again" for. Kept per phone.
const ANN_READ_KEY = "announcements-read";
const ANN_HIDDEN_KEY = "announcements-hidden";
const ANN_SHOWN_KEY = "announcements-shown"; // { [id]: times the launch pop-up was shown }
const EVENT_POPUP_MAX_SHOWS = 2; // each event pops up at most twice per phone, checked or not

function readShownCounts() {
  try {
    const o = JSON.parse(localStorage.getItem(ANN_SHOWN_KEY) || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) {
    return {};
  }
}

function readIdList(key) {
  try {
    const a = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function writeIdList(key, list) {
  // Keep only the most recent entries so this never grows without bound.
  localStorage.setItem(key, JSON.stringify(Array.from(new Set(list)).slice(-300)));
}

const announcementImageUrl = (a) =>
  `/api/announcements?image=${encodeURIComponent(a.id)}&v=${encodeURIComponent(a.imageVersion || "")}`;

function formatMonthDay(ymd) {
  if (!ymd) return "";
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
}

const ANNOUNCEMENT_TYPE_LABEL = { update: "アップデート", event: "イベント" };

// Shrinks a photo for an announcement: at most 1080px on the long side and
// under ~450KB, stepping quality (then size) down until it fits. Phone
// photos are often 5MB+, which would fail to upload and load slowly on a
// bowling alley's weak signal.
async function compressAnnouncementImage(file) {
  const img = await loadImageFromFile(file);
  const LIMIT = 600000; // base64 chars ≈ 450KB of JPEG
  let long = 1080;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = Math.min(1, long / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.85, 0.75, 0.65, 0.55]) {
      const url = canvas.toDataURL("image/jpeg", q);
      const base64 = url.split(",")[1];
      if (base64.length <= LIMIT) return { base64, mediaType: "image/jpeg", previewUrl: url, width: w, height: h };
    }
    long = Math.round(long * 0.8);
  }
  throw new Error("画像を十分に小さくできませんでした。別の画像でお試しください");
}

// One announcement as shown in the bell list (and in the admin preview).
function AnnouncementCard({ a, imageSrc }) {
  const src = imageSrc || (a.hasImage ? announcementImageUrl(a) : null);
  return (
    <div className="glass-card rounded-xl p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: 999,
            background: a.type === "event" ? COLORS.gold : "rgba(255,255,255,0.14)",
            color: a.type === "event" ? COLORS.ink : COLORS.strike,
          }}
        >
          {ANNOUNCEMENT_TYPE_LABEL[a.type] || "お知らせ"}
        </span>
        <span style={{ color: COLORS.strike, opacity: 0.7, fontSize: 12 }}>
          {a.type === "event" && a.endDate
            ? `${a.startDate ? formatMonthDay(a.startDate) : ""}〜${formatMonthDay(a.endDate)}`
            : formatMonthDay(a.startDate || (a.createdAt || "").slice(0, 10))}
        </span>
      </div>
      <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 16, overflowWrap: "anywhere" }}>{a.title}</div>
      {src && (
        <img src={src} alt={a.title} style={{ width: "100%", borderRadius: 10, display: "block" }} loading="lazy" />
      )}
      {a.body && (
        <div
          style={{ color: COLORS.strike, opacity: 0.85, fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {a.body}
        </div>
      )}
    </div>
  );
}

function BellPanel({ items, onClose }) {
  return (
    <div
      className="fixed left-0 right-0 top-0 bottom-0 flex flex-col"
      style={{ background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, zIndex: 50 }}
    >
      <div
        className="flex items-center justify-between px-4"
        style={{ background: COLORS.ink, paddingTop: "calc(16px + max(env(safe-area-inset-top), 20px))", paddingBottom: 16 }}
      >
        <div className="flex items-center gap-2">
          <Bell size={20} style={{ color: COLORS.strike }} />
          <div style={{ color: COLORS.cream, fontWeight: 700 }}>お知らせ</div>
        </div>
        <button type="button" onClick={onClose} aria-label="閉じる">
          <X size={22} style={{ color: COLORS.cream }} />
        </button>
      </div>
      <div
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}
      >
        {items.length === 0 && (
          <div className="text-center py-10" style={{ color: COLORS.strike, opacity: 0.8, fontSize: 14 }}>
            お知らせはまだありません
          </div>
        )}
        {items.map((a) => (
          <AnnouncementCard key={a.id} a={a} />
        ))}
      </div>
    </div>
  );
}

// The one-image event ad shown after the app opens. "Don't show again"
// applies to this announcement only; it stays in the bell either way.
function EventPopup({ a, imageSrc, hideChecked, onToggleHide, onClose }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(8, 12, 26, 0.78)", zIndex: 55, padding: "max(env(safe-area-inset-top), 24px) 20px max(env(safe-area-inset-bottom), 24px)" }}
    >
      <div className="glass-card rounded-2xl w-full" style={{ maxWidth: 360, padding: 14, maxHeight: "100%", overflowY: "auto" }}>
        <img
          src={imageSrc || announcementImageUrl(a)}
          alt={a.title}
          style={{ width: "100%", maxHeight: "58vh", objectFit: "contain", borderRadius: 10, display: "block", background: "rgba(0,0,0,0.25)" }}
        />
        <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 16, marginTop: 12, overflowWrap: "anywhere" }}>{a.title}</div>
        {a.endDate && (
          <div style={{ color: COLORS.gold, fontSize: 13, fontWeight: 700, marginTop: 4 }}>{formatMonthDay(a.endDate)}まで</div>
        )}
        <label className="flex items-center gap-2" style={{ marginTop: 14, color: COLORS.strike, fontSize: 14, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={hideChecked}
            onChange={onToggleHide}
            style={{ width: 18, height: 18, accentColor: COLORS.gold }}
          />
          今後この通知を表示しない
        </label>
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-lg"
          style={{ marginTop: 12, padding: "12px 0", background: COLORS.strike, color: COLORS.ink, fontWeight: 700, fontSize: 15 }}
        >
          閉じる
        </button>
      </div>
    </div>
  );
}

// Full-screen fireworks + a card listing what was just achieved.
// Rockets launch for a few seconds, then the sparks fade out; the card stays
// until the user closes it. Skips the animation for people who've turned on
// "reduce motion" in their phone settings.
const FIREWORK_COLORS = ["#E0A800", "#FFD54F", "#FFFFFF", "#FF7A7A", "#6EC6FF", "#8FE388"];

function Fireworks() {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const W = () => window.innerWidth;
    const H = () => window.innerHeight;
    const rockets = [];
    const sparks = [];
    const start = performance.now();
    let lastLaunch = 0;
    let raf;

    const launch = () => {
      rockets.push({
        x: W() * (0.1 + Math.random() * 0.8),
        y: H(),
        vy: -(H() * 0.018 + Math.random() * H() * 0.006),
        targetY: H() * (0.06 + Math.random() * 0.26),
        color: FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)],
      });
    };
    const explode = (r) => {
      const count = 80 + Math.floor(Math.random() * 40);
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count;
        const speed = 2.5 + Math.random() * 4.5;
        sparks.push({
          x: r.x,
          y: r.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 0.012 + Math.random() * 0.01,
          color: Math.random() < 0.25 ? "#FFFFFF" : r.color,
        });
      }
    };

    const tick = (now) => {
      const elapsed = now - start;
      if (elapsed < 4000 && now - lastLaunch > 320) {
        launch();
        if (Math.random() < 0.4) launch();
        lastLaunch = now;
      }
      ctx.clearRect(0, 0, W(), H());

      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.y += r.vy;
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        if (r.y <= r.targetY) {
          explode(r);
          rockets.splice(i, 1);
        }
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.vx *= 0.985;
        s.vy = s.vy * 0.985 + 0.05; // gentle gravity
        s.x += s.vx;
        s.y += s.vy;
        s.life -= s.decay;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = s.life;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (elapsed < 4000 || rockets.length || sparks.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 61 }}
    />
  );
}

function AchievementIcon({ kind }) {
  const s = { color: COLORS.gold, flexShrink: 0 };
  if (kind === "strikes") return <div style={{ width: 22, display: "flex", justifyContent: "center" }}><RollMark val="X" markColor={COLORS.gold} size={20} /></div>;
  if (kind === "spares") return <div style={{ width: 22, display: "flex", justifyContent: "center" }}><RollMark val="/" markColor={COLORS.gold} size={20} /></div>;
  if (kind === "goalScore") return <Target size={22} style={s} />;
  if (kind === "goalAverage") return <TrendingUp size={22} style={s} />;
  return <Trophy size={22} style={s} />;
}

// Centered popup used for prompts that need the user's attention.
function AppModal({ title, children, footer }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 58,
        background: "rgba(8, 12, 26, 0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div className="glass-card rounded-2xl w-full" style={{ maxWidth: 360, padding: "20px 18px", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ color: COLORS.gold, fontWeight: 700, fontSize: 16 }}>{title}</div>
        <div style={{ marginTop: 10 }}>{children}</div>
        {footer && <div style={{ marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
  );
}

function Celebration({ items, onClose }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(8, 12, 26, 0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <Fireworks />
      <div
        className="glass-card rounded-2xl w-full"
        style={{ maxWidth: 340, padding: "24px 20px", position: "relative", zIndex: 62, textAlign: "center" }}
      >
        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.2em", color: COLORS.gold }}>
          CONGRATULATIONS
        </div>
        <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 22, marginTop: 4 }}>おめでとうございます!</div>
        <div className="space-y-3" style={{ marginTop: 18, textAlign: "left" }}>
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-3">
              <AchievementIcon kind={it.kind} />
              <div style={{ minWidth: 0 }}>
                <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 16 }}>{it.title}</div>
                {it.detail && <div style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12, marginTop: 1 }}>{it.detail}</div>}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-lg"
          style={{ marginTop: 22, padding: "12px 0", background: COLORS.gold, color: COLORS.ink, fontWeight: 700, fontSize: 15 }}
        >
          閉じる
        </button>
      </div>
    </div>
  );
}

// 記録タブ「ボール別の成績」: each measure as a 1位〜3位 ranking with a bar
// showing its size, so balls compare at a glance. Which balls are ranked
// depends on who is responsible for the result:
//   ball set (main + spare) → final score, open frames
//   main ball (1st ball)    → strikes, splits, gutters
//   spare ball (2nd ball)   → spares, split covers
// "(ワースト)" lists put the worst first. Empty places show 「ー 該当なし」.
const RANK_SLOTS = 3;

// ポイント評価: 1位〜3位 = 3・2・1点, added up across rankings. Computed,
// not AI (no cost). For ワースト measures the order is flipped so the BEST
// result gets the points; ゲーム数 is left out (usage, not performance);
// equal values share a place.
function rankPoints(items, value, higherIsBetter) {
  const withVal = items.map((x) => ({ x, v: value(x) })).filter((r) => r.v !== null && Number.isFinite(r.v));
  const better = (a, b) => (higherIsBetter ? a > b + 1e-9 : a < b - 1e-9);
  return withVal.map((r) => {
    const place = 1 + withVal.filter((o) => better(o.v, r.v)).length;
    return { x: r.x, points: place <= 3 ? 4 - place : 0 };
  });
}

// Each group is compared only against its own kind — sets with sets, main
// balls with main balls, spare balls with spare balls — so everyone competes
// in the same rankings for the same maximum. A ranking where any compared item
// has no data (e.g. a spare ball that never faced a split) gives nobody points,
// so no ball loses points it never had the chance to earn. The maximum stays
// fixed (12 / 9 / 6).
// Always names ONE winner: on equal points, the higher key number wins
// (tiebreak — average / strike rate / spare rate), then the one used in more games.
function scoreGroup(items, measures, keyOf, nameOf, tiebreak) {
  if (!items.length) return null;
  // A single option would "win" every ranking by default — not a real result.
  if (items.length < 2) return { single: true };
  const acc = new Map(items.map((x) => [keyOf(x), { x, name: nameOf(x), points: 0 }]));
  let counted = 0;
  for (const [value, higherIsBetter] of measures) {
    if (items.some((x) => value(x) === null || !Number.isFinite(value(x)))) continue;
    counted += 1;
    for (const { x, points } of rankPoints(items, value, higherIsBetter)) acc.get(keyOf(x)).points += points;
  }
  if (!counted) return null;
  const tb = (r) => {
    const v = tiebreak ? tiebreak(r.x) : null;
    return v === null || !Number.isFinite(v) ? -Infinity : v;
  };
  const [top] = [...acc.values()].sort(
    (a, b) => b.points - a.points || tb(b) - tb(a) || (b.x.games?.length || 0) - (a.x.games?.length || 0)
  );
  // 満点 is fixed: every ranking of the category × 3, whether or not it could
  // be scored this time (a ranking without data simply gives everyone 0).
  return { points: top.points, max: measures.length * 3, names: [top.name] };
}

function computeBallPoints({ sets, mains, spares }, setName) {
  const ratio = (a, b) => (b > 0 ? a / b : null);
  return {
    set: scoreGroup(
      sets,
      [
        [(s) => s.stats.avg, true],
        [(s) => s.stats.highGame, true],
        [(s) => s.stats.lowGame, true], // ローゲーム: a higher low game is better
        [(s) => ratio(s.stats.openFrameCount, s.stats.frameCount), false], // fewer open frames is better
      ],
      (s) => s.key,
      setName,
      (s) => s.stats.avg
    ),
    main: scoreGroup(
      mains,
      [
        [(m) => ratio(m.stats.strikeCount, m.stats.frameCount), true],
        [(m) => ratio(m.roles.splits, m.roles.firstBalls), false],
        [(m) => ratio(m.roles.firstGutters, m.roles.firstBalls), false],
      ],
      (b) => b.key,
      (b) => b.name,
      (m) => ratio(m.stats.strikeCount, m.stats.frameCount)
    ),
    spare: scoreGroup(
      spares,
      [
        [(s) => ratio(s.stats.spareCount, s.stats.spareChances), true],
        [(s) => ratio(s.roles.splitCovers, s.roles.splitChances), true],
      ],
      (b) => b.key,
      (b) => b.name,
      (s) => ratio(s.stats.spareCount, s.stats.spareChances)
    ),
  };
}

// Builds the 総合評価 cards: for sets / main balls / spare balls, the point
// winner, its key number (average / strike rate / spare rate), and the
// runner-up on that number for comparison.
const EVAL_AVG_GAP = 5; // pins of average
const EVAL_RATE_GAP = 5; // percentage points

function buildEvaluationCards({ sets, mains, spares }, points, setName) {
  // Every measure that counts toward the category's points, shown as the
  // winner's actual result — so it's clear the verdict isn't one number.
  const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "ー");
  const card = (key, label, pts, items, nameOf, details) => {
    if (!pts) return null;
    if (pts.single) return { key, label, single: true };
    const winner = items.find((x) => nameOf(x) === pts.names[0]);
    return { key, label, name: pts.names[0], points: pts.points, max: pts.max, details: winner ? details(winner) : [] };
  };
  return {
    cards: [
      card("set", "組み合わせ", points.set, sets, setName, (s) => [
        ["アベレージ", `${s.stats.avg}`],
        ["ハイ", `${s.stats.highGame}`],
        ["ロー", `${s.stats.lowGame}`],
        ["オープン", pct(s.stats.openFrameCount, s.stats.frameCount)],
      ]),
      card("main", "メインボール", points.main, mains, (m) => m.name, (m) => [
        ["ストライク", pct(m.stats.strikeCount, m.stats.frameCount)],
        ["スプリット", pct(m.roles.splits, m.roles.firstBalls)],
        ["ガター", pct(m.roles.firstGutters, m.roles.firstBalls)],
      ]),
      card("spare", "スペアボール", points.spare, spares, (s) => s.name, (s) => [
        ["スペア", pct(s.stats.spareCount, s.stats.spareChances)],
        ["スプリットカバー", pct(s.roles.splitCovers, s.roles.splitChances)],
      ]),
    ].filter(Boolean),
  };
}

function BallRankings({ stats }) {
  const setName = (s) => (s.spare ? `${s.main.name}＋${s.spare.name}` : s.main.name);
  const rate = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  // A ball with a count of 0 has nothing to rank (e.g. 0 split covers), so it
  // is left out and its place shows 「ー 該当なし」 — in every ranking.
  const byRate = (list, count, of) =>
    list
      .filter((x) => of(x) > 0 && count(x) > 0)
      .map((x) => ({ x, count: count(x), r: rate(count(x), of(x)) }))
      .sort((a, b) => b.r - a.r || b.count - a.count)
      .map(({ x, count: n, r }) => ({ name: x.name ?? setName(x), bar: r, text: `${n}(${r}%)` }));
  const byValue = (list, value, text, { asc = false } = {}) => {
    const rows = list.map((x) => ({ x, v: value(x) })).sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
    const max = Math.max(1, ...rows.map((r) => r.v));
    return rows.map(({ x, v }) => ({ name: setName(x), bar: (v / max) * 100, text: text(v) }));
  };
  // Balls and sets with fewer than 3 games are left out entirely: with that
  // little data a ranking would mostly reflect luck.
  const enough = (list) => list.filter((x) => x.reliable);
  const sets = enough(stats.sets);
  const mains = enough(stats.mains);
  const spares = enough(stats.spares);

  const rankings = [
    { title: "ゲーム数", unit: "ボールセット", rows: byValue(sets, (s) => s.games.length, (v) => `${v}ゲーム`) },
    { title: "アベレージ", unit: "ボールセット", rows: byValue(sets, (s) => s.stats.avg, (v) => `${v}`) },
    { title: "ハイゲーム", unit: "ボールセット", rows: byValue(sets, (s) => s.stats.highGame, (v) => `${v}`) },
    { title: "ローゲーム(ワースト)", unit: "ボールセット", rows: byValue(sets, (s) => s.stats.lowGame, (v) => `${v}`, { asc: true }) },
    { title: "ストライク", unit: "メインボール", rows: byRate(mains, (m) => m.stats.strikeCount, (m) => m.stats.frameCount) },
    { title: "スペア", unit: "スペアボール", rows: byRate(spares, (s) => s.stats.spareCount, (s) => s.stats.spareChances) },
    {
      title: "オープンフレーム(ワースト)",
      unit: "ボールセット",
      rows: byRate(sets, (s) => s.stats.openFrameCount, (s) => s.stats.frameCount),
    },
    { title: "スプリット(ワースト)", unit: "メインボール", rows: byRate(mains, (m) => m.roles.splits, (m) => m.roles.firstBalls) },
    { title: "スプリットカバー", unit: "スペアボール", rows: byRate(spares, (s) => s.roles.splitCovers, (s) => s.roles.splitChances) },
    {
      title: "ガター(ワースト)",
      unit: "メインボール",
      rows: byRate(mains, (m) => m.roles.firstGutters, (m) => m.roles.firstBalls),
    },
  ];

  const medal = ["#E0A800", "#C9CED6", "#C08457"];
  const points = computeBallPoints({ sets, mains, spares }, setName);
  const evaluation = buildEvaluationCards({ sets, mains, spares }, points, setName);
  if (!sets.length && !mains.length && !spares.length) {
    return (
      <div className="px-3 pb-4" style={{ color: COLORS.strike, fontSize: 13, lineHeight: 1.7, opacity: 0.85 }}>
        ※この期間に3ゲーム以上使用したボール・ボールセットはありません
        <br />
        ※3ゲーム未満のボール・ボールセットは、統計的な信頼性が低いため、ランキングの対象外としています
        <br />
        ※期間を「月」「年」「期間指定」に広げると表示される場合があります
      </div>
    );
  }
  return (
    <div className="px-3 pb-3 space-y-3">
      {evaluation.cards.length > 0 && (
        <div className="space-y-2">
          <div>
            <div className="flex items-center gap-2" style={{ color: COLORS.gold, fontWeight: 700, fontSize: 15 }}>
              <Trophy size={16} /> 総合評価
            </div>
            <div style={{ color: COLORS.strike, opacity: 0.65, fontSize: 11.5, marginTop: 2 }}>
              ランキング順位の合計点(1位3点・2位2点・3位1点)
            </div>
          </div>

          {evaluation.cards.map((cd) => {
            // Same trophy for every category: each card is that category's 1位.
            const icon = <Trophy size={18} style={{ color: COLORS.gold }} />;
            return (
              <div key={cd.key} className="rounded-lg p-3" style={{ background: "rgba(10, 16, 34, 0.55)", border: "1px solid rgba(224,168,0,0.35)" }}>
                <div className="flex items-center gap-3">
                  <div
                    className="flex items-center justify-center rounded-full"
                    style={{ width: 34, height: 34, flexShrink: 0, border: `1.5px solid ${COLORS.gold}`, background: "rgba(224,168,0,0.1)" }}
                  >
                    {icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11 }}>
                      <span style={{ color: COLORS.strike, opacity: 0.65 }}>{cd.label}</span>
                      {!cd.single && <span style={{ color: COLORS.gold, fontWeight: 700 }}> 1位</span>}
                    </div>
                    <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {cd.single ? "比較対象なし" : cd.name}
                    </div>
                  </div>
                  {!cd.single && (
                    <div className="text-right" style={{ flexShrink: 0, lineHeight: 1.1 }}>
                      <div>
                        <span style={{ color: COLORS.gold, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 24 }}>{cd.points}</span>
                        <span style={{ color: COLORS.gold, fontSize: 12, fontWeight: 700 }}>点</span>
                      </div>
                      <div style={{ color: COLORS.strike, opacity: 0.55, fontSize: 10.5 }}>{cd.max}点満点</div>
                    </div>
                  )}
                </div>
                {!cd.single && cd.details.length > 0 && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${cd.details.length}, 1fr)`,
                      marginTop: 10,
                      paddingTop: 8,
                      borderTop: "1px solid rgba(224,168,0,0.18)",
                    }}
                  >
                    {cd.details.map(([k, v], i) => (
                      <div
                        key={k}
                        className="text-center"
                        style={{ borderLeft: i ? "1px solid rgba(224,168,0,0.15)" : "none", minWidth: 0 }}
                      >
                        <div style={{ color: COLORS.strike, opacity: 0.6, fontSize: 10.5, whiteSpace: "nowrap" }}>{k}</div>
                        <div style={{ color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {rankings.map((rk) => {
        const rows = rk.rows.slice(0, RANK_SLOTS);
        while (rows.length < RANK_SLOTS) rows.push(null);
        return (
          <div key={rk.title} style={{ borderTop: "1px solid rgba(224,168,0,0.25)", paddingTop: 10 }}>
            <div className="flex items-baseline justify-between gap-2" style={{ marginBottom: 6 }}>
              <span style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14 }}>{rk.title}</span>
              <span style={{ color: COLORS.strike, opacity: 0.6, fontSize: 11 }}>{rk.unit}</span>
            </div>
            <div className="space-y-1.5">
              {rows.map((row, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <span
                      style={{
                        width: 30,
                        flexShrink: 0,
                        color: row ? medal[i] : "rgba(245,241,228,0.4)",
                        fontFamily: "'Oswald', sans-serif",
                        fontWeight: 700,
                        fontSize: 14,
                      }}
                    >
                      {i + 1}位
                    </span>
                    {row ? (
                      <>
                        <span
                          style={{ flex: 1, minWidth: 0, color: COLORS.strike, fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {row.name}
                        </span>
                        <span style={{ flexShrink: 0, color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15 }}>
                          {row.text}
                        </span>
                      </>
                    ) : (
                      <span style={{ flex: 1, color: COLORS.strike, opacity: 0.45, fontSize: 13 }}>ー 該当なし</span>
                    )}
                  </div>
                  {row && (
                    <div style={{ marginLeft: 38, height: 5, borderRadius: 3, background: "rgba(245,241,228,0.1)", overflow: "hidden" }}>
                      <div style={{ width: `${Math.max(2, Math.min(100, row.bar))}%`, height: "100%", borderRadius: 3, background: medal[i] }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div style={{ color: COLORS.strike, opacity: 0.6, fontSize: 11, lineHeight: 1.6 }}>
        ※点数:各ランキングの1位・2位・3位に3点・2点・1点(ワーストは良い順、ゲーム数は対象外)
        <br />※同点時:アベレージ(メインはストライク率、スペアはスペア率)が高い方、次にゲーム数が多い方を表示
        <br />※データがないランキング(例:スプリットが一度もない)は全ボール0点
        <br />※ガター:1投目(メインボール)のみで集計
        <br />※3ゲーム未満のボール・組み合わせは対象外
        <br />※2個目なしのゲームは、メインボールをスペアボールとして集計
      </div>
    </div>
  );
}

// Full-screen editor for boxing your own score row. Uses the whole screen so
// the photo is as large as possible:
//   one finger  → draw the box
//   two fingers → pinch to zoom in / drag to move around the photo
// The box is stored in 0..1 coordinates of the photo, so zoom never affects it.
function CropEditor({ src, initialRect, onDone, onSkip }) {
  const stageRef = useRef(null);
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const [fit, setFit] = useState(null); // displayed photo size at zoom 1
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [rect, setRect] = useState(initialRect || null);
  const [draft, setDraft] = useState(null);
  const pointers = useRef(new Map());
  const drawStart = useRef(null);
  const pinch = useRef(null);
  const waitAllUp = useRef(false); // after a pinch, ignore the leftover finger until all lift

  // Fit the photo inside the available area (like a photo viewer).
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || !img.naturalWidth) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const k = Math.min(sw / img.naturalWidth, sh / img.naturalHeight);
    setFit({ w: Math.round(img.naturalWidth * k), h: Math.round(img.naturalHeight * k) });
  }, []);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const toNorm = (x, y) => {
    const b = imgRef.current.getBoundingClientRect(); // already includes zoom/move
    return {
      x: Math.min(1, Math.max(0, (x - b.left) / b.width)),
      y: Math.min(1, Math.max(0, (y - b.top) / b.height)),
    };
  };
  const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  // Where the photo sits on screen before any zoom/move is applied.
  const baseOrigin = () => {
    const st = stageRef.current.getBoundingClientRect();
    const w = wrapRef.current;
    return { L: st.left + w.offsetLeft, T: st.top + w.offsetTop };
  };

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const { L, T } = baseOrigin();
    const v = viewRef.current;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    pinch.current = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      s0: v.s,
      // the photo point under the fingers' midpoint stays under it while zooming
      qx: (mx - L - v.tx) / v.s,
      qy: (my - T - v.ty) / v.s,
      L,
      T,
    };
  };

  const onPointerDown = (e) => {
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch (err) {
      // Some browsers refuse capture; drawing and zoom still work without it.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1 && !waitAllUp.current) {
      drawStart.current = toNorm(e.clientX, e.clientY);
      setDraft({ ...drawStart.current, w: 0, h: 0 });
    } else if (pointers.current.size === 2) {
      drawStart.current = null; // a second finger means zoom, not draw
      setDraft(null);
      waitAllUp.current = true;
      startPinch();
    }
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const p = pinch.current;
      const s = Math.min(5, Math.max(1, p.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / p.d0)));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (s <= 1.01) setView({ s: 1, tx: 0, ty: 0 });
      else setView({ s, tx: mx - p.L - p.qx * s, ty: my - p.T - p.qy * s });
    } else if (drawStart.current) {
      setDraft(rectFrom(drawStart.current, toNorm(e.clientX, e.clientY)));
    }
  };

  const onPointerEnd = (e) => {
    const wasDrawing = drawStart.current && pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) waitAllUp.current = false;
    if (wasDrawing) {
      const r = rectFrom(drawStart.current, toNorm(e.clientX, e.clientY));
      drawStart.current = null;
      setDraft(null);
      if (r.w > 0.04 && r.h > 0.015) setRect(r); // ignore accidental taps
    }
  };

  const shown = draft || rect;
  const zoomed = view.s > 1.01;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 55,
        background: "#0B1020",
        display: "flex",
        flexDirection: "column",
        paddingTop: "max(env(safe-area-inset-top), 20px)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div style={{ padding: "10px 16px" }}>
        <div className="flex items-center gap-2">
          <Crop size={18} style={{ color: COLORS.gold, flexShrink: 0 }} />
          <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 15 }}>自分の行を、名前から合計まで囲む</div>
        </div>
        <div style={{ color: COLORS.strike, opacity: 0.7, fontSize: 12, marginTop: 2 }}>
          1本指でなぞって囲む ・ 2本指で拡大・移動
        </div>
      </div>

      <div
        ref={stageRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div
          ref={wrapRef}
          style={{
            position: "relative",
            width: fit ? fit.w : "auto",
            height: fit ? fit.h : "auto",
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
            transformOrigin: "0 0",
            flexShrink: 0,
          }}
        >
          <img
            ref={imgRef}
            src={src}
            alt="スコア写真"
            draggable={false}
            onLoad={measure}
            style={{ display: "block", width: "100%", height: "100%", pointerEvents: "none", visibility: fit ? "visible" : "hidden" }}
          />
          {shown && shown.w > 0 && (
            <div
              style={{
                position: "absolute",
                left: `${shown.x * 100}%`,
                top: `${shown.y * 100}%`,
                width: `${shown.w * 100}%`,
                height: `${shown.h * 100}%`,
                border: `${2 / view.s}px solid ${COLORS.gold}`,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      </div>

      <div style={{ padding: "10px 16px 12px" }} className="space-y-2">
        {zoomed && (
          <button
            type="button"
            onClick={() => setView({ s: 1, tx: 0, ty: 0 })}
            className="w-full rounded-lg py-2 text-sm"
            style={{ border: `1px solid rgba(184, 153, 104, 0.6)`, color: COLORS.strike }}
          >
            拡大を戻す
          </button>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="flex-1 rounded-lg py-3 text-sm"
            style={{ border: `1px solid rgba(184, 153, 104, 0.6)`, color: COLORS.strike, fontWeight: 700 }}
          >
            囲まずに進む
          </button>
          <button
            type="button"
            onClick={() => rect && onDone(rect)}
            disabled={!rect}
            className="flex-1 rounded-lg py-3 text-sm"
            style={primaryButtonStyle(!!rect)}
          >
            この範囲で決定
          </button>
        </div>
      </div>
    </div>
  );
}

// The chosen photo on the scan screen, with the box drawn on it (read-only).
function CropPreview({ src, rect }) {
  return (
    <div className="flex justify-center">
      <div className="relative overflow-hidden rounded-xl border" style={{ borderColor: COLORS.oak }}>
        <img src={src} alt="囲んだ範囲のプレビュー" style={{ display: "block", maxWidth: "100%", maxHeight: "45vh" }} />
        {rect && (
          <div
            style={{
              position: "absolute",
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
              border: `2px solid ${COLORS.gold}`,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    </div>
  );
}


// ---------- access gate ----------
// Shown instead of the app until the person's device has been approved by
// the admin. "checking" while we ask the server, then one of the statuses.
function GateScreen({
  mode,
  name,
  setName,
  onSubmit,
  requestNumber,
  onLogin,
  onSignup,
  authBusy,
  authErrorMsg,
  justSignedOut,
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [accountMode, setAccountMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = async () => {
    if (!name.trim()) {
      setError("お名前を入力してください");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmit();
    } catch (e) {
      setError("送信に失敗しました。もう一度お試しください");
    } finally {
      setSubmitting(false);
    }
  };

  const submitAccount = async () => {
    if (!email.trim() || !password) return;
    if (accountMode === "login") await onLogin(email.trim(), password);
    else await onSignup(email.trim(), password);
  };

  return (
    <div
      style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');`}</style>
      <div style={{ maxWidth: 340, width: "100%", fontFamily: "'Noto Sans JP', sans-serif" }} className="text-center space-y-4">
        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 26, color: COLORS.cream }}>
          STRIKE LOG
        </div>

        {justSignedOut && (
          <div
            className="rounded-lg p-3 text-sm"
            style={{ background: "rgba(224,168,0,0.12)", border: `1px solid ${COLORS.oak}`, color: COLORS.cream }}
          >
            別の端末でログインされたため、この端末はログアウトされました。この端末で引き続き使う場合は、もう一度ログインしてください。
          </div>
        )}

        {mode === "checking" && <div style={{ color: COLORS.strike }}>確認中...</div>}
        {mode === "syncing" && <div style={{ color: COLORS.strike }}>記録を読み込み中...</div>}

        {(mode === "not_found" || mode === "error") && !showAccountForm && (
          <>
            <div style={{ color: COLORS.cream, fontSize: 14 }}>
              このアプリは招待制です。利用するには申請が必要です。
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="お名前"
              className="w-full px-3 py-2 rounded border text-sm"
              style={{ borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink }}
            />
            {error && <div style={{ color: "#E8836A", fontSize: 14 }}>{error}</div>}
            <button
              onClick={submit}
              disabled={submitting}
              className="w-full rounded-lg py-3"
              style={{ background: COLORS.gold, color: COLORS.cream, fontWeight: 700 }}
            >
              {submitting ? "送信中..." : "利用をリクエストする"}
            </button>
            <button
              onClick={() => setShowAccountForm(true)}
              className="w-full text-sm underline"
              style={{ color: COLORS.strike }}
            >
              アカウントをお持ちの方はこちら
            </button>
          </>
        )}

        {(mode === "not_found" || mode === "error" || mode === "pending" || mode === "rejected") && showAccountForm && (
          <div className="rounded-xl p-4 space-y-3" style={{ border: `1px solid ${COLORS.oak}` }}>
            <div className="flex gap-2">
              <button
                onClick={() => setAccountMode("login")}
                className="flex-1 rounded-lg py-2 text-xs"
                style={toggleStyle(accountMode === "login")}
              >
                ログイン
              </button>
              <button
                onClick={() => setAccountMode("signup")}
                className="flex-1 rounded-lg py-2 text-xs"
                style={toggleStyle(accountMode === "signup")}
              >
                アカウント作成
              </button>
            </div>
            <div className="text-xs text-left" style={{ color: COLORS.strike }}>
              アカウントを作っておくと、機種変更した時に再度承認を待たずに、ログインするだけで引き継げます。
              <br />
              (同時に使えるのは1台のみです。新しい端末でログインすると、前の端末は自動でログアウトされます)
            </div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="メールアドレス"
              className="w-full px-3 py-2 rounded border text-sm"
              style={{ borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink }}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="パスワード(6文字以上)"
              className="w-full px-3 py-2 rounded border text-sm"
              style={{ borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink }}
            />
            {authErrorMsg && <div style={{ color: "#E8836A", fontSize: 13 }}>{authErrorMsg}</div>}
            <button
              onClick={submitAccount}
              disabled={authBusy}
              className="w-full rounded-lg py-3"
              style={{ background: COLORS.gold, color: COLORS.cream, fontWeight: 700 }}
            >
              {authBusy ? "処理中..." : accountMode === "login" ? "ログイン" : "アカウントを作成"}
            </button>
            <button
              onClick={() => setShowAccountForm(false)}
              className="w-full text-sm underline"
              style={{ color: COLORS.strike }}
            >
              もどる
            </button>
          </div>
        )}

        {mode === "pending" && !showAccountForm && (
          <div className="space-y-2">
            <div style={{ color: COLORS.cream, fontSize: 14 }}>
              利用申請を受け付けました。管理者の承認をお待ちください。
            </div>
            {requestNumber && (
              <div style={{ color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16 }}>
                あなたの登録番号: {formatRequestNumber(requestNumber)}
              </div>
            )}
            <button
              onClick={() => setShowAccountForm(true)}
              className="w-full text-sm underline"
              style={{ color: COLORS.strike }}
            >
              アカウントをお持ちの方はこちら
            </button>
          </div>
        )}

        {mode === "rejected" && !showAccountForm && (
          <div className="space-y-2">
            <div style={{ color: "#E8836A", fontSize: 14 }}>この端末での利用は承認されませんでした。</div>
            <button
              onClick={() => setShowAccountForm(true)}
              className="w-full text-sm underline"
              style={{ color: COLORS.strike }}
            >
              アカウントをお持ちの方はこちら
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- admin panel (approve access requests, review feedback) ----------
// Admin: post, preview, edit, and delete お知らせ.
const EMPTY_ANN_FORM = { id: null, type: "update", title: "", body: "", startDate: "", endDate: "" };

// ---------- 使用量・コスト (admin) ----------
// Per-user AI usage and actual cost for a month, plus the month's whole-
// business cost picture: AI (recorded automatically) + fixed costs and
// revenue (entered by hand), with a 6-month trend.
const yen = (n) => {
  // Exact to 0.1 yen (dollar costs converted at the rate rarely land on a whole
  // yen); whole amounts show no decimal.
  const v = Math.round((Number(n) || 0) * 10) / 10;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return `${sign}¥${a.toLocaleString("ja-JP", { minimumFractionDigits: Number.isInteger(a) ? 0 : 1, maximumFractionDigits: 1 })}`;
};
const shortDateJST = (iso) => {
  if (!iso) return "なし";
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : Infinity);

function AdminUsage({ password }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fixed, setFixed] = useState([]);
  const [revenue, setRevenue] = useState("");
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const load = async (month) => {
    setLoading(true);
    setError("");
    setSavedMsg("");
    try {
      const res = await fetch(
        `/api/admin/requests?password=${encodeURIComponent(password)}&view=usage${month ? `&month=${month}` : ""}`
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "読み込みに失敗しました");
      if (!d || !d.month) throw new Error("使用量データの形式が正しくありません");
      // Fill in anything missing, so one odd response can never blank the
      // whole admin panel (approvals included).
      const safe = {
        ...d,
        currentMonth: d.currentMonth || d.month,
        totals: d.totals || {},
        users: Array.isArray(d.users) ? d.users : [],
        history: Array.isArray(d.history) ? d.history : [],
        fixedCosts: Array.isArray(d.fixedCosts) ? d.fixedCosts : [],
        usdJpy: Number(d.usdJpy) || 150,
      };
      setData(safe);
      setFixed(safe.fixedCosts);
      setRevenue(safe.revenueJpy ? String(safe.revenueJpy) : "");
      setRate(String(safe.usdJpy));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(null);
  }, []);

  const save = async () => {
    setSaving(true);
    setSavedMsg("");
    try {
      const res = await fetch("/api/admin/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, action: "finance", month: data.month, fixedCosts: fixed, revenueJpy: Number(revenue) || 0, usdJpy: Number(rate) }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "保存に失敗しました");
      await load(data.month);
      setSavedMsg("保存しました");
    } catch (e) {
      setSavedMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  const shiftMonth = (delta) => {
    const [y, m] = data.month.split("-").map(Number);
    load(new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7));
  };

  const label = { color: COLORS.strike, opacity: 0.75, fontSize: 12 };
  const input = { borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink, fontSize: 16, minWidth: 0 };

  if (!data) {
    return (
      <div className="space-y-2">
        <div className="text-sm flex items-center gap-2" style={{ color: COLORS.strike, fontWeight: 700 }}>
          <BarChart3 size={16} style={{ color: COLORS.gold }} /> 使用量・コスト
        </div>
        <div style={label}>{error || "読み込み中..."}</div>
      </div>
    );
  }

  const usd = Number(rate) || data.usdJpy;
  const t = data.totals || {};
  const aiJpy = (t.costUsd || 0) * usd;
  const rowJpy = (x) => {
    const a = Number(x.amount ?? x.amountJpy) || 0;
    return x.currency === "USD" ? Math.round(a * (Number(rate) || 0) * 10) / 10 : a;
  };
  const fixedJpy = fixed.reduce((s, x) => s + rowJpy(x), 0);
  const totalJpy = aiJpy + fixedJpy;
  const revenueJpy = Number(revenue) || 0;
  const users = [...data.users].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
  const isCurrent = data.month >= data.currentMonth;

  // ---------- sheet (table) building blocks ----------
  const cell = { padding: "6px 8px", borderTop: "1px solid rgba(224,168,0,0.2)", whiteSpace: "nowrap" };
  const num = { ...cell, textAlign: "right", fontFamily: "'Oswald', sans-serif" };
  // Lighter text via color, not opacity: an opaque background is needed so
  // columns scrolling under the pinned "利用者" cell don't show through.
  const th = { padding: "6px 8px", fontWeight: 500, color: "rgba(255,255,255,0.7)", whiteSpace: "nowrap", textAlign: "right" };
  const stickyBg = "#1B2440"; // solid, so scrolled columns don't show through the pinned one
  const Sheet = ({ title, note, children }) => (
    <div className="space-y-1">
      <div className="text-sm" style={{ color: COLORS.strike, fontWeight: 700 }}>{title}</div>
      <div className="glass-card rounded-xl overflow-x-auto">
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, color: COLORS.strike }}>{children}</table>
      </div>
      {note && <div style={{ ...label, fontSize: 11, lineHeight: 1.6 }}>{note}</div>}
    </div>
  );

  const fixedRows = fixed.filter((x) => String(x.label || "").trim());
  const userRows = users.map((u) => {
    const cost = (u.costUsd || 0) * usd;
    return { ...u, cost, pct: (cost / 1000) * 100, idle: daysSince(u.lastUsedAt) };
  });
  const sumOf = (k) => userRows.reduce((s, u) => s + (Number(u[k]) || 0), 0);
  const counts = [
    ["スコア解析", t.analyzeCount],
    ["チャット相談", t.chatCount],
    ["失敗(通信エラーなど)", t.failCount],
    ["関係ない写真", t.notScoreCount],
    ["読み取り要確認", t.needsFixCount],
    ["自動補正", t.autoCorrectedCount],
    ["手で修正", t.manualEditCount],
  ];
  const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

  // Everything on this screen as a CSV that opens in Excel / Google Sheets.
  // Amounts are plain numbers (no ¥) so the spreadsheet can calculate with them.
  const downloadCsv = () => {
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      ["STRIKE LOG 使用量・コスト", data.month],
      ["為替(1ドル)", usd, "円"],
      [],
      ["■まとめ"],
      ["項目", "金額(円)", "金額(ドル)"],
      ["AI費用", r1(aiJpy), (t.costUsd || 0).toFixed(4)],
      ...fixedRows.map((x) => [`固定費:${x.label}`, r1(rowJpy(x)), x.currency === "USD" ? Number(x.amount ?? 0) : ""]),
      ["固定費 合計", r1(fixedJpy)],
      ["総コスト", r1(totalJpy)],
      ["売上", r1(revenueJpy)],
      ["利益", r1(revenueJpy - totalJpy)],
      [],
      ["■回数"],
      ["項目", "回数"],
      ...counts.map(([k, v]) => [k, v || 0]),
      [],
      ["■ユーザー別"],
      ["登録番号", "名前", "種類", "解析", "チャット", "失敗", "AI費用(円)", "AI費用(ドル)", "1,000円に対する割合(%)", "最終利用"],
      ...userRows.map((u) => [
        u.requestNumber ? formatRequestNumber(u.requestNumber) : "",
        u.name || "",
        u.isAccount ? "アカウント" : "端末",
        u.analyzeCount || 0,
        u.chatCount || 0,
        u.failCount || 0,
        r1(u.cost),
        (u.costUsd || 0).toFixed(4),
        r1(u.pct),
        u.lastUsedAt ? shortDateJST(u.lastUsedAt) : "",
      ]),
      ["合計", "", "", sumOf("analyzeCount"), sumOf("chatCount"), sumOf("failCount"), r1(sumOf("cost")), sumOf("costUsd").toFixed(4)],
      [],
      ["■月ごとの推移"],
      ["月", "AI費用(円)", "固定費(円)", "総コスト(円)", "売上(円)", "利益(円)", "解析", "チャット"],
      ...data.history.map((h) => {
        const ai = h.aiCostUsd * usd;
        const total = ai + h.fixedCostJpy;
        return [h.month, r1(ai), r1(h.fixedCostJpy), r1(total), r1(h.revenueJpy), r1(h.revenueJpy - total), h.analyzeCount || 0, h.chatCount || 0];
      }),
    ];
    const text = rows.map((r) => r.map(esc).join(",")).join("\r\n");
    // Leading BOM so Excel reads the Japanese correctly.
    const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `strike-log-usage-${data.month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm flex items-center gap-2" style={{ color: COLORS.strike, fontWeight: 700 }}>
          <BarChart3 size={16} style={{ color: COLORS.gold }} /> 使用量・コスト
        </div>
        <div className="flex items-center gap-2" style={{ color: COLORS.strike }}>
          <button type="button" onClick={() => shiftMonth(-1)} disabled={loading} className="px-2 text-lg" aria-label="前の月">‹</button>
          <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}>{data.month.replace("-", "年")}月</span>
          <button type="button" onClick={() => shiftMonth(1)} disabled={loading || isCurrent} className="px-2 text-lg" style={{ opacity: isCurrent ? 0.3 : 1 }} aria-label="次の月">›</button>
        </div>
      </div>
      <button
        type="button"
        onClick={downloadCsv}
        className="w-full rounded-lg py-2 text-sm flex items-center justify-center gap-2"
        style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.strike, fontWeight: 700 }}
      >
        <Download size={15} /> CSVで保存(Excel・スプレッドシート)
      </button>

      <Sheet title="今月のまとめ" note={`為替 1ドル=${usd}円で換算。AI費用は月に1回、Anthropicの管理画面の請求額と見比べてください。`}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>項目</th>
            <th style={th}>金額</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={cell}>AI費用(自動記録)</td>
            <td style={num}>
              {yen(aiJpy)} <span style={{ opacity: 0.6, fontSize: 11 }}>(${(t.costUsd || 0).toFixed(2)})</span>
            </td>
          </tr>
          {fixedRows.map((x, i) => (
            <tr key={i}>
              <td style={{ ...cell, paddingLeft: 18, opacity: 0.85 }}>
                {x.label}
                {x.currency === "USD" ? ` ($${Number(x.amount || 0)})` : ""}
              </td>
              <td style={{ ...num, opacity: 0.85 }}>{yen(rowJpy(x))}</td>
            </tr>
          ))}
          <tr>
            <td style={cell}>固定費 合計</td>
            <td style={num}>{yen(fixedJpy)}</td>
          </tr>
          <tr style={{ fontWeight: 700 }}>
            <td style={cell}>総コスト</td>
            <td style={{ ...num, color: COLORS.gold }}>{yen(totalJpy)}</td>
          </tr>
          <tr>
            <td style={cell}>売上</td>
            <td style={num}>{yen(revenueJpy)}</td>
          </tr>
          <tr style={{ fontWeight: 700 }}>
            <td style={cell}>利益(売上 − 総コスト)</td>
            <td style={{ ...num, color: revenueJpy - totalJpy < 0 ? "#E8836A" : COLORS.gold }}>{yen(revenueJpy - totalJpy)}</td>
          </tr>
        </tbody>
      </Sheet>

      <Sheet title="回数">
        <tbody>
          {counts.map(([k, v], i) => (
            <tr key={k}>
              <td style={{ ...cell, borderTop: i ? cell.borderTop : "none" }}>{k}</td>
              <td style={{ ...num, borderTop: i ? cell.borderTop : "none" }}>{v || 0}回</td>
            </tr>
          ))}
        </tbody>
      </Sheet>

      <Sheet
        title={`ユーザー別(${userRows.length}人・AI費用の多い順)`}
        note={
          (userRows.length ? "表は横にスクロールできます。「割合」は月額1,000円に対するAI費用の割合です。" : "") +
          (t.unidentifiedCount > 0 ? ` 利用者を特定できなかった呼び出し:${t.unidentifiedCount}回(まとめの合計には含まれています)` : "")
        }
      >
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left", position: "sticky", left: 0, background: stickyBg, zIndex: 1 }}>利用者</th>
            <th style={th}>解析</th>
            <th style={th}>チャット</th>
            <th style={th}>失敗</th>
            <th style={th}>AI費用</th>
            <th style={th}>割合</th>
            <th style={th}>最終利用</th>
          </tr>
        </thead>
        <tbody>
          {userRows.length === 0 && (
            <tr>
              <td style={{ ...cell, opacity: 0.7 }} colSpan={7}>この月の利用はありません</td>
            </tr>
          )}
          {userRows.map((u) => (
            <tr key={u.key}>
              <td style={{ ...cell, position: "sticky", left: 0, background: stickyBg, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>
                <div style={{ fontFamily: "'Oswald', sans-serif", opacity: 0.8, fontSize: 11 }}>
                  {u.requestNumber ? formatRequestNumber(u.requestNumber) : "—"}
                  {u.isAccount ? " ・アカウント" : ""}
                </div>
                <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{u.name || "(名前なし)"}</div>
              </td>
              <td style={num}>{u.analyzeCount || 0}</td>
              <td style={num}>{u.chatCount || 0}</td>
              <td style={num}>{u.failCount || 0}</td>
              <td style={num}>{yen(u.cost)}</td>
              <td style={num}>{r1(u.pct).toFixed(1)}%</td>
              <td style={{ ...num, color: u.idle >= 30 ? "#E8836A" : COLORS.strike }}>
                {shortDateJST(u.lastUsedAt)}
                {u.idle >= 30 && u.idle !== Infinity ? `(${u.idle}日前)` : ""}
              </td>
            </tr>
          ))}
          {userRows.length > 0 && (
            <tr style={{ fontWeight: 700 }}>
              <td style={{ ...cell, position: "sticky", left: 0, background: stickyBg }}>合計</td>
              <td style={num}>{sumOf("analyzeCount")}</td>
              <td style={num}>{sumOf("chatCount")}</td>
              <td style={num}>{sumOf("failCount")}</td>
              <td style={num}>{yen(sumOf("cost"))}</td>
              <td style={num}></td>
              <td style={num}></td>
            </tr>
          )}
        </tbody>
      </Sheet>

      <Sheet title="月ごとの推移(直近6か月)">
        <thead>
          <tr>
            {["月", "AI", "固定費", "総コスト", "売上", "利益"].map((h) => (
              <th key={h} style={{ ...th, textAlign: h === "月" ? "left" : "right" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.history.map((h) => {
            const ai = h.aiCostUsd * usd;
            const total = ai + h.fixedCostJpy;
            return (
              <tr key={h.month} style={{ fontWeight: h.month === data.month ? 700 : 400 }}>
                <td style={cell}>{Number(h.month.slice(5))}月</td>
                <td style={num}>{yen(ai)}</td>
                <td style={num}>{yen(h.fixedCostJpy)}</td>
                <td style={num}>{yen(total)}</td>
                <td style={num}>{yen(h.revenueJpy)}</td>
                <td style={{ ...num, color: h.revenueJpy - total < 0 ? "#E8836A" : COLORS.strike }}>{yen(h.revenueJpy - total)}</td>
              </tr>
            );
          })}
        </tbody>
      </Sheet>

      <div className="text-sm" style={{ color: COLORS.strike, fontWeight: 700 }}>固定費・売上の入力</div>
      <div className="glass-card rounded-xl p-3 space-y-2">
        {data.fixedCostsFrom && data.fixedCostsFrom !== data.month && (
          <div style={{ ...label, lineHeight: 1.6 }}>
            {Number(data.fixedCostsFrom.slice(5))}月の固定費を自動で引き継いでいます。変更する場合は編集して保存してください。
          </div>
        )}
        {fixed.map((row, i) => {
          const isUsd = row.currency === "USD";
          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  value={row.label}
                  onChange={(e) => setFixed((f) => f.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  placeholder="項目(例: Vercel)"
                  className="flex-1 px-2 py-1.5 rounded border"
                  style={{ ...input, minWidth: 0 }}
                />
                <button
                  type="button"
                  onClick={() => setFixed((f) => f.map((x, j) => (j === i ? { ...x, currency: isUsd ? "JPY" : "USD" } : x)))}
                  aria-label="円とドルを切り替え"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: COLORS.oak, color: COLORS.strike, fontWeight: 700, minWidth: 34, flexShrink: 0 }}
                >
                  {isUsd ? "$" : "¥"}
                </button>
                <input
                  value={row.amount ?? row.amountJpy ?? ""}
                  onChange={(e) =>
                    setFixed((f) =>
                      f.map((x, j) =>
                        j === i ? { ...x, amount: e.target.value.replace(isUsd ? /[^\d.]/g : /[^\d]/g, ""), amountJpy: undefined } : x
                      )
                    )
                  }
                  placeholder={isUsd ? "ドル" : "円"}
                  inputMode={isUsd ? "decimal" : "numeric"}
                  className="px-2 py-1.5 rounded border"
                  style={{ ...input, width: 80, flexShrink: 0 }}
                />
                <button type="button" onClick={() => setFixed((f) => f.filter((_, j) => j !== i))} aria-label="削除" style={{ flexShrink: 0 }}>
                  <X size={16} style={{ color: COLORS.strike }} />
                </button>
              </div>
              {isUsd && (
                <div style={{ ...label, textAlign: "right", paddingRight: 24 }}>= {yen(rowJpy(row))}(1ドル {rate}円)</div>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setFixed((f) => [...f, { label: "", amount: "", currency: "JPY" }])}
          className="w-full rounded-lg py-2 text-sm"
          style={{ border: `1px dashed ${COLORS.oak}`, color: COLORS.strike }}
        >
          + 固定費を追加
        </button>
        <div className="flex items-center gap-2">
          <span style={{ ...label, flexShrink: 0 }}>この月の売上</span>
          <input value={revenue} onChange={(e) => setRevenue(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="0" className="flex-1 px-2 py-1.5 rounded border" style={input} />
          <span style={label}>円</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ ...label, flexShrink: 0 }}>為替 1ドル =</span>
          <input value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="px-2 py-1.5 rounded border" style={{ ...input, width: 80 }} />
          <span style={label}>円(全月共通)</span>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="w-full rounded-lg py-2.5"
          style={{ background: COLORS.gold, color: COLORS.ink, fontWeight: 700 }}
        >
          {saving ? "保存中..." : "保存する"}
        </button>
        {savedMsg && <div style={{ ...label, textAlign: "center" }}>{savedMsg}</div>}
      </div>

    </div>
  );
}

function AdminAnnouncements({ password }) {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(EMPTY_ANN_FORM);
  // image: undefined = keep existing, null = remove, {base64, previewUrl...} = new
  const [image, setImage] = useState(undefined);
  const [existingImageUrl, setExistingImageUrl] = useState(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const call = async (payload) => {
    const res = await fetch("/api/announcements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "エラーが発生しました");
    return data;
  };

  const load = async () => {
    try {
      const data = await call({ action: "list" });
      setItems(data.items || []);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setForm(EMPTY_ANN_FORM);
    setImage(undefined);
    setExistingImageUrl(null);
    setShowPreview(false);
    setError("");
  };

  const startEdit = (a) => {
    setForm({
      id: a.id,
      type: a.type,
      title: a.title || "",
      body: a.body || "",
      startDate: a.startDate || "",
      endDate: a.endDate || "",
    });
    setImage(undefined);
    setExistingImageUrl(a.hasImage ? announcementImageUrl(a) : null);
    setShowPreview(false);
    setError("");
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onPickImage = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setImageBusy(true);
    setError("");
    try {
      setImage(await compressAnnouncementImage(file));
    } catch (err) {
      setError(err.message);
    } finally {
      setImageBusy(false);
    }
  };

  const previewImageSrc = image ? image.previewUrl : image === null ? null : existingImageUrl;
  const previewItem = { ...form, id: "preview", hasImage: !!previewImageSrc, startDate: form.startDate || null, endDate: form.endDate || null };

  const save = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await call({
        action: "save",
        id: form.id || undefined,
        type: form.type,
        title: form.title,
        body: form.body,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        image: image ? { base64: image.base64, mediaType: image.mediaType } : image,
      });
      setNotice(form.id ? "お知らせを更新しました" : "お知らせを投稿しました");
      resetForm();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    try {
      await call({ action: "delete", id });
      setConfirmDeleteId(null);
      if (form.id === id) resetForm();
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const statusOf = (a) =>
    a.startDate && a.startDate > today ? "予約" : a.endDate && a.endDate < today ? "終了" : "掲載中";

  const inputStyle = { borderColor: COLORS.oak, color: COLORS.ink, background: COLORS.cream, fontSize: 16 };
  const label = (t) => <div className="text-xs mb-1" style={{ color: COLORS.strike }}>{t}</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Bell size={18} style={{ color: COLORS.gold }} />
        <div className="text-sm" style={{ color: COLORS.strike, fontWeight: 700 }}>
          お知らせ{form.id ? "の編集" : "の投稿"}
        </div>
      </div>

      <div className="rounded-xl p-4 glass-card space-y-3">
        <div className="flex gap-2">
          {[
            { key: "update", label: "アップデート(ベルのみ)" },
            { key: "event", label: "イベント(起動時に表示)" },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setForm((f) => ({ ...f, type: opt.key }))}
              className="flex-1 rounded-lg py-2 text-xs"
              style={toggleStyle(form.type === opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div>
          {label("タイトル(60文字まで)")}
          <input
            type="text"
            value={form.title}
            maxLength={60}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            className="w-full px-3 py-2 rounded border"
            style={inputStyle}
          />
        </div>

        <div>
          {label("本文(任意)")}
          <textarea
            value={form.body}
            maxLength={1000}
            rows={4}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            className="w-full px-3 py-2 rounded border"
            style={inputStyle}
          />
        </div>

        <div className="flex gap-2">
          <div className="flex-1" style={{ minWidth: 0 }}>
            {label("開始日(空欄=すぐ)")}
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              className="w-full px-2 py-2 rounded border"
              style={{ ...inputStyle, minWidth: 0 }}
            />
          </div>
          <div className="flex-1" style={{ minWidth: 0 }}>
            {label(form.type === "event" ? "終了日(応募締切など)※必須" : "終了日(空欄=ずっと)")}
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
              className="w-full px-2 py-2 rounded border"
              style={{ ...inputStyle, minWidth: 0 }}
            />
          </div>
        </div>

        <div>
          {label(form.type === "event" ? "画像(起動時の表示に使います)" : "画像(任意)")}
          <div className="flex items-center gap-2 flex-wrap">
            <label
              className="rounded-lg px-3 py-2 text-xs flex items-center gap-1"
              style={{ border: `1px dashed ${COLORS.oak}`, color: COLORS.strike, cursor: "pointer" }}
            >
              <ImagePlus size={14} /> {previewImageSrc ? "画像を変更" : "画像を選ぶ"}
              <input type="file" accept="image/*" onChange={onPickImage} style={{ display: "none" }} />
            </label>
            {previewImageSrc && (
              <button
                type="button"
                onClick={() => setImage(null)}
                className="rounded-lg px-3 py-2 text-xs"
                style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.strike }}
              >
                画像を外す
              </button>
            )}
            {imageBusy && <span className="text-xs" style={{ color: COLORS.strike }}>圧縮中...</span>}
            {image && (
              <span className="text-xs" style={{ color: COLORS.strike, opacity: 0.75 }}>
                {image.width}×{image.height} / 約{Math.round((image.base64.length * 0.75) / 1024)}KB
              </span>
            )}
          </div>
          {previewImageSrc && (
            <img src={previewImageSrc} alt="" style={{ marginTop: 8, maxHeight: 140, borderRadius: 8, display: "block" }} />
          )}
          {form.type === "event" && !previewImageSrc && (
            <div className="text-xs mt-1" style={{ color: COLORS.gold }}>
              画像がないイベントは、起動時には表示されずベルのみに表示されます
            </div>
          )}
        </div>

        {error && <div className="text-xs" style={{ color: "#E8836A", fontWeight: 700 }}>{error}</div>}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            disabled={!form.title.trim()}
            className="flex-1 rounded-lg py-2 text-sm"
            style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.cream, fontWeight: 700, opacity: form.title.trim() ? 1 : 0.5 }}
          >
            {showPreview ? "プレビューを閉じる" : "プレビュー"}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || imageBusy || !form.title.trim()}
            className="flex-1 rounded-lg py-2 text-sm"
            style={{ background: COLORS.gold, color: COLORS.ink, fontWeight: 700, opacity: saving || !form.title.trim() ? 0.6 : 1 }}
          >
            {saving ? "保存中..." : form.id ? "更新する" : "投稿する"}
          </button>
        </div>
        {form.id && (
          <button type="button" onClick={resetForm} className="w-full text-xs underline" style={{ color: COLORS.strike }}>
            編集をやめて新規作成に戻る
          </button>
        )}
      </div>

      {showPreview && (
        <div className="space-y-3">
          <div className="text-xs" style={{ color: COLORS.strike }}>プレビュー:ベルのお知らせ一覧</div>
          <AnnouncementCard a={previewItem} imageSrc={previewImageSrc} />
          {form.type === "event" && previewImageSrc && (
            <>
              <div className="text-xs" style={{ color: COLORS.strike }}>プレビュー:起動時の表示</div>
              <div className="rounded-2xl p-4" style={{ background: "rgba(8, 12, 26, 0.78)", display: "flex", justifyContent: "center" }}>
                <div className="glass-card rounded-2xl w-full" style={{ maxWidth: 360, padding: 14 }}>
                  <img src={previewImageSrc} alt="" style={{ width: "100%", maxHeight: 380, objectFit: "contain", borderRadius: 10, display: "block" }} />
                  <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 16, marginTop: 12 }}>{form.title}</div>
                  {form.endDate && (
                    <div style={{ color: COLORS.gold, fontSize: 13, fontWeight: 700, marginTop: 4 }}>{formatMonthDay(form.endDate)}まで</div>
                  )}
                  <div style={{ color: COLORS.strike, fontSize: 14, marginTop: 14 }}>☐ 今後この通知を表示しない</div>
                  <div className="rounded-lg text-center" style={{ marginTop: 12, padding: "12px 0", background: COLORS.strike, color: COLORS.ink, fontWeight: 700 }}>
                    閉じる
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {notice && <div className="text-sm" style={{ color: COLORS.gold, fontWeight: 700 }}>{notice}</div>}

      <div className="text-sm" style={{ color: COLORS.strike, fontWeight: 700 }}>投稿済みのお知らせ ({items.length})</div>
      <div className="space-y-2">
        {items.length === 0 && <div className="text-xs" style={{ color: COLORS.strike }}>まだありません</div>}
        {items.map((a) => (
          <div key={a.id} className="rounded-xl p-3 glass-card space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div style={{ minWidth: 0 }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "1px 7px",
                      borderRadius: 999,
                      background: statusOf(a) === "掲載中" ? COLORS.gold : "rgba(255,255,255,0.14)",
                      color: statusOf(a) === "掲載中" ? COLORS.ink : COLORS.strike,
                    }}
                  >
                    {statusOf(a)}
                  </span>
                  <span className="text-xs" style={{ color: COLORS.strike, opacity: 0.75 }}>
                    {ANNOUNCEMENT_TYPE_LABEL[a.type]}
                    {a.startDate || a.endDate
                      ? `・${a.startDate ? formatMonthDay(a.startDate) : ""}〜${a.endDate ? formatMonthDay(a.endDate) : ""}`
                      : ""}
                    {a.hasImage ? "・画像あり" : ""}
                  </span>
                </div>
                <div style={{ color: COLORS.cream, fontWeight: 700, marginTop: 4, overflowWrap: "anywhere" }}>{a.title}</div>
              </div>
              <div className="flex items-center gap-3" style={{ flexShrink: 0 }}>
                <button type="button" onClick={() => startEdit(a)} aria-label="編集">
                  <Pencil size={16} style={{ color: COLORS.strike }} />
                </button>
                <button type="button" onClick={() => setConfirmDeleteId(a.id)} aria-label="削除">
                  <Trash2 size={16} style={{ color: COLORS.strike }} />
                </button>
              </div>
            </div>
            {confirmDeleteId === a.id && (
              <div className="flex items-center justify-between rounded-lg p-2" style={{ background: "rgba(192,57,43,0.18)" }}>
                <span className="text-xs" style={{ color: COLORS.strike }}>このお知らせを削除しますか?</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-xs rounded px-2 py-1" style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.strike }}>
                    やめる
                  </button>
                  <button type="button" onClick={() => remove(a.id)} className="text-xs rounded px-2 py-1" style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}>
                    削除する
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminPanel() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [requests, setRequests] = useState([]);
  const [feedbackList, setFeedbackList] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmDeleteFeedbackId, setConfirmDeleteFeedbackId] = useState(null);
  const [serviceAlerts, setServiceAlerts] = useState([]); // AI credits ran out / API key broken
  const [feedbackOpen, setFeedbackOpen] = useState(false); // 改善要望 group, closed by default
  const [handledOpen, setHandledOpen] = useState(false); // 対応済み sub-list, closed by default
  const [confirmDeleteRequestId, setConfirmDeleteRequestId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const load = async (pw) => {
    setLoading(true);
    setError("");
    try {
      const [rReq, rFb] = await Promise.all([
        fetch(`/api/admin/requests?password=${encodeURIComponent(pw)}`),
        fetch(`/api/admin/feedback?password=${encodeURIComponent(pw)}`),
      ]);
      if (!rReq.ok || !rFb.ok) throw new Error("auth failed");
      const reqData = await rReq.json();
      const fbData = await rFb.json();
      setRequests(reqData.items || []);
      setServiceAlerts(reqData.alerts || []);
      setFeedbackList(fbData.items || []);
      setAuthed(true);
    } catch (e) {
      setError("パスワードが違うか、読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (deviceId, status) => {
    await fetch("/api/admin/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, deviceId, status }),
    });
    load(password);
  };

  const deleteRequest = async (deviceId) => {
    await fetch("/api/admin/requests", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, deviceId }),
    });
    setConfirmDeleteRequestId(null);
    load(password);
  };

  const updateFeedbackStatus = async (id, status) => {
    await fetch("/api/admin/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, id, status }),
    });
    load(password);
  };

  const deleteFeedback = async (id) => {
    await fetch("/api/admin/feedback", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, id }),
    });
    setConfirmDeleteFeedbackId(null);
    load(password);
  };

  if (!authed) {
    return (
      <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 320, width: "100%" }} className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={22} style={{ color: COLORS.gold }} />
            <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, color: COLORS.cream }}>管理者ログイン</div>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="管理者パスワード"
            className="w-full px-3 py-2 rounded border text-sm"
            style={{ borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink }}
          />
          {error && <div style={{ color: "#E8836A", fontSize: 14 }}>{error}</div>}
          <button
            onClick={() => load(password)}
            disabled={loading}
            className="w-full rounded-lg py-2"
            style={{ background: COLORS.gold, color: COLORS.cream, fontWeight: 700 }}
          >
            {loading ? "確認中..." : "ログイン"}
          </button>
        </div>
      </div>
    );
  }

  const filteredRequests = searchQuery.trim()
    ? requests.filter((r) => {
        const q = searchQuery.trim().toLowerCase();
        return (
          (r.name || "").toLowerCase().includes(q) ||
          String(r.requestNumber || "").includes(q) ||
          formatRequestNumber(r.requestNumber).includes(q) ||
          `no.${r.requestNumber || ""}`.toLowerCase().includes(q)
        );
      })
    : requests;
  const pending = filteredRequests.filter((r) => r.status === "pending");
  const approved = filteredRequests.filter((r) => r.status === "approved");
  const rejected = filteredRequests.filter((r) => r.status === "rejected");
  const unhandledFeedback = feedbackList.filter((f) => f.status !== "handled");
  const handledFeedback = feedbackList.filter((f) => f.status === "handled");

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, padding: 16 }}>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <ShieldCheck size={24} style={{ color: COLORS.gold }} />
          <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream }}>管理画面</div>
        </div>

        {serviceAlerts.map((a) => (
          <div key={a.kind} className="rounded-xl p-4 space-y-2" style={{ background: "#FBEAE5", border: `2px solid ${COLORS.danger}` }}>
            <div style={{ color: COLORS.danger, fontWeight: 700, fontSize: 15 }}>
              {a.kind === "credit" ? "⚠ AIのクレジット残高が不足しています" : "⚠ AIのAPIキーに問題があります"}
            </div>
            <div style={{ color: COLORS.ink, fontSize: 13, lineHeight: 1.7 }}>
              {a.kind === "credit"
                ? "スコア解析とチャット相談が止まっています。Claude Console の「Plans & Billing」でクレジットを購入してください。"
                : "スコア解析とチャット相談が止まっています。Vercelの環境変数 ANTHROPIC_API_KEY が正しいか確認してください。"}
              <br />
              最終発生:{new Date(a.lastAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              (これまでに{a.count}回)
            </div>
            <button
              type="button"
              onClick={async () => {
                await fetch("/api/admin/requests", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password, action: "ackAlerts" }),
                });
                load(password);
              }}
              className="rounded-lg px-4 py-2 text-sm"
              style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}
            >
              対応した(この警告を消す)
            </button>
          </div>
        ))}

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="番号(例: 3)または名前で登録者を検索"
          className="w-full px-3 py-2 rounded border text-sm"
          style={{ borderColor: COLORS.oak, color: COLORS.ink, background: COLORS.cream }}
        />

        <div>
          <div className="text-sm mb-2" style={{ color: COLORS.strike, fontWeight: 700 }}>
            承認待ち ({pending.length})
          </div>
          <div className="space-y-2">
            {pending.length === 0 && <div className="text-xs" style={{ color: COLORS.strike }}>承認待ちの申請はありません</div>}
            {pending.map((r) => (
              <div key={r.id} className="rounded-xl p-3 border glass-card flex items-center justify-between" style={{ borderColor: COLORS.oak }}>
                <div>
                  <div style={{ color: COLORS.cream, fontWeight: 700 }}>
                    <span style={{ color: COLORS.strike }}>No.{formatRequestNumber(r.requestNumber)}</span> {r.name}
                  </div>
                  <div style={{ color: COLORS.strike, fontSize: 13 }}>{r.requestedAt}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => updateStatus(r.id, "approved")}
                    className="rounded px-3 py-1 text-xs"
                    style={{ background: COLORS.gold, color: "white", fontWeight: 700 }}
                  >
                    承認
                  </button>
                  <button
                    onClick={() => updateStatus(r.id, "rejected")}
                    className="rounded px-3 py-1 text-xs"
                    style={{ background: COLORS.strike, color: COLORS.ink, fontWeight: 700 }}
                  >
                    却下
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-sm mb-2" style={{ color: COLORS.strike, fontWeight: 700 }}>
            承認済み ({approved.length})
          </div>
          <div className="space-y-2">
            {approved.length === 0 && <div className="text-xs" style={{ color: COLORS.strike }}>承認済みの申請はありません</div>}
            {approved.map((r) => (
              <div key={r.id} className="rounded-xl p-3 border glass-card flex items-center justify-between" style={{ borderColor: COLORS.oak }}>
                <div>
                  <div style={{ color: COLORS.cream, fontWeight: 700 }}>
                    <span style={{ color: COLORS.strike }}>No.{formatRequestNumber(r.requestNumber)}</span> {r.name}
                  </div>
                  <div style={{ color: COLORS.strike, fontSize: 13 }}>承認済み ・ {r.updatedAt}</div>
                </div>
                <button
                  onClick={() => updateStatus(r.id, "rejected")}
                  className="rounded px-3 py-1 text-xs"
                  style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.cream, fontWeight: 700 }}
                >
                  却下に変更
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-sm mb-2" style={{ color: COLORS.strike, fontWeight: 700 }}>
            却下 ({rejected.length})
          </div>
          <div className="space-y-2">
            {rejected.length === 0 && <div className="text-xs" style={{ color: COLORS.strike }}>却下した申請はありません</div>}
            {rejected.map((r) => (
              <div key={r.id} className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                <div className="flex items-center justify-between">
                  <div>
                    <div style={{ color: COLORS.cream, fontWeight: 700 }}>
                      <span style={{ color: COLORS.strike }}>No.{formatRequestNumber(r.requestNumber)}</span> {r.name}
                    </div>
                    <div style={{ color: COLORS.strike, fontSize: 13 }}>却下 ・ {r.updatedAt}</div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateStatus(r.id, "approved")}
                      className="rounded px-3 py-1 text-xs"
                      style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.cream, fontWeight: 700 }}
                    >
                      承認に変更
                    </button>
                    <button
                      onClick={() => setConfirmDeleteRequestId(r.id)}
                      className="rounded px-2 py-1"
                      style={{ border: `1px solid ${COLORS.oak}` }}
                      aria-label="削除"
                    >
                      <Trash2 size={14} style={{ color: COLORS.strike }} />
                    </button>
                  </div>
                </div>
                {confirmDeleteRequestId === r.id && (
                  <div className="mt-2 rounded-lg p-2 flex items-center justify-between" style={{ background: "#FBEAE5" }}>
                    <span className="text-xs" style={{ color: COLORS.danger, fontWeight: 700 }}>本当に削除しますか?</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmDeleteRequestId(null)}
                        className="text-xs rounded px-2 py-1 border"
                        style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={() => deleteRequest(r.id)}
                        className="text-xs rounded px-2 py-1"
                        style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}
                      >
                        削除する
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card rounded-xl">
          <button
            type="button"
            onClick={() => setFeedbackOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-3"
            aria-expanded={feedbackOpen}
          >
            <span className="text-sm" style={{ color: COLORS.strike, fontWeight: 700 }}>
              改善要望
              <span style={{ fontWeight: 400, opacity: 0.8 }}>
                {" "}(未対応 {unhandledFeedback.length} ・ 対応済み {handledFeedback.length})
              </span>
            </span>
            <ChevronDown
              size={18}
              style={{ color: COLORS.strike, transform: feedbackOpen ? "rotate(180deg)" : "none", transition: "transform .2s", flexShrink: 0 }}
            />
          </button>
          {feedbackOpen && (
        <div className="px-3 pb-3 space-y-4">
        <div>
          <div className="text-sm mb-2" style={{ color: COLORS.strike, fontWeight: 700 }}>
            未対応 ({unhandledFeedback.length})
          </div>
          <div className="space-y-2">
            {unhandledFeedback.length === 0 && <div className="text-xs" style={{ color: COLORS.strike }}>未対応の要望はありません</div>}
            {unhandledFeedback.map((f) => (
              <div key={f.id} className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                <div style={{ color: COLORS.cream, whiteSpace: "pre-wrap" }}>{f.message}</div>
                <div className="flex items-center justify-between mt-2">
                  <div style={{ color: COLORS.strike, fontSize: 13 }}>
                    {f.name || "匿名"} ・ {f.createdAt}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateFeedbackStatus(f.id, "handled")}
                      className="rounded px-3 py-1 text-xs flex items-center gap-1"
                      style={{ background: COLORS.gold, color: "white", fontWeight: 700 }}
                    >
                      <CircleCheck size={12} /> 対応済みにする
                    </button>
                    <button
                      onClick={() => setConfirmDeleteFeedbackId(f.id)}
                      className="rounded px-2 py-1"
                      style={{ border: `1px solid ${COLORS.oak}` }}
                      aria-label="削除"
                    >
                      <Trash2 size={14} style={{ color: COLORS.strike }} />
                    </button>
                  </div>
                </div>
                {confirmDeleteFeedbackId === f.id && (
                  <div className="mt-2 rounded-lg p-2 flex items-center justify-between" style={{ background: "#FBEAE5" }}>
                    <span className="text-xs" style={{ color: COLORS.danger, fontWeight: 700 }}>本当に削除しますか?</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmDeleteFeedbackId(null)}
                        className="text-xs rounded px-2 py-1 border"
                        style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={() => deleteFeedback(f.id)}
                        className="text-xs rounded px-2 py-1"
                        style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}
                      >
                        削除する
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setHandledOpen((o) => !o)}
            className="w-full flex items-center justify-between mb-2"
            aria-expanded={handledOpen}
          >
            <span className="text-sm" style={{ color: COLORS.strike, fontWeight: 700 }}>対応済み ({handledFeedback.length})</span>
            <ChevronDown
              size={16}
              style={{ color: COLORS.strike, transform: handledOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }}
            />
          </button>
          {handledOpen && (
          <div className="space-y-2">
            {handledFeedback.length === 0 && <div className="text-xs" style={{ color: COLORS.strike }}>対応済みの要望はありません</div>}
            {handledFeedback.map((f) => (
              <div key={f.id} className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak, opacity: 0.7 }}>
                <div style={{ color: COLORS.cream, whiteSpace: "pre-wrap" }}>{f.message}</div>
                <div className="flex items-center justify-between mt-2">
                  <div style={{ color: COLORS.strike, fontSize: 13 }}>
                    {f.name || "匿名"} ・ {f.createdAt}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateFeedbackStatus(f.id, "unhandled")}
                      className="rounded px-3 py-1 text-xs"
                      style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.cream, fontWeight: 700 }}
                    >
                      未対応に戻す
                    </button>
                    <button
                      onClick={() => setConfirmDeleteFeedbackId(f.id)}
                      className="rounded px-2 py-1"
                      style={{ border: `1px solid ${COLORS.oak}` }}
                      aria-label="削除"
                    >
                      <Trash2 size={14} style={{ color: COLORS.strike }} />
                    </button>
                  </div>
                </div>
                {confirmDeleteFeedbackId === f.id && (
                  <div className="mt-2 rounded-lg p-2 flex items-center justify-between" style={{ background: "#FBEAE5" }}>
                    <span className="text-xs" style={{ color: COLORS.danger, fontWeight: 700 }}>本当に削除しますか?</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmDeleteFeedbackId(null)}
                        className="text-xs rounded px-2 py-1 border"
                        style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={() => deleteFeedback(f.id)}
                        className="text-xs rounded px-2 py-1"
                        style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}
                      >
                        削除する
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          )}
        </div>
        </div>
          )}
        </div>

        <AdminUsage password={password} />

        <AdminAnnouncements password={password} />
      </div>
    </div>
  );
}

// ---------- legal pages (terms / privacy / tokushoho) ----------
// Publicly viewable (no login/approval needed) so people can read these
// before subscribing. Fill in the bracketed placeholders with real info.
function LegalPage({ page }) {
  const pages = {
    terms: {
      title: "利用規約",
      body: `この利用規約(以下「本規約」)は、下村優斗(以下「運営者」)が提供する「STRIKE LOG」(以下「本サービス」)の利用条件を定めるものです。利用者は、本サービスを利用することで本規約に同意したものとみなされます。

第1条(サービス内容)
本サービスは、ボウリングのスコア記録・統計表示・その他関連機能を提供するアプリケーションです。

第2条(利用登録)
本サービスの利用には、運営者による利用登録の承認、または所定の月額料金の決済が必要です。

第3条(禁止事項)
利用者は以下の行為を行ってはなりません。
・法令または公序良俗に違反する行為
・本サービスの運営を妨害する行為
・他の利用者に迷惑をかける行為
・不正アクセスやシステムの脆弱性を悪用する行為

第4条(料金・支払い)
本サービスの利用料金は月額1,000円(税込)とし、クレジットカード決済による自動継続課金とします。料金は毎月同日に自動的に請求されます。

第5条(解約)
利用者はいつでも解約できます。解約後は次回請求日以降の課金が停止しますが、既にお支払いいただいた分の返金は行いません。

第6条(免責事項)
運営者は、本サービスの内容(AIによる解析結果を含む)の正確性・完全性について保証しません。本サービスの利用により生じた損害について、運営者は故意または重過失がある場合を除き責任を負いません。

第7条(規約の変更)
運営者は、必要に応じて本規約を変更できるものとし、変更後の規約は本サービス上に掲示した時点で効力を生じます。

第8条(準拠法・管轄)
本規約の解釈には日本法を準拠法とし、本サービスに関して紛争が生じた場合には、運営者の所在地を管轄する裁判所を専属的合意管轄とします。

制定日:2026年8月17日`,
    },
    privacy: {
      title: "プライバシーポリシー",
      body: `下村優斗(以下「運営者」)は、「STRIKE LOG」(以下「本サービス」)における利用者の情報の取り扱いについて、以下の通りプライバシーポリシーを定めます。

1. 取得する情報
・お名前(利用申請時にご入力いただく表示名)
・メールアドレス(アカウントを作成された場合)
・端末を識別するための番号(本サービスが端末ごとに発行するもの)
・スコアシートの写真
・記録されたスコア・統計データ、登録されたボール・シューズ等の情報
・サポートチャットでの質問内容
・改善要望として送信された内容
・本サービスの利用状況(スコア解析・サポートチャットの利用回数と日時、読み取り結果の修正の有無など)

2. 利用目的
・本サービスの提供(スコアの自動読み取りなど)のため
・利用申請の承認・本人確認のため
・機種変更時などに、記録を新しい端末へ引き継ぐため
・お問い合わせ・改善要望への対応のため
・利用状況の把握、サービスの品質改善、および公平な利用のための利用量の管理のため

3. AIサービスの利用について
スコア画像の解析とサポートチャットの回答には、Anthropic社のClaude APIを利用しています。解析のためにアップロードされた画像、およびサポートチャットでの質問内容は、処理の目的でAnthropic社のサーバーに送信されます。

4. 外部サービスの利用
本サービスは、データの保存にGoogle Firebaseを、決済処理にStripeを利用しています。それぞれの外部サービスにおける情報の取り扱いは、各社のプライバシーポリシーに準じます。

5. 第三者提供
運営者は、法令に基づく場合を除き、利用者の同意なく個人情報を第三者に提供しません。

6. 情報の管理
運営者は、取得した情報の漏洩・滅失・毀損の防止のため、適切な安全管理措置を講じます。

7. 開示・削除等の請求
利用者は、運営者に対して、自己の個人情報の開示・訂正・削除を請求できます。ご希望の場合は下記お問い合わせ先までご連絡ください。

8. お問い合わせ先
sy.bsk.1209@docomo.ne.jp

制定日:2026年8月17日
改定日:2026年9月26日`,
    },
    tokushoho: {
      title: "特定商取引法に基づく表記",
      body: `販売事業者名:下村優斗

運営統括責任者:下村優斗

所在地:ご請求をいただいた場合、メールにて遅滞なく開示いたします

電話番号:ご請求をいただいた場合、メールにて遅滞なく開示いたします

メールアドレス:sy.bsk.1209@docomo.ne.jp

販売価格:月額1,000円(税込)

商品代金以外の必要料金:インターネット接続に伴う通信費は利用者のご負担となります。

支払方法:クレジットカード決済(Stripe)

支払時期:お申し込み時に初回分を課金し、以後は毎月同日に自動課金されます。

サービス提供時期:決済完了後、即時にご利用いただけます。

返品・返金について:サービスの性質上、返金・返品には対応しておりません。解約はいつでも可能ですが、既にお支払いいただいた分の返金は行いません。

解約方法:アプリ内設定画面、または上記お問い合わせ先までご連絡ください。次回請求日以降の課金が停止します。`,
    },
  };

  const content = pages[page];

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, padding: 24 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');`}</style>
      <div className="max-w-xl mx-auto" style={{ fontFamily: "'Noto Sans JP', sans-serif" }}>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.strike, marginBottom: 4 }}>
          STRIKE LOG
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: COLORS.cream, marginBottom: 16 }}>{content.title}</h1>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.8, color: COLORS.cream }}>{content.body}</div>
      </div>
    </div>
  );
}

// ---------- main app ----------
export default function StrikeLog() {
  const isAdminRoute =
    typeof window !== "undefined" &&
    (window.location.pathname.endsWith("/admin.html") ||
      new URLSearchParams(window.location.search).get("admin") === "1");
  const legalRoute =
    typeof window !== "undefined"
      ? { "/terms": "terms", "/privacy": "privacy", "/tokushoho": "tokushoho" }[window.location.pathname]
      : null;
  const [deviceId] = useState(() => {
    if (typeof window === "undefined") return "";
    let id = localStorage.getItem("device-id");
    if (!id) {
      id = uid() + uid();
      localStorage.setItem("device-id", id);
    }
    return id;
  });
  const [accessStatus, setAccessStatus] = useState("checking");
  const [authUser, setAuthUser] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authErrorMsg, setAuthErrorMsg] = useState("");
  const [justSignedOut, setJustSignedOut] = useState(false);
  const [authReady, setAuthReady] = useState(false); // Firebase has told us whether someone is signed in
  const [syncState, setSyncState] = useState("idle"); // "idle" | "syncing" | "ready" | "failed"
  const syncStateRef = useRef("idle");
  const syncedUidRef = useRef(null);
  const [myRequestNumber, setMyRequestNumber] = useState(null);
  const [requestName, setRequestName] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatViewportHeight, setChatViewportHeight] = useState(null); // shrinks when the keyboard opens
  const [chatMessages, setChatMessages] = useState([]); // [{ role: "user"|"assistant", content }]
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState("");

  // When opened as the admin panel, swap the manifest/icon/title so "Add to
  // Home Screen" gives it its own distinct icon instead of matching the
  // regular STRIKE LOG icon.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (isAdminRoute) {
      document.title = "STRIKE LOG 管理";
      const manifestLink = document.querySelector('link[rel="manifest"]');
      if (manifestLink) manifestLink.setAttribute("href", "/manifest-admin.json");
      const touchIconLink = document.querySelector('link[rel="apple-touch-icon"]');
      if (touchIconLink) touchIconLink.setAttribute("href", "/icons/icon-admin-192.png");
    }
  }, [isAdminRoute]);

  const [tab, setTab] = useState("scan");
  const [games, setGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(true);
  const [storageError, setStorageError] = useState("");

  const [imagePreview, setImagePreview] = useState(null);
  const [imageMeta, setImageMeta] = useState(null); // {base64, mediaType}
  const [cropRect, setCropRect] = useState(null); // user's selection, 0..1 coords
  const [cropEditorOpen, setCropEditorOpen] = useState(false); // full-screen boxing editor
  const [celebration, setCelebration] = useState(null); // achievements to celebrate, or null
  const [saveBlockItems, setSaveBlockItems] = useState(null); // what's still unselected when 記録を保存 is pressed
  const [rolePromptDismissed, setRolePromptDismissed] = useState(false); // 「あとで」 for this session
  const [announcements, setAnnouncements] = useState([]); // active お知らせ, newest first
  const [bellOpen, setBellOpen] = useState(false);
  const [annReadIds, setAnnReadIds] = useState(() => readIdList(ANN_READ_KEY));
  const [eventPopup, setEventPopup] = useState(null);
  const [hideEventChecked, setHideEventChecked] = useState(false);
  const announcementsLoadedRef = useRef(false);
  const eventPopupShownRef = useRef(false); // at most one pop-up per app launch
  const sourceImgRef = useRef(null); // original full-resolution photo
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [pendingResult, setPendingResult] = useState(null);
  const [activeCell, setActiveCell] = useState(null); // { frameIdx, rollIdx } | null
  const [splitPending, setSplitPending] = useState(false);
  const [gameDate, setGameDate] = useState(() => toLocalISODate(new Date()));
  const [gameNumber, setGameNumber] = useState(1);
  const [gameNumberTouched, setGameNumberTouched] = useState(false);
  const [playerName, setPlayerName] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [ballType, setBallType] = useState("house"); // "house" | "own"
  const [ballWeight, setBallWeight] = useState("");
  const [ballThumbless, setBallThumbless] = useState(false);
  const [selectedBallId, setSelectedBallId] = useState(null);
  const [useSecondBall, setUseSecondBall] = useState(false);
  const [ballType2, setBallType2] = useState("house");
  const [ballWeight2, setBallWeight2] = useState("");
  const [ballThumbless2, setBallThumbless2] = useState(false);
  const [selectedBallId2, setSelectedBallId2] = useState(null);
  const [extraBalls, setExtraBalls] = useState([]); // [{ type, id }] for 3rd ball onward
  const [myBalls, setMyBalls] = useState([]); // [{ id, label, weight, thumbless }]
  const [editingBallNameId, setEditingBallNameId] = useState(null);
  const [ballNameDraft, setBallNameDraft] = useState("");
  const [ballRoleDraft, setBallRoleDraft] = useState(null); // role chosen in the ✎ editor
  const [dominantHand, setDominantHand] = useState("right"); // "right" | "left"
  const [goalAverage, setGoalAverage] = useState("");
  const [goalScore, setGoalScore] = useState("");
  const [homeCenter, setHomeCenter] = useState("");
  const [nickname, setNickname] = useState("");
  const [newBallType, setNewBallType] = useState("own"); // "own" | "house"
  const [newBallRole, setNewBallRole] = useState("strike"); // "strike" (1stボール) | "spare"
  const [newBallName, setNewBallName] = useState("");
  const [newBallWeight, setNewBallWeight] = useState("");
  const [newBallThumbless, setNewBallThumbless] = useState(false);
  const [newBallCore, setNewBallCore] = useState(""); // "symmetric" | "asymmetric"
  const [newBallCoverstock, setNewBallCoverstock] = useState(""); // "reactive" | "urethane" | "plastic" | "particle"
  const [newBallMotion, setNewBallMotion] = useState(""); // "straight" | "mild_curve" | "hook" | "backup"
  const [newBallLaneCondition, setNewBallLaneCondition] = useState(""); // "dry" | "medium" | "oily"
  const [profileSaved, setProfileSaved] = useState(false);
  const [shoeType, setShoeType] = useState("rental"); // "rental" | "own"
  const [shoeTouched, setShoeTouched] = useState(false);
  const [ballTouched, setBallTouched] = useState(false); // manual ball change this session — don't auto-fill over it
  const [selectedShoeId, setSelectedShoeId] = useState(null);
  const [myShoes, setMyShoes] = useState([]); // [{ id, type, label }]
  const [editingShoeNameId, setEditingShoeNameId] = useState(null);
  const [shoeNameDraft, setShoeNameDraft] = useState("");
  const [newShoeName, setNewShoeName] = useState("");
  const [periodMode, setPeriodMode] = useState("week"); // "day" | "week" | "month" | "year" | "custom"
  const [yearAnchor, setYearAnchor] = useState(() => new Date().getFullYear()); // 1/1〜12/31
  const [dayAnchor, setDayAnchor] = useState(() => toLocalISODate(new Date()));
  const [weekAnchor, setWeekAnchor] = useState(() => toLocalISODate(new Date()));
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    d.setDate(1);
    return toLocalISODate(d);
  });
  const [customEnd, setCustomEnd] = useState(() => toLocalISODate(new Date()));
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [confirmRetake, setConfirmRetake] = useState(false);
  const [editingGameId, setEditingGameId] = useState(null);
  const [editFrames, setEditFrames] = useState([]);
  const [editActiveCell, setEditActiveCell] = useState(null);
  const [editSplitPending, setEditSplitPending] = useState(false);
  const [editDate, setEditDate] = useState("");
  const [editGameNumber, setEditGameNumber] = useState(1);
  const [editBallType, setEditBallType] = useState("house");
  const [editBallWeight, setEditBallWeight] = useState("");
  const [editBallThumbless, setEditBallThumbless] = useState(false);
  const [editSelectedBallId, setEditSelectedBallId] = useState(null);
  const [editUseSecondBall, setEditUseSecondBall] = useState(false);
  const [editBallType2, setEditBallType2] = useState("house");
  const [editBallWeight2, setEditBallWeight2] = useState("");
  const [editBallThumbless2, setEditBallThumbless2] = useState(false);
  const [editSelectedBallId2, setEditSelectedBallId2] = useState(null);
  const [editExtraBalls, setEditExtraBalls] = useState([]); // [{ type, id }] for 3rd ball onward
  const [editShoeType, setEditShoeType] = useState("rental");
  const [editSelectedShoeId, setEditSelectedShoeId] = useState(null);
  const fileInputRef = useRef(null);

  // Loads everything from the phone's storage into the screens. Runs at
  // startup, and again after an account's cloud records are downloaded.
  const loadAllFromStorage = useCallback(async () => {
    const tasks = [];
    tasks.push((async () => {
      try {
        const res = await storage.get(STORAGE_KEY);
        setGames(res && res.value ? JSON.parse(res.value) : []);
      } catch (e) {
        // key not existing yet is normal on first run
      } finally {
        setLoadingGames(false);
      }
    })());
    tasks.push((async () => {
      try {
        const res = await storage.get(PLAYER_NAME_KEY);
        if (res && res.value) setPlayerName(res.value);
      } catch (e) {
        // no saved name yet, that's fine
      }
    })());
    tasks.push((async () => {
      try {
        const res = await storage.get(BALL_CONFIG_KEY);
        if (res && res.value) {
          const cfg = JSON.parse(res.value);
          if (cfg.ballType) setBallType(cfg.ballType);
          if (cfg.ballWeight) setBallWeight(cfg.ballWeight);
          if (cfg.ballThumbless !== undefined) setBallThumbless(cfg.ballThumbless);
        }
      } catch (e) {
        // no saved ball config yet, that's fine
      }
    })());
    tasks.push((async () => {
      try {
        const res = await storage.get(PROFILE_KEY);
        if (res && res.value) {
          const p = JSON.parse(res.value);
          if (p.dominantHand) setDominantHand(p.dominantHand);
          if (p.goalAverage) setGoalAverage(p.goalAverage);
          if (p.goalScore) setGoalScore(p.goalScore);
          if (p.homeCenter) setHomeCenter(p.homeCenter);
          if (p.nickname) setNickname(p.nickname);
        }
      } catch (e) {
        // no saved profile yet, that's fine
      }
    })());
    tasks.push((async () => {
      try {
        const res = await storage.get(MY_BALLS_KEY);
        setMyBalls(res && res.value ? JSON.parse(res.value) : []);
      } catch (e) {
        // no registered balls yet, that's fine
      }
    })());
    tasks.push((async () => {
      try {
        const res = await storage.get(SHOE_CONFIG_KEY);
        if (res && res.value) {
          const cfg = JSON.parse(res.value);
          if (cfg.shoeType) setShoeType(cfg.shoeType);
        }
      } catch (e) {
        // no saved shoe config yet, that's fine
      }
    })());
    tasks.push((async () => {
      try {
        const res = await storage.get(MY_SHOES_KEY);
        setMyShoes(res && res.value ? JSON.parse(res.value) : []);
      } catch (e) {
        // no registered shoes yet, that's fine
      }
    })());
    await Promise.all(tasks);
  }, []);

  useEffect(() => {
    loadAllFromStorage();
  }, [loadAllFromStorage]);

  // Suggests the next game number for the selected date (existing games for
  // that date + 1), unless the person has manually edited the field for this
  // session — manual edits are never silently overwritten.
  useEffect(() => {
    if (gameNumberTouched) return;
    const sameDay = games.filter((g) => g.date === gameDate).length;
    setGameNumber(sameDay + 1);
  }, [gameDate, games, gameNumberTouched]);

  // For a 2nd+ game on the same day, default the shoe choice to match the
  // first game recorded that day (people usually keep the same shoes for
  // the whole visit) — but never override a manual change in this session.
  useEffect(() => {
    if (shoeTouched) return;
    const sameDayGames = games.filter((g) => g.date === gameDate);
    if (sameDayGames.length > 0 && sameDayGames[0].shoe) {
      setShoeType(sameDayGames[0].shoe.type || "rental");
      setSelectedShoeId(sameDayGames[0].shoe.shoeRegistryId || null);
    }
  }, [gameDate, games, shoeTouched]);

  // For a 2nd+ game on the same day, start with the same balls (all of them —
  // 2nd, 3rd and on included) as the most recent game recorded that day.
  // Reads from saved games, so it still works after closing and reopening the
  // app between games. Never overrides a manual change in this session.
  useEffect(() => {
    if (ballTouched) return;
    const sameDay = games.filter((g) => g.date === gameDate);
    if (sameDay.length === 0) return;
    const last = sameDay.reduce((a, b) =>
      (b.gameNumber || 0) > (a.gameNumber || 0) ||
      ((b.gameNumber || 0) === (a.gameNumber || 0) && (b.createdAt || 0) > (a.createdAt || 0))
        ? b
        : a
    );
    // Saved games keep the ball's name, not its id — find the registered ball by name.
    const idOf = (b) => {
      if (b && b.registryId && myBalls.some((x) => x.id === b.registryId)) return b.registryId;
      if (!b || !b.label) return null;
      const t = b.type || "own";
      return (
        myBalls.find((x) => x.label === b.label && (x.type || "own") === t)?.id ||
        myBalls.find((x) => x.label === b.label)?.id ||
        null
      );
    };
    if (last.ball) {
      setBallType(last.ball.type || "house");
      setSelectedBallId(idOf(last.ball));
    }
    if (last.ball2) {
      setUseSecondBall(true);
      setBallType2(last.ball2.type || "house");
      setSelectedBallId2(idOf(last.ball2));
    } else {
      setUseSecondBall(false);
      setSelectedBallId2(null);
    }
    setExtraBalls((last.extraBalls || []).map((eb) => ({ type: eb.type || "house", id: idOf(eb) })));
  }, [gameDate, games, myBalls, ballTouched]);

  // Device-based access (users without an account). Waits until Firebase has
  // said whether an account is signed in, and ignores a late answer if an
  // account signs in meanwhile — otherwise a slow reply here could overwrite
  // the account's status and wrongly show the "not approved" screen.
  useEffect(() => {
    if (isAdminRoute || !deviceId || !authReady || authUser) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/access/status?deviceId=${encodeURIComponent(deviceId)}`);
        const data = await res.json();
        if (cancelled) return;
        setAccessStatus(data.status || "not_found");
        if (data.requestNumber) setMyRequestNumber(data.requestNumber);
      } catch (e) {
        if (!cancelled) setAccessStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdminRoute, deviceId, authReady, authUser]);

  // Tracks Firebase Auth sign-in state. Logging in/signing up here is what
  // lets someone pick up their account on a new device without waiting on
  // admin approval again — see the claim-device effect below.
  useEffect(() => {
    if (isAdminRoute) return;
    if (!auth) {
      // Account features unavailable (misconfigured keys) — carry on without them.
      setAuthReady(true);
      return;
    }
    // Safety net: never leave the app stuck on "確認中..." if Firebase is slow.
    const fallback = setTimeout(() => setAuthReady(true), 4000);
    const unsub = onAuthStateChanged(auth, (user) => {
      clearTimeout(fallback);
      setAuthUser(user);
      setAuthReady(true);
    });
    return () => {
      clearTimeout(fallback);
      unsub();
    };
  }, [isAdminRoute]);

  // As soon as we have a signed-in account, tell the server this device is
  // now the active one for it. The server stamps activeDeviceId, which the
  // polling effect below uses to notice when a *different* device later
  // takes over the same account.
  useEffect(() => {
    if (isAdminRoute || !authUser || !deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await authUser.getIdToken();
        const res = await fetch("/api/account/claim-device", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ deviceId }),
        });
        const data = await res.json();
        if (cancelled) return;
        setAccessStatus(data.status || "pending");
        if (data.requestNumber) setMyRequestNumber(data.requestNumber);
      } catch (e) {
        if (!cancelled) setAccessStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdminRoute, authUser, deviceId]);

  useEffect(() => {
    syncStateRef.current = syncState;
  }, [syncState]);

  // Another phone logged into this account: stop syncing and sign out here.
  const handleKickedOut = useCallback(async () => {
    stopSync();
    syncedUidRef.current = null;
    setSyncState("idle");
    try {
      await signOut(auth);
    } catch (e) {
      // already signed out
    }
    setJustSignedOut(true);
    setAccessStatus("not_found");
    setMyRequestNumber(null);
  }, []);

  // Downloads the account's cloud records, merges them into this phone,
  // refreshes the screens, and turns on continuous upload of changes.
  const runSync = useCallback(
    async (user) => {
      setSyncState("syncing");
      try {
        await startSync({
          uid: user.uid,
          deviceId,
          getToken: () => user.getIdToken(),
          onInactive: handleKickedOut,
        });
        await loadAllFromStorage();
        syncedUidRef.current = user.uid;
        setSyncState("ready");
        setStorageError("");
      } catch (e) {
        if (e.inactive) return;
        setSyncState("failed");
        setStorageError("記録のクラウド同期に失敗しました。電波の良い場所でアプリを開き直すと、自動で同期されます。");
      }
    },
    [deviceId, handleKickedOut, loadAllFromStorage]
  );

  // Starts syncing as soon as the account is approved — at login, or while
  // the app is open if the admin approves them right then.
  useEffect(() => {
    if (isAdminRoute || !authUser || accessStatus !== "approved") return;
    if (syncState !== "idle" || syncedUidRef.current === authUser.uid) return;
    runSync(authUser);
  }, [isAdminRoute, authUser, accessStatus, syncState, runSync]);

  // While logged into an account, periodically confirms this device is
  // still the one on file. If another device has since logged into the
  // same account, this device gets signed out automatically — enforcing
  // "one account, one active device at a time."
  useEffect(() => {
    if (isAdminRoute || !authUser || !deviceId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const token = await authUser.getIdToken();
        const res = await fetch(`/api/account/device-check?deviceId=${encodeURIComponent(deviceId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!cancelled && data.active === false) {
          await handleKickedOut();
        } else if (!cancelled) {
          setAccessStatus(data.status || "pending");
          if (data.requestNumber) setMyRequestNumber(data.requestNumber);
        }
      } catch (e) {
        // Network hiccup — leave current state alone and try again later.
      }
    };
    check();
    const interval = setInterval(check, 20000);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      check();
      // Back in the app (maybe with signal again): finish any unsent uploads,
      // or retry a login-time sync that failed.
      if (syncStateRef.current === "failed") runSync(authUser);
      else scheduleFlush();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isAdminRoute, authUser, deviceId, handleKickedOut, runSync]);

  const loginWithAccount = async (email, password) => {
    if (!auth) {
      setAuthErrorMsg("現在アカウント機能を利用できません。時間をおいてお試しください");
      return;
    }
    setAuthBusy(true);
    setAuthErrorMsg("");
    setJustSignedOut(false);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      setAuthErrorMsg("メールアドレスまたはパスワードが正しくありません");
    } finally {
      setAuthBusy(false);
    }
  };

  const signupWithAccount = async (email, password) => {
    if (!auth) {
      setAuthErrorMsg("現在アカウント機能を利用できません。時間をおいてお試しください");
      return;
    }
    setAuthBusy(true);
    setAuthErrorMsg("");
    setJustSignedOut(false);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (e) {
      if (e.code === "auth/email-already-in-use") setAuthErrorMsg("このメールアドレスは既に登録されています");
      else if (e.code === "auth/weak-password") setAuthErrorMsg("パスワードは6文字以上にしてください");
      else setAuthErrorMsg("登録に失敗しました。もう一度お試しください");
    } finally {
      setAuthBusy(false);
    }
  };

  const logoutAccount = async () => {
    stopSync();
    syncedUidRef.current = null;
    setSyncState("idle");
    await signOut(auth);
    setAccessStatus("checking");
    setMyRequestNumber(null);
  };

  const requestAccess = async () => {
    const res = await fetch("/api/access/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, name: requestName.trim() }),
    });
    const data = await res.json();
    setAccessStatus(data.status || "pending");
    if (data.requestNumber) setMyRequestNumber(data.requestNumber);
  };

  const submitFeedback = async () => {
    if (!feedbackMessage.trim()) return;
    setFeedbackSubmitting(true);
    try {
      await fetch("/api/feedback/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, name: nickname || playerName, message: feedbackMessage.trim() }),
      });
      setFeedbackMessage("");
      setFeedbackSent(true);
      setTimeout(() => setFeedbackSent(false), 2000);
    } catch (e) {
      // non-fatal; person can just try again
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  // Fetch お知らせ once the user is actually in the app.
  useEffect(() => {
    if (isAdminRoute || accessStatus !== "approved" || announcementsLoadedRef.current) return;
    announcementsLoadedRef.current = true;
    fetch("/api/announcements")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setAnnouncements(Array.isArray(d.items) ? d.items : []))
      .catch(() => {
        // No signal — the app works fine without announcements.
      });
  }, [isAdminRoute, accessStatus]);

  // Show the newest event ad once per launch — only after the records have
  // finished loading and the user is on the score screen, and never on top
  // of the celebration, chat, or bell screens.
  useEffect(() => {
    if (eventPopupShownRef.current || eventPopup) return;
    if (accessStatus !== "approved" || (authUser && syncState === "syncing")) return;
    if (tab !== "scan" || celebration || chatOpen || bellOpen) return;
    const hidden = readIdList(ANN_HIDDEN_KEY);
    const shown = readShownCounts();
    const next = announcements.find(
      (a) => a.type === "event" && a.hasImage && !hidden.includes(a.id) && (shown[a.id] || 0) < EVENT_POPUP_MAX_SHOWS
    );
    if (!next) return;
    eventPopupShownRef.current = true;
    // Count it the moment it appears, so closing the app without tapping
    // 閉じる still uses up one of the two showings. Keep only ids still
    // running, so this never grows without bound.
    const running = new Set(announcements.map((a) => a.id));
    const counts = Object.fromEntries(Object.entries(shown).filter(([id]) => running.has(id)));
    counts[next.id] = (counts[next.id] || 0) + 1;
    localStorage.setItem(ANN_SHOWN_KEY, JSON.stringify(counts));
    setHideEventChecked(false);
    setEventPopup(next);
  }, [announcements, accessStatus, authUser, syncState, tab, celebration, chatOpen, bellOpen, eventPopup]);

  const markAnnouncementsRead = (ids) => {
    const next = Array.from(new Set([...readIdList(ANN_READ_KEY), ...ids]));
    writeIdList(ANN_READ_KEY, next);
    setAnnReadIds(next);
  };

  const closeEventPopup = () => {
    if (!eventPopup) return;
    if (hideEventChecked) writeIdList(ANN_HIDDEN_KEY, [...readIdList(ANN_HIDDEN_KEY), eventPopup.id]);
    markAnnouncementsRead([eventPopup.id]);
    setEventPopup(null);
  };

  const unreadAnnouncements = announcements.filter((a) => !annReadIds.includes(a.id)).length;

  // While the support chat is open, follow the visible area of the screen.
  // On iPhone the on-screen keyboard covers the bottom of the page without
  // resizing it, which would otherwise hide the text box being typed in.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!chatOpen || !vv) {
      setChatViewportHeight(null);
      return;
    }
    const update = () => setChatViewportHeight(vv.height);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [chatOpen]);

  const sendChatMessage = async () => {
    const text = chatInput.trim();
    if (!text || chatSending) return;
    const nextMessages = [...chatMessages, { role: "user", content: text }];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatSending(true);
    setChatError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await usageHeaders()) },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(friendlyAiError(data?.error, "チャット相談"));
      const textBlock = (data.content || []).find((b) => b.type === "text");
      const reply = textBlock?.text?.trim() || "うまく答えられませんでした。もう一度試してください。";
      setChatMessages([...nextMessages, { role: "assistant", content: reply }]);
    } catch (e) {
      // A thrown TypeError here means the request never reached the server.
      // TypeError: never reached the server. SyntaxError: got a non-JSON page back.
      setChatError(
        e instanceof TypeError
          ? friendlyAiError("network", "チャット相談")
          : e instanceof SyntaxError
          ? friendlyAiError("", "チャット相談")
          : e.message || friendlyAiError("", "チャット相談")
      );
    } finally {
      setChatSending(false);
    }
  };

  const savePlayerName = async (name) => {
    setPlayerName(name);
    try {
      await storage.set(PLAYER_NAME_KEY, name);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 1200);
    } catch (e) {
      // non-fatal; name still works for this session
    }
  };

  const saveBallConfig = async (next) => {
    try {
      await storage.set(BALL_CONFIG_KEY, JSON.stringify(next));
    } catch (e) {
      // non-fatal; ball config still works for this session
    }
  };

  const saveProfile = async (patch) => {
    const next = { dominantHand, goalAverage, goalScore, homeCenter, nickname, ...patch };
    try {
      await storage.set(PROFILE_KEY, JSON.stringify(next));
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 1200);
    } catch (e) {
      // non-fatal; profile still works for this session
    }
  };

  const persistMyBalls = async (next) => {
    setMyBalls(next);
    try {
      await storage.set(MY_BALLS_KEY, JSON.stringify(next));
    } catch (e) {
      // non-fatal; balls still work for this session
    }
  };

  const addMyBall = () => {
    if (!newBallWeight) return;
    const typeLabel = newBallType === "house" ? "ハウスボール" : "マイボール";
    const autoLabel = `${typeLabel} ${newBallWeight}lb${newBallThumbless ? "・サムレス" : ""}`;
    const ball = {
      id: uid(),
      type: newBallType,
      role: newBallRole,
      label: newBallName.trim() || autoLabel,
      weight: Number(newBallWeight),
      thumbless: newBallThumbless,
      ...(newBallType === "own"
        ? {
            core: newBallCore || null,
            coverstock: newBallCoverstock || null,
            motion: newBallMotion || null,
            laneCondition: newBallLaneCondition || null,
          }
        : {}),
    };
    persistMyBalls([...myBalls, ball]);
    setNewBallName("");
    setNewBallWeight("");
    setNewBallThumbless(false);
    setNewBallType("own");
    setNewBallRole("strike");
    setNewBallCore("");
    setNewBallCoverstock("");
    setNewBallMotion("");
    setNewBallLaneCondition("");
  };

  // Saves the ✎ editor: new name and role together, in one write. Past games
  // take the new name and are re-ordered for the role (strike ball first).
  const saveBallEdit = (id, newLabel, newRole) => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    const target = myBalls.find((b) => b.id === id);
    if (!target) return;
    const nextBalls = myBalls.map((b) => (b.id === id ? { ...b, label: trimmed, ...(newRole ? { role: newRole } : {}) } : b));
    persistMyBalls(nextBalls);
    const isThisBall = (x) =>
      x &&
      (x.registryId === id ||
        (!x.registryId && x.label === target.label && (x.type || "own") === (target.type || "own")));
    const fix = (x) => (isThisBall(x) ? { ...x, label: trimmed, registryId: id } : x);
    let changed = false;
    const nextGames = games.map((g) => {
      const renamed = {
        ...g,
        ball: fix(g.ball),
        ball2: fix(g.ball2),
        extraBalls: Array.isArray(g.extraBalls) ? g.extraBalls.map(fix) : g.extraBalls,
      };
      const ordered = normalizeBallOrder(renamed, nextBalls);
      const same =
        ordered.ball === g.ball &&
        ordered.ball2 === g.ball2 &&
        (!Array.isArray(g.extraBalls) || ordered.extraBalls.every((x, i) => x === g.extraBalls[i]));
      if (same) return g;
      changed = true;
      return ordered;
    });
    if (changed) persistGames(nextGames);
    setEditingBallNameId(null);
  };

  // Setting / changing a ball's role also puts already-saved games in the
  // right order (strike ball first), so history and stats agree.
  const setMyBallRole = (id, role) => {
    const nextBalls = myBalls.map((b) => (b.id === id ? { ...b, role } : b));
    persistMyBalls(nextBalls);
    let changed = false;
    const nextGames = games.map((g) => {
      const n = normalizeBallOrder(g, nextBalls);
      if (n !== g) changed = true;
      return n;
    });
    if (changed) persistGames(nextGames);
  };

  const deleteMyBall = (id) => {
    persistMyBalls(myBalls.filter((b) => b.id !== id));
    if (selectedBallId === id) setSelectedBallId(null);
  };

  // Renaming a ball also renames it in every saved game (history cards show
  // the name stored with each game), so the new name appears everywhere.
  const renameMyBall = (id, newLabel) => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    const target = myBalls.find((b) => b.id === id);
    if (!target) return;
    persistMyBalls(myBalls.map((b) => (b.id === id ? { ...b, label: trimmed } : b)));
    const isThisBall = (x) =>
      x &&
      (x.registryId === id ||
        (!x.registryId && x.label === target.label && (x.type || "own") === (target.type || "own")));
    const fix = (x) => (isThisBall(x) ? { ...x, label: trimmed, registryId: id } : x);
    let changed = false;
    const next = games.map((g) => {
      const ball = fix(g.ball);
      const ball2 = fix(g.ball2);
      const extra = Array.isArray(g.extraBalls) ? g.extraBalls.map(fix) : g.extraBalls;
      const touched = ball !== g.ball || ball2 !== g.ball2 || (Array.isArray(g.extraBalls) && extra.some((x, i) => x !== g.extraBalls[i]));
      if (!touched) return g;
      changed = true;
      return { ...g, ball, ball2, extraBalls: extra };
    });
    if (changed) persistGames(next);
    setEditingBallNameId(null);
  };

  const saveShoeConfig = async (next) => {
    try {
      await storage.set(SHOE_CONFIG_KEY, JSON.stringify(next));
    } catch (e) {
      // non-fatal; shoe config still works for this session
    }
  };

  const persistMyShoes = async (next) => {
    setMyShoes(next);
    try {
      await storage.set(MY_SHOES_KEY, JSON.stringify(next));
    } catch (e) {
      // non-fatal; shoes still work for this session
    }
  };

  const addMyShoe = () => {
    if (!newShoeName.trim()) return;
    const shoe = {
      id: uid(),
      type: "own",
      label: newShoeName.trim(),
    };
    persistMyShoes([...myShoes, shoe]);
    setNewShoeName("");
  };

  const deleteMyShoe = (id) => {
    persistMyShoes(myShoes.filter((s) => s.id !== id));
    if (selectedShoeId === id) setSelectedShoeId(null);
  };

  // Same for shoes: the new name replaces the old one in every saved game.
  const renameMyShoe = (id, newLabel) => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    const target = myShoes.find((s) => s.id === id);
    if (!target) return;
    persistMyShoes(myShoes.map((s) => (s.id === id ? { ...s, label: trimmed } : s)));
    let changed = false;
    const next = games.map((g) => {
      const sh = g.shoe;
      if (!sh || sh.type !== "own") return g;
      if (sh.shoeRegistryId === id || (!sh.shoeRegistryId && sh.label === target.label)) {
        changed = true;
        return { ...g, shoe: { ...sh, label: trimmed, shoeRegistryId: id } };
      }
      return g;
    });
    if (changed) persistGames(next);
    setEditingShoeNameId(null);
  };

  const persistGames = useCallback(async (next) => {
    setGames(next);
    try {
      const ok = await storage.set(STORAGE_KEY, JSON.stringify(next));
      if (!ok) setStorageError("保存に失敗しました。もう一度お試しください。");
      else setStorageError("");
    } catch (e) {
      setStorageError("保存に失敗しました。もう一度お試しください。");
    }
  }, []);

  // One-time upgrade of older games: they only stored the ball's name. Add
  // the registered ball's id while the names still match, so renaming a ball
  // later never splits its per-ball stats. Runs until nothing is left to add.
  useEffect(() => {
    if (loadingGames || !myBalls.length || !games.length) return;
    let changed = false;
    const fix = (b) => {
      if (!b || b.registryId || !b.label) return b;
      const id = ballRegistryIdFor(b, myBalls);
      if (!id) return b;
      changed = true;
      return { ...b, registryId: id };
    };
    const next = games.map((g) => {
      const ball = fix(g.ball);
      const ball2 = fix(g.ball2);
      const extra = Array.isArray(g.extraBalls) ? g.extraBalls.map(fix) : g.extraBalls;
      const extraChanged = Array.isArray(g.extraBalls) && extra.some((x, i) => x !== g.extraBalls[i]);
      return ball !== g.ball || ball2 !== g.ball2 || extraChanged ? { ...g, ball, ball2, extraBalls: extra } : g;
    });
    if (changed) persistGames(next);
  }, [games, myBalls, loadingGames, persistGames]);


  const handleFile = async (file) => {
    if (!file) return;
    setAnalyzeError("");
    setPendingResult(null);
    setImagePreview(null);
    setImageMeta(null);
    setCropRect(null);
    setActiveCell(null);
    setSplitPending(false);
    try {
      const rawUrl = await readFileAsDataUrl(file);
      setImagePreview(rawUrl);
    } catch (e) {
      // non-fatal: preview is best-effort, processing below still runs
    }
    try {
      const img = await loadImageFromFile(file);
      sourceImgRef.current = img;
      const { base64, mediaType } = renderImageForAI(img, null);
      setImageMeta({ base64, mediaType });
      setImagePreview(`data:${mediaType};base64,${base64}`);
      setCropRect(null);
      setCropEditorOpen(true); // go straight to boxing the row, full screen
    } catch (e) {
      setAnalyzeError(withPhotoTip(e.message));
    }
  };

  const runAnalysis = async () => {
    if (!imageMeta) return;
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      const built = sourceImgRef.current
        ? buildAnalysisImages(sourceImgRef.current, cropRect)
        : { images: [imageMeta], cropped: false, zoomed: false };
      const result = await analyzeScoreImage(built.images, playerName.trim(), built);
      const noScoreFound =
        result.screen_type === "none" || !Array.isArray(result.games) || result.games.length === 0;
      if (result.player_matched === false || noScoreFound) {
        const notScore = result.screen_type === "none" || (noScoreFound && !(result.other_players_detected || []).length);
        setPendingResult({ ...result, player_matched: false, notScore });
        if (notScore) reportAnalysisOutcome({ notScore: 1 });
      } else {
        const rawGames = Array.isArray(result.games) ? result.games : [];
        const normalizedGames = rawGames.map((game) => {
          const framesWithSplitRolls = (game.frames || []).map((f) => {
            const splitRolls = [];
            if (typeof f.split_roll_index === "number") splitRolls[f.split_roll_index] = true;
            return { ...f, splitRolls };
          });
          let norm = normalizeGame(framesWithSplitRolls);
          const ocrTotal = Number(game.total_score);
          const hasOcrTotal = Number.isFinite(ocrTotal);
          // The per-frame cumulative numbers exactly as copied off the screen.
          const ocrScores = (game.frames || []).slice(0, 10).map((f) => Number(f?.score));
          let autoCorrectedFrames = null;
          let issue = findReadIssue(norm.frames, ocrScores, ocrTotal, norm.total);
          if (issue) {
            const target = hasOcrTotal ? ocrTotal : ocrScores[9];
            const fix = reconcileRollsWithReadScores(framesWithSplitRolls, target);
            if (fix?.frames) {
              norm = normalizeGame(fix.frames);
              autoCorrectedFrames = fix.changedFrames;
              issue = findReadIssue(norm.frames, ocrScores, ocrTotal, norm.total);
            } else if (fix?.suspectFrames?.length) {
              issue = { frames: fix.suspectFrames };
            }
          }
          const mismatch = issue;
          return {
            gameLabel: game.game_label || null,
            detectedDate: game.detected_date || null,
            frames: norm.frames,
            total_score: norm.total !== null ? norm.total : hasOcrTotal ? ocrTotal : null,
            ocrTotal: hasOcrTotal ? ocrTotal : null,
            ocrScores,
            totalMismatch: mismatch,
            autoCorrectedFrames,
            analyzedRolls: JSON.stringify(norm.frames.map((f) => f.rolls)),
            confidence_notes: game.confidence_notes || "",
            frame_by_frame_reading: game.frame_by_frame_reading || [],
          };
        });
        const firstDetectedDate = normalizedGames.find((g) => g.detectedDate)?.detectedDate;
        if (firstDetectedDate && /^\d{4}-\d{2}-\d{2}$/.test(firstDetectedDate)) {
          setGameDate(firstDetectedDate);
        }
        setPendingResult({
          player_matched: result.player_matched,
          matched_name_on_screen: result.matched_name_on_screen,
          other_players_detected: result.other_players_detected,
          games: normalizedGames,
        });
        reportAnalysisOutcome({
          needsFix: normalizedGames.filter((g) => g.totalMismatch).length,
          autoCorrected: normalizedGames.filter((g) => g.autoCorrectedFrames?.length).length,
        });
      }
    } catch (e) {
      setAnalyzeError(withPhotoTip(e.message));
    } finally {
      setAnalyzing(false);
    }
  };

  const addExtraBall = () => setExtraBalls((prev) => [...prev, { type: "house", id: null }]);
  const removeExtraBall = (idx) => setExtraBalls((prev) => prev.filter((_, i) => i !== idx));
  const updateExtraBallType = (idx, type) =>
    setExtraBalls((prev) => prev.map((s, i) => (i === idx ? { type, id: null } : s)));
  const updateExtraBallId = (idx, id) =>
    setExtraBalls((prev) => prev.map((s, i) => (i === idx ? { ...s, id } : s)));

  const saveGame = async () => {
    if (!pendingResult || !pendingResult.games?.length) return;
    // Every ball slot and (for マイシューズ) the shoes must be chosen first.
    const missing = [];
    if (!selectedBallId || !myBalls.some((b) => b.id === selectedBallId)) missing.push("1個目のボール");
    if (useSecondBall && (!selectedBallId2 || !myBalls.some((b) => b.id === selectedBallId2))) missing.push("2個目のボール");
    extraBalls.forEach((eb, i) => {
      if (!eb.id || !myBalls.some((b) => b.id === eb.id)) missing.push(`${i + 3}個目のボール`);
    });
    if (shoeType === "own" && (!selectedShoeId || !myShoes.some((s) => s.id === selectedShoeId))) missing.push("シューズ");
    if (missing.length) {
      setSaveBlockItems(missing);
      return;
    }
    const selectedBall = myBalls.find((b) => b.id === selectedBallId);
    const ball = {
      type: ballType,
      weight: selectedBall ? selectedBall.weight : null,
      thumbless: selectedBall ? selectedBall.thumbless : false,
      label: selectedBall ? selectedBall.label : null,
      registryId: selectedBall ? selectedBall.id : null, // survives renaming the ball
    };
    let ball2 = null;
    if (useSecondBall) {
      const selectedBall2 = myBalls.find((b) => b.id === selectedBallId2);
      ball2 = {
        type: ballType2,
        weight: selectedBall2 ? selectedBall2.weight : null,
        thumbless: selectedBall2 ? selectedBall2.thumbless : false,
        label: selectedBall2 ? selectedBall2.label : null,
        registryId: selectedBall2 ? selectedBall2.id : null,
      };
    }
    const extraBallsData = extraBalls
      .filter((sel) => sel.id)
      .map((sel) => {
        const b = myBalls.find((x) => x.id === sel.id);
        return { type: sel.type, weight: b ? b.weight : null, thumbless: b ? b.thumbless : false, label: b ? b.label : null, registryId: b ? b.id : null };
      });
    const selectedShoe = myShoes.find((s) => s.id === selectedShoeId);
    const shoe =
      shoeType === "own"
        ? {
            type: "own",
            label: selectedShoe ? selectedShoe.label : null,
            shoeRegistryId: selectedShoeId || null,
          }
        : { type: "rental", label: null, shoeRegistryId: null };

    // All games detected in the photo share the same ball/shoe/date, and get
    // sequential game numbers starting from the chosen "何ゲーム目" value —
    // matching how one photo of a multi-game screen represents one session.
    const startingGameNumber = Number(gameNumber) || 1;
    const newGames = pendingResult.games.map((g, idx) => ({
      id: uid(),
      date: gameDate,
      gameNumber: startingGameNumber + idx,
      frames: g.frames || [],
      total: g.total_score ?? 0,
      ball,
      ball2,
      extraBalls: extraBallsData,
      shoe,
      createdAt: Date.now() + idx,
    }));
    reportAnalysisOutcome({
      manualEdit: pendingResult.games.filter(
        (g) => g.analyzedRolls && g.analyzedRolls !== JSON.stringify((g.frames || []).map((f) => f.rolls))
      ).length,
    });
    const orderedNewGames = newGames.map((g) => normalizeBallOrder(g, myBalls));
    const next = [...games, ...orderedNewGames].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.gameNumber || 1) - (b.gameNumber || 1)
    );
    const achievements = detectAchievements(games, next, orderedNewGames, { goalAverage, goalScore });
    await persistGames(next);
    await saveBallConfig({ ballType, ballWeight, ballThumbless });
    await saveShoeConfig({ shoeType });
    setShoeTouched(false);
    setBallTouched(false);
    setPendingResult(null);
    setImagePreview(null);
    setImageMeta(null);
    setCropRect(null);
    setActiveCell(null);
    setSplitPending(false);
    setGameNumberTouched(false);
    setTab("history");
    if (achievements.length) setCelebration(achievements);
  };

  // Editing a roll re-runs official scoring across that game, since a
  // single strike/spare change can shift every later cumulative score —
  // exactly like fixing a mistake on a paper scoresheet. isSplit marks that
  // specific roll's pin count as a circled split (any roll can be a split,
  // not just the frame's opening ball — e.g. a 10th-frame bonus ball).
  const updateRollValue = (gameIdx, frameIdx, rollIdx, value, isSplit) => {
    setPendingResult((prev) => {
      const games = prev.games.map((game, gi) => {
        if (gi !== gameIdx) return game;
        const rawFrames = game.frames.map((f, i) => {
          if (i !== frameIdx) return f;
          const nextSplitRolls = [...(f.splitRolls || [])];
          if (isSplit !== undefined) nextSplitRolls[rollIdx] = isSplit;
          return {
            ...f,
            rolls: f.rolls.map((r, j) => (j === rollIdx ? value : r)),
            splitRolls: nextSplitRolls,
          };
        });
        const norm = normalizeGame(rawFrames);
        // Re-check every frame on each manual edit, so the warning (and the
        // frames it names) updates live and clears once everything matches.
        const mismatch = findReadIssue(norm.frames, game.ocrScores, game.ocrTotal ?? NaN, norm.total);
        return {
          ...game,
          frames: norm.frames,
          total_score: norm.total !== null ? norm.total : game.total_score,
          totalMismatch: mismatch,
          autoCorrectedFrames: null,
        };
      });
      return { ...prev, games };
    });
  };

// After picking a value for one roll, figures out which cell the picker
// should jump to next, so editing several frames in a row doesn't require
// re-tapping each cell by hand. Strikes end the frame immediately (no 2nd
// roll to fill in a normal frame); the 10th frame gets up to 3 slots.
function getNextRollCell(frameIdx, rollIdx, value) {
  const isTenth = frameIdx === 9;
  const maxRollIdx = isTenth ? 2 : 1;
  if (rollIdx === 0 && value !== "X" && maxRollIdx >= 1) {
    return { frameIdx, rollIdx: 1 };
  }
  if (isTenth && rollIdx < maxRollIdx) {
    return { frameIdx, rollIdx: rollIdx + 1 };
  }
  if (frameIdx < 9) {
    return { frameIdx: frameIdx + 1, rollIdx: 0 };
  }
  return null; // last roll of the game — nothing left to advance to
}

  // Opens the picker for a given cell, pre-loading the split toggle to match
  // whatever that specific roll's current state already is.
  const handleCellTap = (gameIdx, frameIdx, rollIdx) => {
    setActiveCell({ gameIdx, frameIdx, rollIdx });
    setSplitPending(!!pendingResult?.games?.[gameIdx]?.frames?.[frameIdx]?.splitRolls?.[rollIdx]);
  };

  const handlePickerSelect = (value) => {
    if (!activeCell) return;
    const { gameIdx, frameIdx, rollIdx } = activeCell;
    // A strike can't also be a split (a strike leaves no pins standing), so
    // the split toggle only applies to non-strike selections.
    const isSplit = value !== "X" && splitPending;
    updateRollValue(gameIdx, frameIdx, rollIdx, value, isSplit);
    const next = getNextRollCell(frameIdx, rollIdx, value);
    if (next) {
      setActiveCell({ gameIdx, ...next });
      setSplitPending(false);
    } else {
      setActiveCell(null);
      setSplitPending(false);
    }
  };

  const handlePickerClear = () => {
    if (!activeCell) return;
    updateRollValue(activeCell.gameIdx, activeCell.frameIdx, activeCell.rollIdx, "", false);
  };

  const closePicker = () => {
    setActiveCell(null);
    setSplitPending(false);
  };

  const addEditExtraBall = () => setEditExtraBalls((prev) => [...prev, { type: "house", id: null }]);
  const removeEditExtraBall = (idx) => setEditExtraBalls((prev) => prev.filter((_, i) => i !== idx));
  const updateEditExtraBallType = (idx, type) =>
    setEditExtraBalls((prev) => prev.map((s, i) => (i === idx ? { type, id: null } : s)));
  const updateEditExtraBallId = (idx, id) =>
    setEditExtraBalls((prev) => prev.map((s, i) => (i === idx ? { ...s, id } : s)));

  // ---------- history editing (mirrors the scan-tab editing logic above,
  // but operates on a game already saved in history) ----------
  const startEditGame = (g) => {
    setEditingGameId(g.id);
    setEditFrames(g.frames || []);
    setEditActiveCell(null);
    setEditSplitPending(false);
    setEditDate(g.date);
    setEditGameNumber(g.gameNumber || 1);
    setEditBallType(g.ball?.type || "house");
    setEditBallWeight(g.ball?.weight ? String(g.ball.weight) : "");
    setEditBallThumbless(!!g.ball?.thumbless);
    setEditSelectedBallId(ballRegistryIdFor(g.ball, myBalls));
    setEditUseSecondBall(!!g.ball2);
    setEditBallType2(g.ball2?.type || "house");
    setEditBallWeight2(g.ball2?.weight ? String(g.ball2.weight) : "");
    setEditBallThumbless2(!!g.ball2?.thumbless);
    setEditSelectedBallId2(ballRegistryIdFor(g.ball2, myBalls));
    setEditExtraBalls(
      (g.extraBalls || []).map((eb) => ({
        type: eb.type || "house",
        id: ballRegistryIdFor(eb, myBalls),
      }))
    );
    setEditShoeType(g.shoe?.type || "rental");
    setEditSelectedShoeId(g.shoe?.shoeRegistryId || null);
  };

  const cancelEditGame = () => {
    setEditingGameId(null);
    setEditActiveCell(null);
    setEditSplitPending(false);
  };

  const updateEditRollValue = (frameIdx, rollIdx, value, isSplit) => {
    setEditFrames((prev) => {
      const rawFrames = prev.map((f, i) => {
        if (i !== frameIdx) return f;
        const nextSplitRolls = [...(f.splitRolls || [])];
        if (isSplit !== undefined) nextSplitRolls[rollIdx] = isSplit;
        return {
          ...f,
          rolls: f.rolls.map((r, j) => (j === rollIdx ? value : r)),
          splitRolls: nextSplitRolls,
        };
      });
      const norm = normalizeGame(rawFrames);
      return norm.frames;
    });
  };

  const handleEditCellTap = (frameIdx, rollIdx) => {
    setEditActiveCell({ frameIdx, rollIdx });
    setEditSplitPending(!!editFrames?.[frameIdx]?.splitRolls?.[rollIdx]);
  };

  const handleEditPickerSelect = (value) => {
    if (!editActiveCell) return;
    const { frameIdx, rollIdx } = editActiveCell;
    const isSplit = value !== "X" && editSplitPending;
    updateEditRollValue(frameIdx, rollIdx, value, isSplit);
    const next = getNextRollCell(frameIdx, rollIdx, value);
    if (next) {
      setEditActiveCell(next);
      setEditSplitPending(false);
    } else {
      setEditActiveCell(null);
      setEditSplitPending(false);
    }
  };

  const handleEditPickerClear = () => {
    if (!editActiveCell) return;
    updateEditRollValue(editActiveCell.frameIdx, editActiveCell.rollIdx, "", false);
  };

  const closeEditPicker = () => {
    setEditActiveCell(null);
    setEditSplitPending(false);
  };

  const saveEditedGame = async () => {
    const norm = normalizeGame(editFrames);
    const selectedBall = myBalls.find((b) => b.id === editSelectedBallId);
    const ball = {
      type: editBallType,
      weight: selectedBall ? selectedBall.weight : null,
      thumbless: selectedBall ? selectedBall.thumbless : false,
      label: selectedBall ? selectedBall.label : null,
      registryId: selectedBall ? selectedBall.id : null, // survives renaming the ball
    };
    let ball2 = null;
    if (editUseSecondBall) {
      const selectedBall2 = myBalls.find((b) => b.id === editSelectedBallId2);
      ball2 = {
        type: editBallType2,
        weight: selectedBall2 ? selectedBall2.weight : null,
        thumbless: selectedBall2 ? selectedBall2.thumbless : false,
        label: selectedBall2 ? selectedBall2.label : null,
        registryId: selectedBall2 ? selectedBall2.id : null,
      };
    }
    const editExtraBallsData = editExtraBalls
      .filter((sel) => sel.id)
      .map((sel) => {
        const b = myBalls.find((x) => x.id === sel.id);
        return { type: sel.type, weight: b ? b.weight : null, thumbless: b ? b.thumbless : false, label: b ? b.label : null, registryId: b ? b.id : null };
      });
    const selectedShoe = myShoes.find((s) => s.id === editSelectedShoeId);
    const shoe =
      editShoeType === "own"
        ? {
            type: "own",
            label: selectedShoe ? selectedShoe.label : null,
            shoeRegistryId: editSelectedShoeId || null,
          }
        : { type: "rental", label: null, shoeRegistryId: null };

    const next = games
      .map((g) =>
        g.id === editingGameId
          ? {
              ...g,
              date: editDate,
              gameNumber: Number(editGameNumber) || 1,
              frames: norm.frames,
              total: norm.total ?? g.total,
              ball,
              ball2,
              extraBalls: editExtraBallsData,
              shoe,
            }
          : g
      )
      .map((g) => (g.id === editingGameId ? normalizeBallOrder(g, myBalls) : g))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.gameNumber || 1) - (b.gameNumber || 1));
    await persistGames(next);
    setEditingGameId(null);
    setEditActiveCell(null);
    setEditSplitPending(false);
  };

  const deleteGame = async (id) => {
    const next = games.filter((g) => g.id !== id);
    await persistGames(next);
    setConfirmDeleteId(null);
  };

  const periodRange =
    periodMode === "day"
      ? { start: dayAnchor, end: dayAnchor }
      : periodMode === "week"
      ? getWeekRange(weekAnchor)
      : periodMode === "month"
      ? getMonthRange(monthAnchor)
      : periodMode === "year"
      ? { start: `${yearAnchor}-01-01`, end: `${yearAnchor}-12-31` }
      : { start: customStart, end: customEnd };
  const periodGames = games.filter((g) => g.date >= periodRange.start && g.date <= periodRange.end);
  const ballStats = computeBallRoleStats(periodGames, myBalls);
  const {
    avg, highGame, lowGame,
    strikeCount, strikeRate,
    spareCount, spareRate,
    openFrameCount, openFrameRate,
    splitCount, splitRate,
    splitCoverCount, splitCoverRate,
    gutterCount, gutterRate,
    foulCount, foulRate,
  } = computeGameSetStats(periodGames);

  // "day" compares individual games side by side (a line across a few hours
  // isn't meaningful); longer periods show the daily average instead, since
  // plotting every single game gets cluttered once there are multiple games
  // per day within the window.
  const chartData =
    periodMode === "day"
      ? periodGames
          .slice()
          .sort((a, b) => (a.gameNumber || 1) - (b.gameNumber || 1))
          .map((g) => ({ label: `第${g.gameNumber || 1}G`, total: g.total }))
      : periodMode === "year"
      ? (() => {
          // A whole year as one point per month (daily points would be too crowded).
          const byMonth = {};
          periodGames.forEach((g) => {
            const m = g.date.slice(0, 7);
            if (!byMonth[m]) byMonth[m] = [];
            byMonth[m].push(g.total);
          });
          return Object.keys(byMonth)
            .sort()
            .map((m) => {
              const vals = byMonth[m];
              return { label: `${Number(m.slice(5))}月`, total: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) };
            });
        })()
      : (() => {
          const byDate = {};
          periodGames.forEach((g) => {
            if (!byDate[g.date]) byDate[g.date] = [];
            byDate[g.date].push(g.total);
          });
          return Object.keys(byDate)
            .sort()
            .map((date) => {
              const vals = byDate[date];
              return {
                label: date.slice(5),
                total: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
              };
            });
        })();


  if (isAdminRoute) return <AdminPanel />;
  if (legalRoute) return <LegalPage page={legalRoute} />;

  if (accessStatus !== "approved" || (authUser && syncState === "syncing")) {
    return (
      <GateScreen
        mode={accessStatus !== "approved" ? accessStatus : "syncing"}
        name={requestName}
        setName={setRequestName}
        onSubmit={requestAccess}
        requestNumber={myRequestNumber}
        onLogin={loginWithAccount}
        onSignup={signupWithAccount}
        authBusy={authBusy}
        authErrorMsg={authErrorMsg}
        justSignedOut={justSignedOut}
      />
    );
  }

  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: `radial-gradient(ellipse 120% 40% at 50% 0%, rgba(201,162,39,0.18) 0%, rgba(201,162,39,0) 60%), linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`,
        fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif",
      }}
    >
      {celebration && <Celebration items={celebration} onClose={() => setCelebration(null)} />}

      {saveBlockItems && (
        <AppModal
          title="未選択の項目があります"
          footer={
            <button
              type="button"
              onClick={() => {
                setSaveBlockItems(null);
                document.getElementById("scan-ball-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="w-full rounded-lg py-3"
              style={primaryButtonStyle()}
            >
              選択する
            </button>
          }
        >
          <div style={{ color: COLORS.strike, fontSize: 13.5, lineHeight: 1.7 }}>記録を保存するには、次を選択してください。</div>
          <div className="space-y-1" style={{ marginTop: 8 }}>
            {saveBlockItems.map((m) => (
              <div key={m} className="flex items-center gap-2" style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14 }}>
                <span style={{ color: COLORS.gold }}>●</span> {m}
              </div>
            ))}
          </div>
          <div style={{ color: COLORS.strike, opacity: 0.65, fontSize: 11.5, marginTop: 10, lineHeight: 1.6 }}>
            ※選択肢にない場合は、「設定」タブでボール・シューズを登録してください
          </div>
        </AppModal>
      )}

      {(() => {
        // Balls whose role (1stボール / スペア) hasn't been set yet.
        const unset = myBalls.filter((b) => b.role !== "strike" && b.role !== "spare");
        const busy = celebration || eventPopup || cropEditorOpen || saveBlockItems;
        if (!unset.length || rolePromptDismissed || busy || accessStatus !== "approved") return null;
        return (
          <AppModal
            title="ボールの用途を設定してください"
            footer={
              <button
                type="button"
                onClick={() => setRolePromptDismissed(true)}
                className="w-full rounded-lg py-2.5 text-sm"
                style={{ border: "1px solid rgba(184, 153, 104, 0.6)", color: COLORS.strike, fontWeight: 700 }}
              >
                あとで設定する
              </button>
            }
          >
            <div style={{ color: COLORS.strike, fontSize: 13, lineHeight: 1.7 }}>
              用途を設定すると、ボール別の成績を正しく分析できます。
            </div>
            <div className="space-y-2" style={{ marginTop: 10 }}>
              {unset.map((b) => (
                <div key={b.id} className="rounded-lg p-2.5" style={{ border: "1px solid rgba(224,168,0,0.35)" }}>
                  <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14 }}>
                    {b.label}
                    <span style={{ fontWeight: 400, opacity: 0.7, fontSize: 12 }}> {b.weight}lb</span>
                  </div>
                  <div className="flex gap-2" style={{ marginTop: 6 }}>
                    {[
                      { key: "strike", label: "1stボール" },
                      { key: "spare", label: "スペア" },
                    ].map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        onClick={() => setMyBallRole(b.id, o.key)}
                        className="flex-1 rounded-lg py-2 text-sm"
                        style={toggleStyle(false)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </AppModal>
        );
      })()}
      {bellOpen && <BellPanel items={announcements} onClose={() => setBellOpen(false)} />}
      {eventPopup && (
        <EventPopup
          a={eventPopup}
          hideChecked={hideEventChecked}
          onToggleHide={() => setHideEventChecked((v) => !v)}
          onClose={closeEventPopup}
        />
      )}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');
        .glass-card {
          background: linear-gradient(135deg, rgba(58, 82, 138, 0.55) 0%, rgba(12, 16, 32, 0.65) 65%);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
          border: 1px solid rgba(224, 168, 0, 0.55);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        }
        .glass-input {
          background: rgba(6, 9, 20, 0.45) !important;
          color: #F5F1E4 !important;
        }
        .glass-input::placeholder { color: rgba(245, 241, 228, 0.45); }
        /* Bumped up from Tailwind's default 12px/14px for readability
           (target audience skews 40s-50s). */
        .text-xs { font-size: 0.8125rem !important; line-height: 1.35rem !important; }
        .text-sm { font-size: 0.95rem !important; line-height: 1.5rem !important; }
      `}</style>

      {/* header */}
      <header
        className="px-5 pb-4"
        style={{ background: COLORS.ink, paddingTop: "calc(24px + max(env(safe-area-inset-top), 20px))" }}
      >
        <div className="flex items-center justify-between max-w-md mx-auto">
          <div className="flex items-center gap-3">
            <img
              src="/icons/icon-192.png"
              alt="STRIKE LOG"
              className="w-10 h-10 rounded-full"
              style={{ objectFit: "cover" }}
            />
            <div>
              <div className="text-2xl tracking-wide" style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}>
                STRIKE LOG
              </div>
              <div className="text-xs mt-0.5" style={{ color: COLORS.strike }}>スコア分析 &amp; 記録</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setBellOpen(true);
                markAnnouncementsRead(announcements.map((a) => a.id));
              }}
              className="rounded-full flex items-center justify-center relative"
              style={{ width: 36, height: 36, background: COLORS.strike, color: COLORS.ink }}
              aria-label={unreadAnnouncements > 0 ? `お知らせ(未読${unreadAnnouncements}件)` : "お知らせ"}
            >
              <Bell size={18} />
              {unreadAnnouncements > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -2,
                    minWidth: 16,
                    height: 16,
                    padding: "0 4px",
                    borderRadius: 999,
                    background: COLORS.danger,
                    color: "white",
                    fontSize: 10,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: `2px solid ${COLORS.ink}`,
                  }}
                >
                  {unreadAnnouncements > 9 ? "9+" : unreadAnnouncements}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="rounded-full flex items-center justify-center"
              style={{ width: 36, height: 36, background: COLORS.strike, color: COLORS.ink }}
              aria-label="使い方について質問する"
            >
              <MessageCircle size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-5" style={{ paddingBottom: "calc(96px + env(safe-area-inset-bottom))" }}>
        {tab === "scan" && (
          <div className="space-y-4">
            <div className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
              <label className="text-xs flex items-center justify-between mb-1" style={{ color: COLORS.strike }}>
                <span>スコア画面に表示されている自分の名前</span>
                {nameSaved && <span style={{ color: COLORS.strike }}>保存しました</span>}
              </label>
              <input
                type="text"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                onBlur={(e) => savePlayerName(e.target.value.trim())}
                placeholder="例: ヤマダ"
                className="w-full px-3 py-2 rounded border text-sm"
                style={{ borderColor: COLORS.oak, color: COLORS.ink }}
              />
            </div>

            {!imagePreview && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="glass-card w-full flex flex-col items-center justify-center gap-3 rounded-xl py-14 -2 border-dashed"
              >
                <Camera size={40} style={{ color: COLORS.strike }} />
                <div style={{ color: COLORS.cream, fontWeight: 700 }}>スコア画面を撮影 / アップロード</div>
                <div className="text-xs" style={{ color: COLORS.strike }}>電光掲示板や紙のスコアシートでOK</div>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />

            {imagePreview && pendingResult && (
              <div className="rounded-xl overflow-hidden border" style={{ borderColor: COLORS.oak }}>
                <img src={imagePreview} alt="スコア写真プレビュー" className="w-full object-cover max-h-72" />
              </div>
            )}

            {imagePreview && !pendingResult && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Crop size={18} style={{ color: COLORS.gold, flexShrink: 0 }} />
                  <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 15 }}>自分の行を指で囲む</div>
                </div>
                <div style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12 }}>
                  名前〜合計まで囲むと精度アップ(省略OK)
                </div>
                <CropPreview src={imagePreview} rect={cropRect} />
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => setCropEditorOpen(true)}
                    className="rounded-lg px-4 py-2 text-sm flex items-center gap-2"
                    style={{ border: `1px solid ${COLORS.gold}`, color: COLORS.gold, fontWeight: 700 }}
                  >
                    <Crop size={15} /> {cropRect ? "囲み直す" : "囲む"}
                  </button>
                  {cropRect && (
                    <button
                      type="button"
                      onClick={() => setCropRect(null)}
                      className="text-xs underline"
                      style={{ color: COLORS.strike }}
                    >
                      囲みを解除する
                    </button>
                  )}
                </div>
                {cropEditorOpen && (
                  <CropEditor
                    src={imagePreview}
                    initialRect={cropRect}
                    onDone={(r) => {
                      setCropRect(r);
                      setCropEditorOpen(false);
                    }}
                    onSkip={() => setCropEditorOpen(false)}
                  />
                )}
              </div>
            )}

            {imagePreview && !pendingResult && (
              <div className="flex gap-2">
                <button
                  onClick={runAnalysis}
                  disabled={analyzing}
                  className="flex-1 rounded-lg py-3 flex items-center justify-center gap-2"
                  style={{ background: COLORS.strike, color: COLORS.ink, fontWeight: 700 }}
                >
                  {analyzing ? <Loader2 className="animate-spin" size={18} /> : null}
                  {analyzing ? "解析中..." : cropRect ? "囲んだ範囲を解析する" : "解析する"}
                </button>
                <button
                  onClick={() => {
                    setImagePreview(null);
                    setImageMeta(null);
    setCropRect(null);
                    setAnalyzeError("");
                  }}
                  className="rounded-lg px-4 py-3 border"
                  style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                >
                  撮り直す
                </button>
              </div>
            )}

            {analyzeError && (
              <div className="glass-card rounded-xl p-4" style={{ color: COLORS.strike, fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                {analyzeError}
              </div>
            )}

            {pendingResult && pendingResult.player_matched === false && (
              <div className="glass-card rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2">
                  {pendingResult.notScore ? (
                    <ImageOff size={20} style={{ color: COLORS.gold, flexShrink: 0 }} />
                  ) : (
                    <UserX size={20} style={{ color: COLORS.gold, flexShrink: 0 }} />
                  )}
                  <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 16 }}>
                    {pendingResult.notScore
                      ? "スコアが見つかりませんでした"
                      : playerName
                      ? `「${playerName}」が見つかりませんでした`
                      : "自分の行が見つかりませんでした"}
                  </div>
                </div>
                <div style={{ color: COLORS.strike, opacity: 0.8, fontSize: 13, lineHeight: 1.6 }}>
                  {pendingResult.notScore
                    ? "ボウリングのスコア画面か、スコアシートの写真を選んでください"
                    : "名前の表記を確認するか、自分の行を指で囲んで解析してください"}
                </div>
                {!pendingResult.notScore && pendingResult.other_players_detected?.length > 0 && (
                  <div style={{ color: COLORS.strike, opacity: 0.8, fontSize: 13 }}>
                    写真内の名前:{pendingResult.other_players_detected.join(" / ")}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (pendingResult.notScore) {
                      setImagePreview(null);
                      setImageMeta(null);
                      setCropRect(null);
                      sourceImgRef.current = null;
                    }
                    setAnalyzeError("");
                    setPendingResult(null);
                  }}
                  className="w-full rounded-lg py-3"
                  style={{ background: COLORS.strike, color: COLORS.ink, fontWeight: 700 }}
                >
                  {pendingResult.notScore ? "写真を選び直す" : "やり直す"}
                </button>
              </div>
            )}

            {pendingResult && pendingResult.player_matched !== false && (
              <div className="space-y-3">
                {(pendingResult.games || []).map((game, gameIdx) => (
                  <div key={gameIdx} className="glass-card rounded-xl p-3">
                    {pendingResult.games.length > 1 && (
                      <div className="mb-2 text-xs" style={{ color: COLORS.strike }}>
                        {game.gameLabel || `${gameIdx + 1}ゲーム目`}
                      </div>
                    )}
                    <ScoreSheet
                      frames={game.frames}
                      editable
                      activeCell={activeCell?.gameIdx === gameIdx ? activeCell : null}
                      onCellTap={(frameIdx, rollIdx) => handleCellTap(gameIdx, frameIdx, rollIdx)}
                    />

                    {activeCell?.gameIdx === gameIdx && (
                      <div className="mt-2">
                        <RollPicker
                          frameIdx={activeCell.frameIdx}
                          rollIdx={activeCell.rollIdx}
                          splitEligible
                          splitActive={splitPending}
                          onSplitToggle={() => setSplitPending((s) => !s)}
                          onSelect={handlePickerSelect}
                          onClear={handlePickerClear}
                          onClose={closePicker}
                        />
                      </div>
                    )}

                    {!(activeCell?.gameIdx === gameIdx) && (
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-xs" style={{ color: COLORS.strike }}>このゲームの合計</span>
                        <span
                          style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 18, color: COLORS.strike }}
                        >
                          {game.total_score ?? "-"}
                        </span>
                      </div>
                    )}
                    {game.totalMismatch && !activeCell && (
                      <div
                        className="mt-2 rounded p-2 text-xs"
                        style={{ color: COLORS.danger, fontWeight: 700 }}
                      >
                        {game.totalMismatch.frames?.length > 0
                          ? `⚠ すみません。${
                              game.totalMismatch.frames.length > 3
                                ? `${game.totalMismatch.frames.slice(0, 3).map((i) => i + 1).join("・")}フレーム目など`
                                : `${game.totalMismatch.frames.map((i) => i + 1).join("・")}フレーム目`
                            }がうまく読み取れなかったようで、解析スコアと見比べて修正をお願いします。`
                          : "⚠ すみません。うまく読み取れなかったようで、解析スコアと見比べて修正をお願いします。"}
                      </div>
                    )}
                    {!game.totalMismatch && game.autoCorrectedFrames?.length > 0 && !activeCell && (
                      <div className="mt-2 text-xs" style={{ color: COLORS.strike }}>
                        写真の累計スコアをもとに、{game.autoCorrectedFrames.map((i) => i + 1).join("・")}フレーム目を自動で補正しました。念のためご確認ください。
                      </div>
                    )}
                  </div>
                ))}

                <div className="text-xs" style={{ color: COLORS.strike }}>
                  合計スコアは公式ルールに沿って自動計算されます
                </div>

                <div className="glass-card rounded-xl p-3 flex items-center justify-between">
                  <span className="text-sm flex items-center gap-2" style={{ color: COLORS.cream }}>
                    <Calendar size={16} /> プレー日
                  </span>
                  <input
                    type="date"
                    value={gameDate}
                    onChange={(e) => setGameDate(e.target.value)}
                    className="px-2 py-1 rounded border text-sm"
                    style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                  />
                </div>

                <div className="glass-card rounded-xl p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm flex items-center gap-2" style={{ color: COLORS.cream }}>
                      <Hash size={16} /> {pendingResult.games?.length > 1 ? "何ゲーム目から" : "何ゲーム目"}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                      type="button"
                      onClick={() => {
                        setGameNumberTouched(true);
                        setGameNumber((n) => Math.max(1, Number(n) - 1));
                      }}
                      className="w-7 h-7 rounded border flex items-center justify-center"
                      style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      value={gameNumber}
                      onChange={(e) => {
                        setGameNumberTouched(true);
                        setGameNumber(Math.max(1, Number(e.target.value) || 1));
                      }}
                      className="w-12 text-center px-1 py-1 rounded border text-sm"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setGameNumberTouched(true);
                        setGameNumber((n) => Number(n) + 1);
                      }}
                      className="w-7 h-7 rounded border flex items-center justify-center"
                      style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                    >
                      +
                    </button>
                  </div>
                  </div>
                  {pendingResult.games?.length > 1 && (
                    <div className="mt-1 text-xs" style={{ color: COLORS.strike }}>
                      {pendingResult.games.length}ゲーム分を、{gameNumber}ゲーム目から連番で保存します
                    </div>
                  )}
                </div>

                <div
                  id="scan-ball-card"
                  className="glass-card rounded-xl p-3 space-y-3"
                  onClickCapture={() => setBallTouched(true)}
                  onChangeCapture={() => setBallTouched(true)}
                >
                  <div className="text-sm flex items-center gap-2" style={{ color: COLORS.cream }}>
                    <CircleDot size={16} /> 使用ボール
                  </div>

                  <div className="space-y-2">
                    <div className="flex gap-2">
                      {[
                        { key: "house", label: "ハウスボール" },
                        { key: "own", label: "マイボール" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setBallType(opt.key)}
                          className="flex-1 rounded-lg py-2 text-xs"
                          style={toggleStyle(ballType === opt.key)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {myBalls.filter((b) => (b.type || "own") === ballType).length === 0 ? (
                      <div className="text-xs" style={{ color: COLORS.strike }}>
                        登録済みの{ballType === "house" ? "ハウスボール" : "マイボール"}がありません。「設定」タブで登録してください
                      </div>
                    ) : (
                      <select
                        value={selectedBallId || ""}
                        onChange={(e) => setSelectedBallId(e.target.value || null)}
                        className="w-full px-2 py-2 rounded border text-sm"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                      >
                        <option value="">ボールを選択</option>
                        {myBalls
                          .filter((b) => (b.type || "own") === ballType)
                          .map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? " 1st" : b.role === "spare" ? " スペア" : ""}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>

                  {useSecondBall && (
                    <div className="space-y-2" style={{ borderTop: `1px solid rgba(224, 168, 0, 0.3)`, paddingTop: 10 }}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ color: COLORS.oak }}>2個目のボール</span>
                        <button
                          type="button"
                          onClick={() => {
                            setUseSecondBall(false);
                            setBallType2("house");
                            setBallWeight2("");
                            setBallThumbless2(false);
                            setSelectedBallId2(null);
                            setExtraBalls([]);
                          }}
                          aria-label="2つ目のボールを削除"
                        >
                          <X size={14} style={{ color: COLORS.strike }} />
                        </button>
                      </div>

                      <div className="flex gap-2">
                        {[
                          { key: "house", label: "ハウスボール" },
                          { key: "own", label: "マイボール" },
                        ].map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => setBallType2(opt.key)}
                            className="flex-1 rounded-lg py-2 text-xs"
                            style={toggleStyle(ballType2 === opt.key)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>

                      {myBalls.filter((b) => (b.type || "own") === ballType2).length === 0 ? (
                        <div className="text-xs" style={{ color: COLORS.strike }}>
                          登録済みの{ballType2 === "house" ? "ハウスボール" : "マイボール"}がありません
                        </div>
                      ) : (
                        <select
                          value={selectedBallId2 || ""}
                          onChange={(e) => setSelectedBallId2(e.target.value || null)}
                          className="w-full px-2 py-2 rounded border text-sm"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                        >
                          <option value="">ボールを選択</option>
                          {myBalls
                            .filter((b) => (b.type || "own") === ballType2)
                            .map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? " 1st" : b.role === "spare" ? " スペア" : ""}
                              </option>
                            ))}
                        </select>
                      )}
                    </div>
                  )}

                  {useSecondBall &&
                    extraBalls.map((sel, idx) => (
                      <div key={idx} className="space-y-2" style={{ borderTop: `1px solid rgba(224, 168, 0, 0.3)`, paddingTop: 10 }}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs" style={{ color: COLORS.oak }}>{idx + 3}個目のボール</span>
                          <button type="button" onClick={() => removeExtraBall(idx)} aria-label="削除">
                            <X size={14} style={{ color: COLORS.strike }} />
                          </button>
                        </div>

                        <div className="flex gap-2">
                          {[
                            { key: "house", label: "ハウスボール" },
                            { key: "own", label: "マイボール" },
                          ].map((opt) => (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => updateExtraBallType(idx, opt.key)}
                              className="flex-1 rounded-lg py-2 text-xs"
                              style={toggleStyle(sel.type === opt.key)}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>

                        {myBalls.filter((b) => (b.type || "own") === sel.type).length === 0 ? (
                          <div className="text-xs" style={{ color: COLORS.strike }}>
                            登録済みの{sel.type === "house" ? "ハウスボール" : "マイボール"}がありません
                          </div>
                        ) : (
                          <select
                            value={sel.id || ""}
                            onChange={(e) => updateExtraBallId(idx, e.target.value || null)}
                            className="w-full px-2 py-2 rounded border text-sm"
                            style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                          >
                            <option value="">ボールを選択</option>
                            {myBalls
                              .filter((b) => (b.type || "own") === sel.type)
                              .map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? " 1st" : b.role === "spare" ? " スペア" : ""}
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                    ))}

                  <button
                    type="button"
                    onClick={() => {
                      if (!useSecondBall) {
                        setUseSecondBall(true);
                      } else {
                        addExtraBall();
                      }
                    }}
                    className="w-full rounded-lg py-2 text-xs"
                    style={{ border: `1px dashed ${COLORS.oak}`, color: COLORS.strike }}
                  >
                    + ボールを追加
                  </button>
                </div>

                <div className="glass-card rounded-xl p-3 space-y-2">
                  <div className="text-sm flex items-center gap-2" style={{ color: COLORS.cream }}>
                    <CircleDot size={16} /> 使用シューズ
                  </div>

                  <div className="flex gap-2">
                    {[
                      { key: "rental", label: "レンタルシューズ" },
                      { key: "own", label: "マイシューズ" },
                    ].map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => {
                          setShoeType(opt.key);
                          setShoeTouched(true);
                        }}
                        className="flex-1 rounded-lg py-2 text-xs"
                        style={toggleStyle(shoeType === opt.key)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {shoeType === "rental" ? null : myShoes.length === 0 ? (
                    <div className="text-xs" style={{ color: COLORS.strike }}>
                      登録済みのマイシューズがありません。「設定」タブで登録してください
                    </div>
                  ) : (
                    <select
                      value={selectedShoeId || ""}
                      onChange={(e) => {
                        setSelectedShoeId(e.target.value || null);
                        setShoeTouched(true);
                      }}
                      className="w-full px-2 py-2 rounded border text-sm"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    >
                      <option value="">シューズを選択</option>
                      {myShoes
                        .filter((s) => s.type === "own")
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                    </select>
                  )}
                </div>

                <button
                  onClick={saveGame}
                  className="w-full rounded-lg py-3 flex items-center justify-center gap-2"
                  style={primaryButtonStyle()}
                >
                  <Check size={18} /> 記録を保存
                </button>

                {confirmRetake ? (
                  <div className="rounded-lg p-3" style={{ background: "#FBEAE5" }}>
                    <div style={{ color: COLORS.danger, fontWeight: 700, fontSize: 13 }}>
                      編集内容は失われますが、撮り直しますか?
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => setConfirmRetake(false)}
                        className="flex-1 rounded-lg py-2 text-xs border"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingResult(null);
                          setImagePreview(null);
                          setImageMeta(null);
    setCropRect(null);
                          setAnalyzeError("");
                          setActiveCell(null);
                          setSplitPending(false);
                          setConfirmRetake(false);
                        }}
                        className="flex-1 rounded-lg py-2 text-xs"
                        style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}
                      >
                        撮り直す
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRetake(true)}
                    className="w-full rounded-lg py-4 text-base"
                    style={{ border: `2px solid ${COLORS.oak}`, color: COLORS.cream, fontWeight: 700 }}
                  >
                    撮り直す
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="space-y-3">
            {loadingGames && <div className="text-sm text-center py-10" style={{ color: COLORS.strike }}>読み込み中...</div>}
            {!loadingGames && games.length === 0 && (
              <div className="text-sm text-center py-16" style={{ color: COLORS.strike }}>
                まだ記録がありません。「スコア記録」タブから撮影してみましょう。
              </div>
            )}
            {[...games].reverse().map((g) =>
              editingGameId === g.id ? (
                <div key={g.id} className="rounded-xl p-3 border glass-card space-y-3" style={{ borderColor: COLORS.gold }}>
                  <div className="flex items-center justify-between">
                    <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 15 }}>記録を編集中</div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={cancelEditGame}
                        className="rounded-lg px-2 py-1 text-xs border"
                        style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        onClick={saveEditedGame}
                        className="rounded-lg px-3 py-1 text-xs flex items-center gap-1"
                        style={primaryButtonStyle()}
                      >
                        <Check size={12} /> 保存
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="flex-1 px-2 py-1 rounded border text-sm"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    />
                    <input
                      type="number"
                      min={1}
                      value={editGameNumber}
                      onChange={(e) => setEditGameNumber(Math.max(1, Number(e.target.value) || 1))}
                      className="w-16 px-2 py-1 rounded border text-sm text-center"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    />
                    <span className="text-xs" style={{ color: COLORS.strike }}>ゲーム目</span>
                  </div>

                  <ScoreSheet frames={editFrames} editable activeCell={editActiveCell} onCellTap={handleEditCellTap} />

                  {editActiveCell && (
                    <RollPicker
                      frameIdx={editActiveCell.frameIdx}
                      rollIdx={editActiveCell.rollIdx}
                      splitEligible={editActiveCell.rollIdx === 0}
                      splitActive={editSplitPending}
                      onSplitToggle={() => setEditSplitPending((s) => !s)}
                      onSelect={handleEditPickerSelect}
                      onClear={handleEditPickerClear}
                      onClose={closeEditPicker}
                    />
                  )}

                  <div className="rounded-xl p-3 glass-card space-y-3">
                    <div className="text-xs" style={{ color: COLORS.oak }}>ボール</div>

                    <div className="space-y-2">
                      <div className="flex gap-2">
                        {[
                          { key: "house", label: "ハウスボール" },
                          { key: "own", label: "マイボール" },
                        ].map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => setEditBallType(opt.key)}
                            className="flex-1 rounded-lg py-2 text-xs"
                            style={toggleStyle(editBallType === opt.key)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      {myBalls.filter((b) => (b.type || "own") === editBallType).length === 0 ? (
                        <div className="text-xs" style={{ color: COLORS.strike }}>
                          登録済みの{editBallType === "house" ? "ハウスボール" : "マイボール"}がありません
                        </div>
                      ) : (
                        <select
                          value={editSelectedBallId || ""}
                          onChange={(e) => setEditSelectedBallId(e.target.value || null)}
                          className="w-full px-2 py-2 rounded border text-sm"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                        >
                          <option value="">ボールを選択</option>
                          {myBalls
                            .filter((b) => (b.type || "own") === editBallType)
                            .map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? " 1st" : b.role === "spare" ? " スペア" : ""}
                              </option>
                            ))}
                        </select>
                      )}
                    </div>

                    {editUseSecondBall && (
                      <div className="space-y-2" style={{ borderTop: `1px solid rgba(224, 168, 0, 0.3)`, paddingTop: 10 }}>
                        <div className="flex items-center justify-between">
                          <div className="text-xs" style={{ color: COLORS.oak }}>2個目のボール</div>
                          <button type="button" onClick={() => setEditUseSecondBall(false)} aria-label="削除">
                            <X size={14} style={{ color: COLORS.oak }} />
                          </button>
                        </div>
                        <div className="flex gap-2">
                          {[
                            { key: "house", label: "ハウスボール" },
                            { key: "own", label: "マイボール" },
                          ].map((opt) => (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => setEditBallType2(opt.key)}
                              className="flex-1 rounded-lg py-2 text-xs"
                              style={toggleStyle(editBallType2 === opt.key)}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        {myBalls.filter((b) => (b.type || "own") === editBallType2).length === 0 ? (
                          <div className="text-xs" style={{ color: COLORS.strike }}>
                            登録済みの{editBallType2 === "house" ? "ハウスボール" : "マイボール"}がありません
                          </div>
                        ) : (
                          <select
                            value={editSelectedBallId2 || ""}
                            onChange={(e) => setEditSelectedBallId2(e.target.value || null)}
                            className="w-full px-2 py-2 rounded border text-sm"
                            style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                          >
                            <option value="">ボールを選択</option>
                            {myBalls
                              .filter((b) => (b.type || "own") === editBallType2)
                              .map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? " 1st" : b.role === "spare" ? " スペア" : ""}
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                    )}

                    {editUseSecondBall &&
                      editExtraBalls.map((sel, idx) => (
                        <div key={idx} className="space-y-2" style={{ borderTop: `1px solid rgba(224, 168, 0, 0.3)`, paddingTop: 10 }}>
                          <div className="flex items-center justify-between">
                            <div className="text-xs" style={{ color: COLORS.oak }}>{idx + 3}個目のボール</div>
                            <button type="button" onClick={() => removeEditExtraBall(idx)} aria-label="削除">
                              <X size={14} style={{ color: COLORS.oak }} />
                            </button>
                          </div>
                          <div className="flex gap-2">
                            {[
                              { key: "house", label: "ハウスボール" },
                              { key: "own", label: "マイボール" },
                            ].map((opt) => (
                              <button
                                key={opt.key}
                                type="button"
                                onClick={() => updateEditExtraBallType(idx, opt.key)}
                                className="flex-1 rounded-lg py-2 text-xs"
                                style={toggleStyle(sel.type === opt.key)}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                          {myBalls.filter((b) => (b.type || "own") === sel.type).length === 0 ? (
                            <div className="text-xs" style={{ color: COLORS.strike }}>
                              登録済みの{sel.type === "house" ? "ハウスボール" : "マイボール"}がありません
                            </div>
                          ) : (
                            <select
                              value={sel.id || ""}
                              onChange={(e) => updateEditExtraBallId(idx, e.target.value || null)}
                              className="w-full px-2 py-2 rounded border text-sm"
                              style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                            >
                              <option value="">ボールを選択</option>
                              {myBalls
                                .filter((b) => (b.type || "own") === sel.type)
                                .map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? " 1st" : b.role === "spare" ? " スペア" : ""}
                                  </option>
                                ))}
                            </select>
                          )}
                        </div>
                      ))}

                    <button
                      type="button"
                      onClick={() => {
                        if (!editUseSecondBall) {
                          setEditUseSecondBall(true);
                        } else {
                          addEditExtraBall();
                        }
                      }}
                      className="w-full rounded-lg py-2 text-xs"
                      style={{ border: `1px dashed ${COLORS.oak}`, color: COLORS.strike }}
                    >
                      + ボールを追加
                    </button>
                  </div>

                  <div className="rounded-xl p-3 glass-card space-y-2">
                    <div className="text-xs" style={{ color: COLORS.oak }}>シューズ</div>
                    <div className="flex gap-2">
                      {[
                        { key: "rental", label: "レンタル" },
                        { key: "own", label: "マイシューズ" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setEditShoeType(opt.key)}
                          className="flex-1 rounded-lg py-2 text-xs"
                          style={toggleStyle(editShoeType === opt.key)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {editShoeType === "rental" ? null : (
                      <select
                        value={editSelectedShoeId || ""}
                        onChange={(e) => setEditSelectedShoeId(e.target.value || null)}
                        className="w-full px-2 py-2 rounded border text-sm"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                      >
                        <option value="">シューズを選択</option>
                        {myShoes
                          .filter((s) => s.type === "own")
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>
              ) : (
              <div key={g.id} className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                <div className="flex items-center justify-between mb-2">
                  <div style={{ color: COLORS.strike, fontSize: 14 }}>
                    {g.date}
                    <span className="ml-2" style={{ color: COLORS.cream, fontWeight: 700 }}>
                      {g.gameNumber ? `${g.gameNumber}ゲーム目` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, color: COLORS.strike }}>
                      {g.total}
                    </div>
                    <button onClick={() => startEditGame(g)} aria-label="編集">
                      <Pencil size={16} style={{ color: COLORS.strike }} />
                    </button>
                    <button onClick={() => setConfirmDeleteId(g.id)} aria-label="削除">
                      <X size={16} style={{ color: COLORS.strike }} />
                    </button>
                  </div>
                </div>
                {confirmDeleteId === g.id && (
                  <div
                    className="mb-2 rounded-lg p-2 flex items-center justify-between"
                    style={{ background: "#FBEAE5" }}
                  >
                    <span className="text-xs" style={{ color: COLORS.danger, fontWeight: 700 }}>
                      本当に削除しますか?
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-xs rounded px-2 py-1 border"
                        style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteGame(g.id)}
                        className="text-xs rounded px-2 py-1"
                        style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}
                      >
                        削除する
                      </button>
                    </div>
                  </div>
                )}
                {g.ball && (g.ball.weight || g.ball.type) && (
                  <div className="mb-2 flex items-center gap-1" style={{ color: COLORS.strike, fontSize: 13 }}>
                    <CircleDot size={11} />
                    {g.ball.label ? g.ball.label : g.ball.type === "own" ? "マイボール" : "ハウスボール"}
                    {g.ball.weight ? ` ${g.ball.weight}lb` : ""}
                    {g.ball.thumbless ? " ・ サムレス" : ""}
                  </div>
                )}
                {g.ball2 && (g.ball2.weight || g.ball2.type) && (
                  <div className="mb-2 flex items-center gap-1" style={{ color: COLORS.strike, fontSize: 13 }}>
                    <CircleDot size={11} />
                    {g.ball2.label ? g.ball2.label : g.ball2.type === "own" ? "マイボール" : "ハウスボール"}
                    {g.ball2.weight ? ` ${g.ball2.weight}lb` : ""}
                    {g.ball2.thumbless ? " ・ サムレス" : ""}
                    <span style={{ color: COLORS.strike }}>(2つ目)</span>
                  </div>
                )}
                {(g.extraBalls || []).map((eb, ebIdx) => (
                  <div key={ebIdx} className="mb-2 flex items-center gap-1" style={{ color: COLORS.strike, fontSize: 13 }}>
                    <CircleDot size={11} />
                    {eb.label ? eb.label : eb.type === "own" ? "マイボール" : "ハウスボール"}
                    {eb.weight ? ` ${eb.weight}lb` : ""}
                    {eb.thumbless ? " ・ サムレス" : ""}
                    <span style={{ color: COLORS.strike }}>({ebIdx + 3}つ目)</span>
                  </div>
                ))}
                {g.shoe && g.shoe.type && (
                  <div className="mb-2 flex items-center gap-1" style={{ color: COLORS.strike, fontSize: 13 }}>
                    <CircleDot size={11} />
                    {g.shoe.label ? g.shoe.label : g.shoe.type === "own" ? "マイシューズ" : "レンタル"}
                  </div>
                )}
                <ScoreSheet frames={g.frames} />
              </div>
              )
            )}
            {storageError && <div className="text-xs text-center" style={{ color: COLORS.danger }}>{storageError}</div>}
          </div>
        )}

        {tab === "stats" && (
          <div className="space-y-4">
            {games.length === 0 ? (
              <div className="text-sm text-center py-16" style={{ color: COLORS.strike }}>
                データがまだありません。記録を保存すると統計が表示されます。
              </div>
            ) : (
              <>
                <div className="flex gap-1.5">
                  {[
                    { key: "day", label: "日" },
                    { key: "week", label: "週" },
                    { key: "month", label: "月" },
                    { key: "year", label: "年" },
                    { key: "custom", label: "期間指定" },
                  ].map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setPeriodMode(p.key)}
                      className="rounded-lg py-2 text-sm"
                      style={{
                        ...toggleStyle(periodMode === p.key),
                        // 「期間指定」 has 4 characters; the others have 1
                        flex: p.key === "custom" ? 1.7 : 1,
                        minWidth: 0,
                        whiteSpace: "nowrap",
                        padding: "8px 4px",
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                  {periodMode === "day" && (
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setDayAnchor((d) => shiftDate(d, -1))}
                        className="w-8 h-8 rounded border flex items-center justify-center"
                        style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                      >
                        ‹
                      </button>
                      <input
                        type="date"
                        value={dayAnchor}
                        onChange={(e) => setDayAnchor(e.target.value)}
                        className="px-2 py-1 rounded border text-sm flex-1"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                      />
                      <button
                        type="button"
                        onClick={() => setDayAnchor((d) => shiftDate(d, 1))}
                        className="w-8 h-8 rounded border flex items-center justify-center"
                        style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                      >
                        ›
                      </button>
                    </div>
                  )}

                  {periodMode === "week" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setWeekAnchor((d) => shiftDate(d, -7))}
                          className="w-8 h-8 rounded border flex items-center justify-center"
                          style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                        >
                          ‹
                        </button>
                        <input
                          type="date"
                          value={weekAnchor}
                          onChange={(e) => setWeekAnchor(e.target.value)}
                          className="px-2 py-1 rounded border text-sm flex-1"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                        />
                        <button
                          type="button"
                          onClick={() => setWeekAnchor((d) => shiftDate(d, 7))}
                          className="w-8 h-8 rounded border flex items-center justify-center"
                          style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                        >
                          ›
                        </button>
                      </div>
                      <div className="text-center text-xs" style={{ color: COLORS.strike }}>
                        {formatMDWeekday(periodRange.start)} 〜 {formatMDWeekday(periodRange.end)}
                      </div>
                    </div>
                  )}

                  {periodMode === "month" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setMonthAnchor((m) => shiftMonth(m, -1))}
                          className="w-8 h-8 rounded border flex items-center justify-center"
                          style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                        >
                          ‹
                        </button>
                        <input
                          type="month"
                          value={monthAnchor}
                          onChange={(e) => setMonthAnchor(e.target.value)}
                          className="px-2 py-1 rounded border text-sm flex-1"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                        />
                        <button
                          type="button"
                          onClick={() => setMonthAnchor((m) => shiftMonth(m, 1))}
                          className="w-8 h-8 rounded border flex items-center justify-center"
                          style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                        >
                          ›
                        </button>
                      </div>
                      <div className="text-center text-xs" style={{ color: COLORS.strike }}>
                        {formatMD(periodRange.start)} 〜 {formatMD(periodRange.end)}
                      </div>
                    </div>
                  )}

                  {periodMode === "year" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setYearAnchor((y) => y - 1)}
                          className="w-8 h-8 rounded border flex items-center justify-center"
                          style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                          aria-label="前の年"
                        >
                          ‹
                        </button>
                        <div
                          className="px-2 py-1 rounded border text-sm flex-1 text-center"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink, background: "#FFFFFF", fontWeight: 700 }}
                        >
                          {yearAnchor}年
                        </div>
                        <button
                          type="button"
                          onClick={() => setYearAnchor((y) => y + 1)}
                          className="w-8 h-8 rounded border flex items-center justify-center"
                          style={{ borderColor: COLORS.oak, color: COLORS.cream }}
                          aria-label="次の年"
                        >
                          ›
                        </button>
                      </div>
                      <div className="text-center text-xs" style={{ color: COLORS.strike }}>
                        {yearAnchor}年1月1日 〜 12月31日
                      </div>
                    </div>
                  )}

                  {periodMode === "custom" && (
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                        className="px-2 py-1 rounded border text-sm flex-1"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                      />
                      <span style={{ color: COLORS.strike }}>〜</span>
                      <input
                        type="date"
                        value={customEnd}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        className="px-2 py-1 rounded border text-sm flex-1"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                      />
                    </div>
                  )}
                </div>

                {periodGames.length === 0 ? (
                  <div className="text-sm text-center py-10" style={{ color: COLORS.strike }}>
                    この期間の記録はまだありません
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.strike }}>ゲーム数</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream }}>{periodGames.length}</div>
                      </div>
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.strike }}>アベレージ</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream }}>{avg}</div>
                      </div>
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs flex items-center justify-center gap-1" style={{ color: COLORS.strike }}>
                          <Trophy size={12} /> ハイゲーム
                        </div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.strike }}>{highGame}</div>
                      </div>
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.strike }}>ローゲーム</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream }}>{lowGame}</div>
                      </div>
                    </div>

                    {(goalAverage || goalScore) && (
                      <div className="rounded-xl p-3 border glass-card flex items-center gap-4" style={{ borderColor: COLORS.oak }}>
                        <Target size={16} style={{ color: COLORS.gold }} />
                        <div className="flex-1 text-xs" style={{ color: COLORS.cream }}>
                          {goalAverage && (
                            <div>
                              目標アベレージ {goalAverage}
                              {avg >= Number(goalAverage) ? (
                                <span style={{ color: COLORS.strike, fontWeight: 700 }}> ・ 達成!</span>
                              ) : (
                                <span> ・ あと{Number(goalAverage) - avg}</span>
                              )}
                            </div>
                          )}
                          {goalScore && (
                            <div>
                              目標スコア {goalScore}
                              {highGame >= Number(goalScore) ? (
                                <span style={{ color: COLORS.strike, fontWeight: 700 }}> ・ 達成!</span>
                              ) : (
                                <span> ・ あと{Number(goalScore) - highGame}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                      {[
                        { label: "ストライク", count: strikeCount, rate: strikeRate },
                        { label: "スペア", count: spareCount, rate: spareRate },
                        { label: "オープンフレーム", count: openFrameCount, rate: openFrameRate },
                        { label: "スプリット", count: splitCount, rate: splitRate },
                        { label: "スプリットカバー", count: splitCoverCount, rate: splitCoverRate },
                        { label: "ガター", count: gutterCount, rate: gutterRate },
                        { label: "ファール", count: foulCount, rate: foulRate },
                      ].map((row, i) => (
                        <div
                          key={row.label}
                          className="flex items-center justify-between px-3 py-2"
                          style={{ borderTop: i === 0 ? "none" : `1px solid #EFE4CC` }}
                        >
                          <span className="text-sm" style={{ color: COLORS.cream }}>{row.label}</span>
                          <span className="flex items-baseline gap-2">
                            <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16, color: COLORS.cream }}>
                              {row.count}
                            </span>
                            <span style={{ color: COLORS.strike, fontSize: 13 }}>回</span>
                            <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16, color: COLORS.strike, minWidth: 42, textAlign: "right" }}>
                              {row.rate}%
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>


                    <div className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                      <div className="text-xs mb-2 flex items-center gap-1" style={{ color: COLORS.strike }}>
                        <TrendingUp size={14} />
                        {periodMode === "day" ? "本日のゲームごとのスコア" : periodMode === "year" ? "月ごとの平均スコア推移" : "日ごとの平均スコア推移"}
                      </div>
                      <ResponsiveContainer width="100%" height={240}>
                        <LineChart data={chartData} margin={{ top: 20, right: 10, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#E5DCC8" />
                          <XAxis dataKey="label" tick={{ fontSize: 13, fill: COLORS.strike }} />
                          <YAxis domain={[0, 300]} ticks={[0, 50, 100, 150, 200, 250, 300]} tick={{ fontSize: 13, fill: COLORS.strike }} />
                          <Tooltip contentStyle={{ fontSize: 14, borderColor: COLORS.oak }} />
                          <Line
                            type="monotone"
                            dataKey="total"
                            stroke={COLORS.strike}
                            strokeWidth={2.5}
                            dot={{ r: 3, fill: COLORS.strike }}
                            label={{ position: "top", fontSize: 13, fontWeight: 700, fill: COLORS.strike }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>

                    {periodMode === "day" && periodGames.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs flex items-center gap-1" style={{ color: COLORS.strike }}>
                          <Hash size={12} /> ゲームごとの内訳
                        </div>
                        {[...periodGames]
                          .sort((a, b) => (a.gameNumber || 1) - (b.gameNumber || 1))
                          .map((g) => {
                            const gs = computeGameSetStats([g]);
                            return (
                              <div key={g.id} className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                                <div
                                  className="flex items-center justify-between px-3 py-2"
                                  style={{ borderBottom: `1px solid rgba(224, 168, 0, 0.35)` }}
                                >
                                  <span className="text-sm" style={{ color: COLORS.strike, fontWeight: 700 }}>
                                    {g.gameNumber ? `第${g.gameNumber}ゲーム` : "ゲーム"}
                                  </span>
                                  <span
                                    style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 18, color: COLORS.gold }}
                                  >
                                    {g.total}
                                  </span>
                                </div>
                                <div className="px-3 pt-2 pb-3" style={{ borderBottom: `1px solid rgba(224, 168, 0, 0.35)` }}>
                                  <ScoreSheet frames={g.frames} />
                                </div>
                                {[
                                  { label: "ストライク", count: gs.strikeCount, rate: gs.strikeRate },
                                  { label: "スペア", count: gs.spareCount, rate: gs.spareRate },
                                  { label: "オープンフレーム", count: gs.openFrameCount, rate: gs.openFrameRate },
                                  { label: "スプリット", count: gs.splitCount, rate: gs.splitRate },
                                  { label: "スプリットカバー", count: gs.splitCoverCount, rate: gs.splitCoverRate },
                                  { label: "ガター", count: gs.gutterCount, rate: gs.gutterRate },
                                  { label: "ファール", count: gs.foulCount, rate: gs.foulRate },
                                ].map((row) => (
                                  <div
                                    key={row.label}
                                    className="flex items-center justify-between px-3 py-1.5"
                                    style={{ borderTop: `1px solid rgba(224, 168, 0, 0.2)` }}
                                  >
                                    <span style={{ color: COLORS.cream, fontSize: 14 }}>{row.label}</span>
                                    <span className="flex items-baseline gap-2">
                                      <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, color: COLORS.cream }}>
                                        {row.count}
                                      </span>
                                      <span style={{ color: COLORS.strike, fontSize: 12 }}>回</span>
                                      <span
                                        style={{
                                          fontFamily: "'Oswald', sans-serif",
                                          fontWeight: 700,
                                          fontSize: 15,
                                          color: COLORS.strike,
                                          minWidth: 36,
                                          textAlign: "right",
                                        }}
                                      >
                                        {row.rate}%
                                      </span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            );
                          })}
                      </div>
                    )}

                    {periodGames.length > 0 && (
                      <details className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                        <summary className="px-3 py-2 cursor-pointer text-sm" style={{ color: COLORS.strike }}>
                          ボール別の成績
                        </summary>
                        <BallRankings stats={ballStats} />
                      </details>
                    )}

                    <details className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                      <summary className="px-3 py-2 cursor-pointer text-sm" style={{ color: COLORS.strike }}>
                        用語と計算式
                      </summary>
                      <div className="px-3 pb-3 space-y-3" style={{ borderTop: `1px solid #EFE4CC`, paddingTop: 8 }}>
                        {[
                          {
                            label: "ストライク率",
                            meaning: "1投目で10本すべて倒すことを「ストライク」という",
                            formula: "計算式:ストライク数 ÷ 投球フレーム数(1ゲーム10フレーム。10フレーム目のボーナス球は分母に含めない)",
                          },
                          {
                            label: "スペア率",
                            meaning: "1投目で倒しきれなかった場合、2投目までの合計で10本すべて倒すことを「スペア」という",
                            formula: "計算式:スペア数 ÷ スペアチャンス数(1投目がストライクでなかったフレームの数)",
                          },
                          {
                            label: "オープンフレーム率",
                            meaning: "ストライクにもスペアにもならなかったフレームを「オープンフレーム」という(公式ルール上の用語)",
                            formula: "計算式:オープンフレーム数 ÷ 投球フレーム数",
                          },
                          {
                            label: "スプリット率",
                            meaning: "1投目でヘッドピン(1番ピン)が倒れ、かつ残ったピンが離れて立っている状態を「スプリット」という",
                            formula: "計算式:スプリット数 ÷ 投球フレーム数",
                          },
                          {
                            label: "スプリットカバー率",
                            meaning: "スプリットになったフレームで、2投目に残りすべてを倒してスペアにできることを「スプリットカバー」という",
                            formula: "計算式:スプリットカバー数 ÷ 1投目がスプリットになったフレームの数",
                          },
                          {
                            label: "ガター率",
                            meaning: "ピンに当たらず、レーン両端の溝(ガター)にボールが落ちることを「ガター」という",
                            formula: "計算式:ガター数 ÷ 投球した全ボール数",
                          },
                          {
                            label: "ファール率",
                            meaning: "投球時にファールラインを踏み越える、またはライン上の設備に触れることを「ファール」という(0本として記録される)",
                            formula: "計算式:ファール数 ÷ 投球した全ボール数",
                          },
                        ].map((row) => (
                          <div key={row.label}>
                            <div className="text-xs" style={{ color: COLORS.cream, fontWeight: 700 }}>{row.label}</div>
                            <div className="text-xs" style={{ color: COLORS.cream }}>{row.meaning}</div>
                            <div className="text-xs" style={{ color: COLORS.strike }}>{row.formula}</div>
                          </div>
                        ))}
                      </div>
                    </details>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {tab === "profile" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm" style={{ color: COLORS.strike }}>基本情報</div>
              {profileSaved && <span style={{ color: COLORS.strike, fontSize: 13 }}>保存しました</span>}
            </div>

            <div className="rounded-xl p-3 border glass-card space-y-3" style={{ borderColor: COLORS.oak }}>
              {myRequestNumber && (
                <div style={{ color: COLORS.cream, fontSize: 15, fontWeight: 700 }}>
                  ID:{formatRequestNumber(myRequestNumber)}
                </div>
              )}
              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.strike }}>ニックネーム</div>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  onBlur={(e) => saveProfile({ nickname: e.target.value })}
                  placeholder="例: ヤマダ"
                  className="w-full px-3 py-2 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
              </div>

              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.strike }}>利き手</div>
                <div className="flex gap-2">
                  {[
                    { key: "right", label: "右" },
                    { key: "left", label: "左" },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => {
                        setDominantHand(opt.key);
                        saveProfile({ dominantHand: opt.key });
                      }}
                      className="flex-1 rounded-lg py-2 text-sm"
                      style={toggleStyle(dominantHand === opt.key)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs mb-1 flex items-center gap-1" style={{ color: COLORS.strike }}>
                  <Target size={12} /> 目標アベレージ
                </div>
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={goalAverage}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setGoalAverage(e.target.value === "" ? "" : String(Math.min(300, Math.max(0, n))));
                  }}
                  onBlur={(e) => saveProfile({ goalAverage: e.target.value })}
                  placeholder="例: 150(最大300)"
                  className="w-full px-3 py-2 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
              </div>

              <div>
                <div className="text-xs mb-1 flex items-center gap-1" style={{ color: COLORS.strike }}>
                  <Target size={12} /> 目標スコア(ハイゲーム)
                </div>
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={goalScore}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setGoalScore(e.target.value === "" ? "" : String(Math.min(300, Math.max(0, n))));
                  }}
                  onBlur={(e) => saveProfile({ goalScore: e.target.value })}
                  placeholder="例: 200(最大300)"
                  className="w-full px-3 py-2 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
              </div>

              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.strike }}>ホームセンター(よく行くボウリング場)</div>
                <input
                  type="text"
                  value={homeCenter}
                  onChange={(e) => setHomeCenter(e.target.value)}
                  onBlur={(e) => saveProfile({ homeCenter: e.target.value })}
                  placeholder="例: 〇〇ボウル"
                  className="w-full px-3 py-2 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
              </div>
            </div>

            <div className="text-sm" style={{ color: COLORS.strike }}>登録済みのボール</div>

            <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
              {myBalls.length === 0 ? (
                <div className="p-3 text-xs text-center" style={{ color: COLORS.strike }}>
                  まだ登録されていません
                </div>
              ) : (
                myBalls.map((b, i) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between px-3 py-2"
                    style={{ borderTop: i === 0 ? "none" : `1px solid #EFE4CC` }}
                  >
                    <div className="flex-1">
                      {editingBallNameId === b.id ? (
                        <div className="space-y-2 mb-2">
                          <input
                            type="text"
                            value={ballNameDraft}
                            onChange={(e) => setBallNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveBallEdit(b.id, ballNameDraft, ballRoleDraft);
                            }}
                            enterKeyHint="done"
                            autoFocus
                            className="w-full px-3 py-2 rounded border"
                            style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16 }}
                          />
                          <div>
                            <div className="text-xs mb-1" style={{ color: COLORS.strike }}>用途</div>
                            <div className="flex gap-2">
                              {[
                                { key: "strike", label: "1stボール(ストライク)" },
                                { key: "spare", label: "スペアボール" },
                              ].map((o) => (
                                <button
                                  key={o.key}
                                  type="button"
                                  onClick={() => setBallRoleDraft(o.key)}
                                  className="flex-1 rounded-lg py-2 text-xs"
                                  style={toggleStyle(ballRoleDraft === o.key)}
                                >
                                  {o.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingBallNameId(null)}
                              className="flex-1 rounded-lg py-2 text-sm"
                              style={{ border: "1px solid rgba(184, 153, 104, 0.6)", color: COLORS.strike, fontWeight: 700 }}
                            >
                              キャンセル
                            </button>
                            <button
                              type="button"
                              onClick={() => saveBallEdit(b.id, ballNameDraft, ballRoleDraft)}
                              disabled={!ballNameDraft.trim()}
                              className="flex-1 rounded-lg py-2 text-sm"
                              style={primaryButtonStyle(!!ballNameDraft.trim())}
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm" style={{ color: COLORS.cream, fontWeight: 700 }}>
                          {b.label}
                          <span style={{ color: COLORS.strike, fontWeight: 400, fontSize: 13 }}>
                            {" "}
                            ({b.type === "house" ? "ハウスボール" : "マイボール"})
                          </span>
                        </div>
                      )}
                      <div className="text-xs" style={{ color: COLORS.strike }}>
                        {b.weight}lb{b.thumbless ? " ・ サムレス" : ""}
                      </div>
                      {(b.core || b.coverstock || b.motion || b.laneCondition) && (
                        <div className="text-xs" style={{ color: COLORS.strike }}>
                          {[
                            b.core && CORE_LABELS[b.core],
                            b.coverstock && COVERSTOCK_LABELS[b.coverstock],
                            b.motion && MOTION_LABELS[b.motion],
                            b.laneCondition && LANE_LABELS[b.laneCondition],
                          ]
                            .filter(Boolean)
                            .join(" ・ ")}
                        </div>
                      )}
                      {editingBallNameId !== b.id && (
                        <div className="mt-1.5">
                          {b.role ? (
                            <span
                              className="rounded-full px-2.5 py-0.5"
                              style={{ border: `1px solid ${COLORS.gold}`, color: COLORS.gold, fontSize: 11, fontWeight: 700 }}
                            >
                              {b.role === "strike" ? "1stボール" : "スペアボール"}
                            </span>
                          ) : (
                            <span style={{ color: COLORS.strike, opacity: 0.6, fontSize: 11 }}>用途:未設定(鉛筆マークから設定)</span>
                          )}
                        </div>
                      )}
                    </div>
                    {editingBallNameId !== b.id && (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => {
                            setEditingBallNameId(b.id);
                            setBallNameDraft(b.label);
                            setBallRoleDraft(b.role || null);
                          }}
                          aria-label="名前を編集"
                        >
                          <Pencil size={15} style={{ color: COLORS.strike }} />
                        </button>
                        <button onClick={() => deleteMyBall(b.id)} aria-label="削除">
                          <Trash2 size={16} style={{ color: COLORS.strike }} />
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
              <div className="text-xs" style={{ color: COLORS.strike }}>新しいボールを登録</div>

              <select
                value={newBallType}
                onChange={(e) => setNewBallType(e.target.value)}
                className="w-full px-3 py-2 rounded border text-sm"
                style={{ borderColor: COLORS.oak, color: COLORS.ink }}
              >
                <option value="own">マイボール</option>
                <option value="house">ハウスボール</option>
              </select>

              <div className="space-y-1">
                <div className="text-xs" style={{ color: COLORS.strike }}>用途</div>
                <div className="flex gap-2">
                  {[
                    { key: "strike", label: "1stボール(ストライク)" },
                    { key: "spare", label: "スペアボール" },
                  ].map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => setNewBallRole(o.key)}
                      className="flex-1 rounded-lg py-2 text-xs"
                      style={toggleStyle(newBallRole === o.key)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={newBallWeight}
                  onChange={(e) => setNewBallWeight(e.target.value)}
                  placeholder="重さ"
                  className="w-16 px-2 py-1 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
                <span className="text-xs" style={{ color: COLORS.strike }}>ポンド</span>
                <label className="flex items-center gap-1 text-xs" style={{ color: COLORS.cream }}>
                  <input
                    type="checkbox"
                    checked={newBallThumbless}
                    onChange={(e) => setNewBallThumbless(e.target.checked)}
                  />
                  サムレス
                </label>
              </div>

              {newBallType === "own" && (
                <>
                  <div>
                    <div className="text-xs mb-1" style={{ color: COLORS.strike }}>コアタイプ</div>
                    <select
                      value={newBallCore}
                      onChange={(e) => setNewBallCore(e.target.value)}
                      className="w-full px-3 py-2 rounded border text-sm"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    >
                      <option value="">選択しない</option>
                      <option value="symmetric">シンメトリック</option>
                      <option value="asymmetric">アシンメトリック</option>
                    </select>
                  </div>

                  <div>
                    <div className="text-xs mb-1" style={{ color: COLORS.strike }}>カバーストック</div>
                    <select
                      value={newBallCoverstock}
                      onChange={(e) => setNewBallCoverstock(e.target.value)}
                      className="w-full px-3 py-2 rounded border text-sm"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    >
                      <option value="">選択しない</option>
                      <option value="reactive">リアクティブレジン</option>
                      <option value="urethane">ウレタン</option>
                      <option value="plastic">プラスチック</option>
                      <option value="particle">パーティクル</option>
                    </select>
                  </div>

                  <div>
                    <div className="text-xs mb-1" style={{ color: COLORS.strike }}>球質(回転タイプ)</div>
                    <select
                      value={newBallMotion}
                      onChange={(e) => setNewBallMotion(e.target.value)}
                      className="w-full px-3 py-2 rounded border text-sm"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    >
                      <option value="">選択しない</option>
                      <option value="straight">ストレート</option>
                      <option value="mild_curve">マイルドカーブ</option>
                      <option value="hook">フック</option>
                      <option value="backup">バックアップ</option>
                    </select>
                  </div>

                  <div>
                    <div className="text-xs mb-1" style={{ color: COLORS.strike }}>適したレーンコンディション</div>
                    <select
                      value={newBallLaneCondition}
                      onChange={(e) => setNewBallLaneCondition(e.target.value)}
                      className="w-full px-3 py-2 rounded border text-sm"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    >
                      <option value="">選択しない</option>
                      <option value="dry">ドライレーン</option>
                      <option value="medium">ミディアムレーン</option>
                      <option value="oily">オイリーレーン</option>
                    </select>
                  </div>
                </>
              )}

              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.strike }}>登録名</div>
                <input
                  type="text"
                  value={newBallName}
                  onChange={(e) => setNewBallName(e.target.value)}
                  placeholder="例: メインボール(未入力なら自動で名付けます)"
                  className="w-full px-3 py-2 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
              </div>

              <button
                type="button"
                onClick={addMyBall}
                disabled={!newBallWeight}
                className="w-full rounded-lg py-2 text-sm"
                style={primaryButtonStyle(!!newBallWeight)}
              >
                追加する
              </button>
            </div>

            <div className="text-sm" style={{ color: COLORS.strike }}>登録済みのマイシューズ</div>

            <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
              {myShoes.length === 0 ? (
                <div className="p-3 text-xs text-center" style={{ color: COLORS.strike }}>
                  まだ登録されていません
                </div>
              ) : (
                myShoes.map((s, i) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between px-3 py-2"
                    style={{ borderTop: i === 0 ? "none" : `1px solid #EFE4CC` }}
                  >
                    {editingShoeNameId === s.id ? (
                      <div className="flex-1 space-y-2">
                          <input
                            type="text"
                            value={shoeNameDraft}
                            onChange={(e) => setShoeNameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") renameMyShoe(s.id, shoeNameDraft);
                            }}
                            enterKeyHint="done"
                            autoFocus
                            className="w-full px-3 py-2 rounded border"
                            style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16 }}
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingShoeNameId(null)}
                              className="flex-1 rounded-lg py-2 text-sm"
                              style={{ border: "1px solid rgba(184, 153, 104, 0.6)", color: COLORS.strike, fontWeight: 700 }}
                            >
                              キャンセル
                            </button>
                            <button
                              type="button"
                              onClick={() => renameMyShoe(s.id, shoeNameDraft)}
                              disabled={!shoeNameDraft.trim()}
                              className="flex-1 rounded-lg py-2 text-sm"
                              style={primaryButtonStyle(!!shoeNameDraft.trim())}
                            >
                              保存
                            </button>
                          </div>
                        </div>
                    ) : (
                      <>
                        <div className="text-sm" style={{ color: COLORS.cream, fontWeight: 700 }}>{s.label}</div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => {
                              setEditingShoeNameId(s.id);
                              setShoeNameDraft(s.label);
                            }}
                            aria-label="名前を編集"
                          >
                            <Pencil size={15} style={{ color: COLORS.strike }} />
                          </button>
                          <button onClick={() => deleteMyShoe(s.id)} aria-label="削除">
                            <Trash2 size={16} style={{ color: COLORS.strike }} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
              <div className="text-xs" style={{ color: COLORS.strike }}>新しいマイシューズを登録</div>

              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.strike }}>登録名</div>
                <input
                  type="text"
                  value={newShoeName}
                  onChange={(e) => setNewShoeName(e.target.value)}
                  placeholder="例: いつものシューズ"
                  className="w-full px-3 py-2 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
              </div>

              <button
                type="button"
                onClick={addMyShoe}
                disabled={!newShoeName.trim()}
                className="w-full rounded-lg py-2 text-sm"
                style={primaryButtonStyle(!!newShoeName.trim())}
              >
                追加する
              </button>
            </div>

            {authUser && (
              <>
                <div className="text-sm" style={{ color: COLORS.strike }}>アカウント</div>
                <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
                  <div className="text-xs" style={{ color: COLORS.strike }}>
                    ログイン中: {authUser.email}
                  </div>
                  <div className="text-xs" style={{ color: COLORS.strike, opacity: 0.7 }}>
                    この端末が、このアカウントの利用端末として登録されています。他の端末でログインすると、この端末は自動的にログアウトされます。
                  </div>
                  <button
                    type="button"
                    onClick={logoutAccount}
                    className="w-full rounded-lg py-2 text-sm"
                    style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.cream, fontWeight: 700 }}
                  >
                    ログアウト
                  </button>
                </div>
              </>
            )}

            <div className="text-sm" style={{ color: COLORS.strike }}>ご意見・要望</div>
            <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
              <textarea
                value={feedbackMessage}
                onChange={(e) => setFeedbackMessage(e.target.value)}
                placeholder="こんな機能が欲しい、ここが使いにくい、などお気軽にどうぞ"
                rows={4}
                className="w-full px-3 py-2 rounded border text-sm"
                style={{ borderColor: COLORS.oak, color: COLORS.ink }}
              />
              <button
                type="button"
                onClick={submitFeedback}
                disabled={feedbackSubmitting || !feedbackMessage.trim()}
                className="w-full rounded-lg py-2 text-sm flex items-center justify-center gap-2"
                style={{
                  background: COLORS.strike,
                  color: COLORS.ink,
                  fontWeight: 700,
                  opacity: feedbackMessage.trim() ? 1 : 0.5,
                }}
              >
                {feedbackSubmitting ? "送信中..." : feedbackSent ? "送信しました!" : "送信する"}
              </button>
            </div>

            <div className="flex items-center justify-center gap-2 pt-2 flex-nowrap" style={{ fontSize: 10, color: COLORS.strike, whiteSpace: "nowrap" }}>
              <a href="/terms" style={{ textDecoration: "underline" }}>利用規約</a>
              <a href="/privacy" style={{ textDecoration: "underline" }}>プライバシーポリシー</a>
              <a href="/tokushoho" style={{ textDecoration: "underline" }}>特定商取引法に基づく表記</a>
            </div>
          </div>
        )}
      </main>

      {/* bottom nav */}
      <nav
        className="fixed bottom-0 left-0 right-0 border-t"
        style={{ background: COLORS.ink, borderColor: COLORS.oak, paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="max-w-md mx-auto flex">
          {[
            { key: "scan", label: "スコア分析", icon: Camera },
            { key: "history", label: "履歴", icon: History },
            { key: "stats", label: "記録", icon: BarChart3 },
            { key: "profile", label: "設定", icon: Settings },
          ].map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className="flex-1 flex flex-col items-center gap-1 py-3"
                style={{ color: active ? COLORS.gold : COLORS.strike }}
              >
                <Icon size={20} />
                <span style={{ fontSize: 12 }}>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* help-chat button now lives in the header */}
      {chatOpen && (
        <div
          className="fixed left-0 right-0 top-0 flex flex-col"
          style={{
            // Track the visible area so the input stays above the keyboard.
            height: chatViewportHeight ? `${chatViewportHeight}px` : "100%",
            background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`,
            zIndex: 50,
          }}
        >
          <div
            className="flex items-center justify-between px-4"
            style={{
              background: COLORS.ink,
              // Keep the title clear of the notch / status bar.
              // env() is 0 on iPhones without a notch, where the status bar
              // still covers the top ~20px in app mode — so keep a minimum.
              paddingTop: "calc(16px + max(env(safe-area-inset-top), 20px))",
              paddingBottom: 16,
            }}
          >
            <div className="flex items-center gap-2">
              <MessageCircle size={20} style={{ color: COLORS.strike }} />
              <div style={{ color: COLORS.cream, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}>
                使い方サポート
              </div>
            </div>
            <button type="button" onClick={() => setChatOpen(false)} aria-label="閉じる">
              <X size={22} style={{ color: COLORS.cream }} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {chatMessages.length === 0 && (
              <div className="text-xs text-center py-6" style={{ color: COLORS.strike }}>
                アプリの使い方や、ストライク・スペアなどのボウリング用語について、気軽に聞いてください。
              </div>
            )}
            {chatMessages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className="rounded-xl px-3 py-2 text-sm"
                  style={{
                    maxWidth: "80%",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere", // long URLs wrap instead of spilling out
                    wordBreak: "break-word",
                    background: m.role === "user" ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                    color: COLORS.cream,
                    border: m.role === "user" ? "none" : `1px solid rgba(201, 162, 39, 0.28)`,
                    backdropFilter: m.role === "user" ? "none" : "blur(18px)",
                    WebkitBackdropFilter: m.role === "user" ? "none" : "blur(18px)",
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {chatSending && (
              <div className="flex justify-start">
                <div
                  className="glass-card rounded-xl px-3 py-2 text-sm flex items-center gap-2"
                  style={{ color: COLORS.strike }}
                >
                  <Loader2 className="animate-spin" size={14} /> 考え中...
                </div>
              </div>
            )}
            {chatError && (
              <div className="text-xs rounded-lg p-2" style={{ background: "#FBEAE5", color: COLORS.danger }}>
                {chatError}
              </div>
            )}
          </div>

          <div
            className="p-3 flex items-center gap-2"
            style={{
              borderTop: `1px solid ${COLORS.oak}`,
              background: COLORS.navyBg,
              paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
            }}
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendChatMessage();
                }
              }}
              placeholder="質問を入力"
              className="flex-1 px-3 py-2 rounded-lg border"
              style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16, minWidth: 0 }}
            />
            <button
              type="button"
              onClick={sendChatMessage}
              disabled={chatSending || !chatInput.trim()}
              className="rounded-lg px-3 py-2 flex items-center justify-center"
              style={{ background: COLORS.strike, color: COLORS.ink, opacity: chatInput.trim() ? 1 : 0.5, flexShrink: 0 }}
              aria-label="送信"
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
