import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Camera, History, BarChart3, Loader2, Check, X, Pencil, Trophy, TrendingUp, Calendar, CircleDot, Hash, User, Target, Trash2, ShieldCheck, CircleCheck, MessageCircle, Send, Settings, Crop, ImageOff, UserX, Bell, ImagePlus, ChevronDown, ChevronLeft, ChevronRight, Download, MapPin, Plus, Lock } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { auth } from "./firebaseClient.js";
import { TEXT_SIZES, readTextSize, applyTextSize, saveTextSize, usesCssZoom } from "./textSize.js";
import { noteLocalWrite, startSync, stopSync, scheduleFlush } from "./sync.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
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
    totalBalls,
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
// Monthly plan limits (see api/_plans.js). The server answers
// { error: "limit_reached", limit, resetsOn } once the month's count is used up.
function friendlyAiError(code, what, body) {
  if (code === "limit_reached") {
    const n = body?.limit ? `(${body.limit}回)` : "";
    return `今月の${what}の回数${n}を使い切りました。${body?.resetsOn || "来月1日"}に回数が戻ります。`;
  }
  if (code === "service_paused") return `ただいま${what}を一時停止しています。時間をおいて、もう一度お試しください。`;
  if (code === "busy") return `AIが混み合っています。少し時間をおいて、もう一度お試しください。`;
  if (code === "network") return `通信に失敗しました。電波の良い場所で、もう一度お試しください。`;
  return `${what}に失敗しました。時間をおいて、もう一度お試しください。`;
}

// The app component registers here to hear this month's updated count after
// each successful analysis / chat reply ({ feature, used, limit }).
let usageListener = null;
function setUsageListener(fn) {
  usageListener = fn;
}
function reportUsage(u) {
  if (u && usageListener) usageListener(u);
}

// プレミアム: finds the player's row on the full photo, so the analysis can
// be run on that row (crop + zoom) without the user boxing it by finger.
// Returns a crop rect in 0..1 photo coordinates, or null if not found / not
// available on this plan / anything went wrong (the app then falls back to
// boxing by finger). Never throws. Doesn't count toward the monthly limit.
//
// AI models are poor at guessing raw pixel coordinates, so the photo is sent
// with a numbered grid drawn over it (0〜100 down the side and across the
// top) and the AI answers by reading the grid numbers.
function renderLocateGrid(img) {
  const longSide = 1568;
  const scale = longSide / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const fs = Math.round(Math.max(w, h) / 70);
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 20; i++) {
    const major = i % 2 === 0; // labelled every 10, thin line every 5
    const y = Math.round((i / 20) * (h - 1));
    const x = Math.round((i / 20) * (w - 1));
    ctx.strokeStyle = major ? "rgba(255, 0, 255, 0.75)" : "rgba(255, 0, 255, 0.4)";
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (!major || i === 0 || i === 20) continue;
    const label = String(i * 5);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(255, 0, 255, 0.9)";
    ctx.fillRect(0, y - fs * 0.6, tw + 8, fs * 1.2); // left edge: Y
    ctx.fillRect(x - tw / 2 - 4, 0, tw + 8, fs * 1.2); // top edge: X
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, 4, y);
    ctx.fillText(label, x - tw / 2, fs * 0.6);
  }
  const url = canvas.toDataURL("image/jpeg", 0.92);
  return { base64: url.split(",")[1], mediaType: "image/jpeg" };
}

async function locatePlayerRow(img, playerName) {
  if (!img || !playerName) return null;
  try {
    const { base64, mediaType } = renderLocateGrid(img);
    const prompt = `これはボウリングのスコア画面(電光掲示板)またはスコアシートの写真です。位置を答えやすいように、ピンク色の目盛り線を重ねてあります。左端の数字が縦の位置(上端0〜下端100)、上端の数字が横の位置(左端0〜右端100)で、細い線は5刻みです。

次の2つを、目盛りの数字(0〜100)で答えてください。

A. スコア表示の枠全体の位置
電光掲示板なら画面(モニター)全体、紙なら記入欄の表全体の、上端・下端・左端・右端。隣に別のレーンの画面が写っている場合は、名前「${playerName}」がある方の画面だけ。

B. 名前「${playerName}」の文字の位置
表記ゆれ(ひらがな・カタカナ・ローマ字・大文字小文字・末尾に付く1文字の区分ラベルなど)も考慮して、最も一致する名前の文字の中心の縦・横の位置。

次のJSONだけを出力してください。
見つかった場合: {"found": true, "name_on_screen": "画面上の表記", "board_top": 数字, "board_bottom": 数字, "board_left": 数字, "board_right": 数字, "name_x": 数字, "name_y": 数字}
名前が見つからない、または候補が複数あってどれか判断できない場合: {"found": false}`;
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await usageHeaders()) },
      body: JSON.stringify({ images: [{ base64, mediaType }], prompt, purpose: "locate" }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = (data.content || []).find((b) => b.type === "text")?.text || "";
    const r = extractJson(text);
    if (!r || r.found !== true) return null;
    const pct = (v) => Number(v) / 100;
    const nameY = pct(r.name_y);
    if (!Number.isFinite(nameY) || nameY < 0 || nameY > 1) return null;
    let bTop = pct(r.board_top);
    let bBottom = pct(r.board_bottom);
    let bLeft = pct(r.board_left);
    let bRight = pct(r.board_right);
    if (![bTop, bBottom, bLeft, bRight].every(Number.isFinite) || bBottom <= bTop || bRight <= bLeft) {
      bTop = 0;
      bBottom = 1;
      bLeft = 0;
      bRight = 1;
    }
    // A pinpoint box from the AI is too unreliable (it cut off the scores
    // and the total in testing), so we only rely on two things it finds
    // well: the whole score display, and roughly where the name is. The
    // crop is the full width of the display (so the total is never cut),
    // from the top of the display down to well below the name, so the marks
    // and cumulative scores underneath are always inside. If it also catches
    // other players' rows, the analysis still picks the right row by name.
    const boardH = bBottom - bTop;
    const x1 = Math.max(0, bLeft - 0.02);
    const x2 = Math.min(1, bRight + 0.02);
    // Top: always the top of the display. When the display is small in the
    // photo, the name's position can be off by a whole row, so starting from
    // the top edge means our row is never cut off above. Bottom: well below
    // the name (about two players' worth).
    const y1 = Math.max(0, bTop - 0.01);
    const y2 = Math.min(1, Math.min(bBottom + 0.01, nameY + Math.max(0.08, boardH * 0.3)));
    const rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    // Ignore boxes that are clearly not a score row (tiny, or most of the photo).
    if (rect.w < 0.15 || rect.h < 0.02 || rect.w * rect.h > 0.85) return null;
    return rect;
  } catch (e) {
    return null;
  }
}

// recheck: a second look after the first reading didn't add up — the note
// tells the AI what looked wrong. It's part of the same analysis, so it
// doesn't count toward the monthly limit (purpose "recheck").
async function analyzeScoreImage(images, playerName, { cropped = false, zoomed = false, recheckNote = "" } = {}) {
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
1-2. 投球の記号を読む前に、対象プレイヤーの「累計スコアの段」(各フレームの下段の大きな数字)を、1フレーム目から順に、画面に表示されているとおり書き写して screen_cumulative に入れる。計算はせず、見えている数字をそのまま写すこと。累計は必ず左から右へ増えていく。表示されていないフレームは null。この数字が、このあとすべての検算の基準になる
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
      "screen_cumulative": [17, 37, 46, "...10フレーム目まで、画面の表示どおり"],
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
- score は、screen_cumulative に書き写した数字と必ず同じにする。画面に表示されている各フレームの累計スコアの数字を、そのまま書き写す(自分で計算し直した値ではなく、表示どおりの値。投球記号の読み取りと矛盾していても、表示どおりの数字を書くこと)。10フレーム目まで画像に表示されている場合は、必ず10個分のscoreを埋めること。最終フレームの累計が画面上の「TOTAL」の値と一致するか必ず確認する
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
      body: JSON.stringify({ images, prompt: recheckNote ? `${prompt}\n\n${recheckNote}` : prompt, ...(recheckNote ? { purpose: "recheck" } : {}) }),
    });
  } catch (networkErr) {
    throw new Error(friendlyAiError("network", "スコア解析"));
  }

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      // body wasn't JSON — fall through to the generic message
    }
    throw new Error(friendlyAiError(body?.error || "", "スコア解析", body));
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

  reportUsage(data._usage);
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
    <div className="score-sheet flex w-full overflow-x-auto pb-1" style={{ gap: 2 }}>
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

// ---------- compact score sheet (all 10 frames at once, read-only) ----------
// Used in the 記録 tab's day view, where games are stacked one above another
// like a bowling center's score printout: every frame fits the width, so
// nothing needs sideways scrolling. Columns share the width (10th frame a
// bit wider for its 3 rolls), so it also fits when the text size is large.
function CompactScoreSheet({ frames }) {
  const ink = COLORS.ink;
  const line = `1px solid ${ink}`;
  const cols = "repeat(9, minmax(0, 1fr)) minmax(0, 1.45fr)";
  const mark = (val, split, key, last) => {
    let content = null;
    if (val === "X") {
      content = (
        <svg viewBox="0 0 17 17" style={{ width: "72%", maxWidth: 13, height: "auto", display: "block" }}>
          <polygon points="2,2 2,15 8.5,8.5" fill={ink} />
          <polygon points="15,2 15,15 8.5,8.5" fill={ink} />
        </svg>
      );
    } else if (val === "/") {
      content = (
        <svg viewBox="0 0 17 17" style={{ width: "72%", maxWidth: 13, height: "auto", display: "block" }}>
          <polygon points="2,15 15,15 15,2" fill={ink} />
        </svg>
      );
    } else if (val !== undefined && val !== "") {
      content = val === "0" ? "-" : val;
    }
    return (
      <div
        key={key}
        className="flex items-center justify-center"
        style={{ flex: 1, minWidth: 0, borderLeft: key > 0 ? line : "none", height: 22 }}
      >
        {split && content !== null ? (
          <span
            className="flex items-center justify-center"
            style={{ width: "1.35em", height: "1.35em", borderRadius: "50%", border: `1.2px solid ${ink}`, fontSize: "0.85em", lineHeight: 1 }}
          >
            {content}
          </span>
        ) : (
          content
        )}
      </div>
    );
  };
  return (
    <div
      className="score-sheet"
      style={{
        display: "grid",
        gridTemplateColumns: cols,
        border: `1.5px solid ${ink}`,
        background: COLORS.cream,
        color: ink,
        fontFamily: "'Oswald', sans-serif",
        fontWeight: 700,
        width: "100%",
        // Text sizes follow the sheet's own width (cqi), so 3-digit scores
        // never spill into the next frame, even with large text settings.
        containerType: "inline-size",
      }}
    >
      {Array.from({ length: 10 }).map((_, i) => {
        const f = frames?.[i];
        const rolls = f?.rolls || [];
        const splitRolls = f?.splitRolls || [];
        const slots = i === 9 ? 3 : 2;
        return (
          <div key={i} style={{ borderLeft: i > 0 ? line : "none", minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div className="text-center" style={{ fontSize: 11, lineHeight: "16px", background: "#E4DAC4", borderBottom: line }}>
              {i + 1}
            </div>
            <div className="flex" style={{ fontSize: "min(13px, 3.9cqi)", borderBottom: line }}>
              {Array.from({ length: slots }).map((_, k) => mark(rolls[k], !!splitRolls[k], k))}
            </div>
            <div className="text-center" style={{ fontSize: "min(15px, 4.1cqi)", lineHeight: "26px", whiteSpace: "nowrap" }}>
              {f?.score ?? ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One line of totals for a set of games (a day): ゲーム数・トータル・アベレージ・ハイ.
function daySummary(games) {
  const totals = games.map((g) => Number(g.total)).filter((n) => Number.isFinite(n));
  const sum = totals.reduce((a, b) => a + b, 0);
  return {
    count: games.length,
    sum,
    avg: totals.length ? Math.round((sum / totals.length) * 10) / 10 : null,
    high: totals.length ? Math.max(...totals) : null,
  };
}

function DayTotals({ games, compact = false }) {
  const d = daySummary(games);
  const item = (label, value, strong) => (
    <div className="flex flex-col items-center" style={{ minWidth: 0, flex: 1 }}>
      <span style={{ color: COLORS.strike, opacity: 0.75, fontSize: 11, whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: compact ? 17 : 20, color: strong ? COLORS.gold : COLORS.cream, lineHeight: 1.2 }}>
        {value ?? "ー"}
      </span>
    </div>
  );
  return (
    <div className="flex items-stretch" style={{ gap: 4 }}>
      {item("ゲーム数", d.count)}
      {item("トータル", d.sum, true)}
      {item("アベレージ", d.avg)}
      {item("ハイ", d.high)}
    </div>
  );
}

// "2026-10-22" → "10/22(木)"
function formatDayLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return dateStr || "日付なし";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${+m[2]}/${+m[3]}(${"日月火水木金土"[d.getUTCDay()]})`;
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

      <div className="roll-nums grid grid-cols-6 gap-1">
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

      <div className="roll-special grid grid-cols-5 gap-1">
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

// ---------- お知らせの表示 ----------
// Bell = two levels, like most apps: a list of titles → tap one for the detail.
function AnnouncementMeta({ a }) {
  return (
    <div className="flex items-center gap-2">
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          padding: "2px 9px",
          borderRadius: 999,
          background: a.type === "event" ? COLORS.gold : "rgba(255,255,255,0.14)",
          color: a.type === "event" ? COLORS.ink : COLORS.strike,
          flexShrink: 0,
        }}
      >
        {ANNOUNCEMENT_TYPE_LABEL[a.type] || "お知らせ"}
      </span>
      <span style={{ color: COLORS.strike, opacity: 0.75, fontSize: 13 }}>
        {a.type === "event" && a.endDate
          ? `${a.startDate ? formatMonthDay(a.startDate) : ""}〜${formatMonthDay(a.endDate)}`
          : formatMonthDay(a.startDate || (a.createdAt || "").slice(0, 10))}
      </span>
    </div>
  );
}

// Body text with a tiny bit of structure so it reads at a glance:
//   "## 見出し" → small heading,  "- 項目" or "・項目" → bullet,  blank line → gap.
// Anything else is a normal paragraph, so plain text from the admin screen works as before.
function AnnouncementBody({ text }) {
  const blocks = [];
  let list = null;
  String(text || "")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      const bullet = line.match(/^(?:-|・)\s*(.+)$/);
      if (bullet) {
        if (!list) {
          list = { kind: "list", items: [], key: i };
          blocks.push(list);
        }
        list.items.push(bullet[1]);
        return;
      }
      list = null;
      if (!line) return;
      const h = line.match(/^##\s*(.+)$/);
      blocks.push(h ? { kind: "h", text: h[1], key: i } : { kind: "p", text: line, key: i });
    });
  return (
    <div style={{ color: COLORS.cream, fontSize: 15, lineHeight: 1.75, overflowWrap: "anywhere" }}>
      {blocks.map((b, idx) =>
        b.kind === "h" ? (
          <div
            key={b.key}
            style={{ color: COLORS.gold, fontWeight: 700, fontSize: 15, marginTop: idx === 0 ? 0 : 20, marginBottom: 6 }}
          >
            {b.text}
          </div>
        ) : b.kind === "list" ? (
          <ul key={b.key} style={{ margin: idx === 0 ? 0 : "6px 0 0", padding: 0, listStyle: "none" }}>
            {b.items.map((t, j) => (
              <li key={j} className="flex" style={{ gap: 8, marginTop: j === 0 ? 0 : 4 }}>
                <span style={{ color: COLORS.gold, flexShrink: 0 }}>•</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={b.key} style={{ margin: idx === 0 ? 0 : "10px 0 0" }}>
            {b.text}
          </p>
        )
      )}
    </div>
  );
}

// One line in the bell list: unread dot, kind + date, title, and a thumbnail for events.
function AnnouncementListRow({ a, unread, onOpen, imageSrc }) {
  const src = imageSrc || (a.hasImage ? announcementImageUrl(a) : null);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="glass-card rounded-xl w-full text-left flex items-center"
      style={{ padding: "14px 12px 14px 14px", gap: 12 }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: 999, background: unread ? "#E8836A" : "transparent", flexShrink: 0 }}
      />
      <div className="flex-1" style={{ minWidth: 0 }}>
        <AnnouncementMeta a={a} />
        <div
          style={{
            color: COLORS.cream,
            fontWeight: unread ? 700 : 500,
            fontSize: 16,
            lineHeight: 1.45,
            marginTop: 6,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            textWrap: "balance",
          }}
        >
          {a.title}
        </div>
      </div>
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8, flexShrink: 0 }}
        />
      )}
      <ChevronRight size={20} style={{ color: COLORS.strike, opacity: 0.6, flexShrink: 0 }} />
    </button>
  );
}

// The detail page of one announcement (also used for the admin preview).
function AnnouncementDetail({ a, imageSrc }) {
  const src = imageSrc || (a.hasImage ? announcementImageUrl(a) : null);
  return (
    <div className="space-y-4">
      <div>
        <AnnouncementMeta a={a} />
        <div style={{ color: COLORS.cream, fontWeight: 700, fontSize: 20, lineHeight: 1.45, marginTop: 8, overflowWrap: "anywhere", textWrap: "balance" }}>
          {a.title}
        </div>
      </div>
      {src && <img src={src} alt={a.title} style={{ width: "100%", borderRadius: 10, display: "block" }} />}
      {a.body && (
        <div className="glass-card rounded-xl" style={{ padding: 16 }}>
          <AnnouncementBody text={a.body} />
        </div>
      )}
    </div>
  );
}

// ---------- SERIES BATTLE(3ゲーム合計で競うイベント) ----------
// 「参加する」を押した人が、履歴から3ゲームを選んで提出する。
// ベストの3ゲーム合計で順位が決まる。同点はハイとローの差が小さい方が上。
const DUEL_ERRORS = {
  not_synced: "記録をクラウドに保存中です。少し待ってからもう一度お試しください",
  already_submitted: "この3ゲームはすでに提出済みです",
  not_participant: "先に「参加する」を押してください",
  out_of_period: "イベント期間外のゲームです",
  ended: "イベントは終了しました",
  not_started: "イベントはまだ始まっていません",
};

async function duelFetch(authUser, deviceId, payload) {
  const token = await authUser.getIdToken();
  const res = await fetch(payload ? "/api/data" : "/api/data?duel=1", {
    method: payload ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "X-Device-Id": deviceId, ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(DUEL_ERRORS[d.error] || "うまくいきませんでした。時間をおいてお試しください");
  return d;
}

function daysBetween(a, b) {
  const t = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86400000);
}

// [表示名, キー, 良い方向("high"=多いほど良い / "low"=少ないほど良い / null=比べない)]

function DuelPickSheet({ games, duel, mine, authUser, deviceId, onClose, onDone }) {
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submittedIds = new Set(mine.flatMap((e) => e.gameIds || []));
  const inPeriod = games.filter((g) => (!duel.startDate || g.date >= duel.startDate) && (!duel.endDate || g.date <= duel.endDate));
  const dates = Array.from(new Set(inPeriod.map((g) => g.date))).sort().reverse();
  const chosen = picked.map((id) => games.find((g) => g.id === id)).filter(Boolean);
  const valid = chosen.length === 3;
  const total = chosen.reduce((a, g) => a + (g.total || 0), 0);
  const roundDate = valid ? chosen.map((g) => g.date).sort().pop() : null;
  const replaces = !!roundDate && mine.some((e) => e.date === roundDate);
  const hint =
    chosen.length < 3
      ? `3ゲームを選んでください(${chosen.length}/3)`
      : `合計 ${total} ・ アベレージ ${(total / 3).toFixed(1)}`;

  const toggle = (id) => {
    setError("");
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 3 ? cur : [...cur, id]));
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      const st = computeGameSetStats(chosen);
      await duelFetch(authUser, deviceId, {
        action: "duelSubmit",
        gameIds: chosen.map((g) => g.id),
        stats: {
          strikes: st.strikeCount,
          spares: st.spareCount,
          opens: st.openFrameCount,
          splits: st.splitCount,
          splitCovers: st.splitCoverCount,
          splitChances: st.splitOpenCount,
          gutters: st.gutterCount,
          frames: st.frameCount,
          spareChances: st.spareChances,
          balls: st.totalBalls,
        },
      });
      onDone();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  // #root 直下に出す(タブの中だと、画面のアニメーションの影響で位置がずれることがあるため。
  // body ではなく #root なのは、文字の大きさの拡大を効かせるため)
  return createPortal(
    <div
      className="fixed left-0 right-0 top-0 bottom-0 flex flex-col"
      style={{ background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, zIndex: 52 }}
    >
      <div
        className="flex items-center justify-between px-4"
        style={{ background: COLORS.ink, paddingTop: "calc(16px + max(env(safe-area-inset-top), 20px))", paddingBottom: 16 }}
      >
        <div style={{ color: COLORS.cream, fontWeight: 700 }}>提出する3ゲームを選ぶ</div>
        <button type="button" onClick={onClose} aria-label="閉じる">
          <X size={22} style={{ color: COLORS.cream }} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {dates.length === 0 && (
          <div className="text-center py-10" style={{ color: COLORS.strike, opacity: 0.85, fontSize: 14 }}>
            イベント期間の記録がまだありません
          </div>
        )}
        {dates.map((d) => (
          <div key={d} className="space-y-2">
            <div style={{ color: COLORS.gold, fontWeight: 700, fontSize: 15 }}>{formatMonthDay(d)}</div>
            {inPeriod
              .filter((g) => g.date === d)
              .sort((a, b) => (a.gameNumber || 0) - (b.gameNumber || 0) || (a.createdAt || 0) - (b.createdAt || 0))
              .map((g) => {
                const on = picked.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggle(g.id)}
                    className="glass-card rounded-xl w-full flex items-center gap-3 text-left"
                    style={{ padding: "12px 14px", border: on ? `1.5px solid ${COLORS.gold}` : undefined }}
                  >
                    <span
                      className="flex items-center justify-center"
                      style={{ width: 24, height: 24, borderRadius: 999, border: `1.5px solid ${on ? COLORS.gold : "rgba(255,255,255,0.4)"}`, background: on ? COLORS.gold : "transparent", flexShrink: 0 }}
                    >
                      {on && <Check size={15} style={{ color: COLORS.ink }} />}
                    </span>
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <div style={{ color: COLORS.cream, fontSize: 15, fontWeight: 700 }}>{g.gameNumber || 1}ゲーム目</div>
                      {submittedIds.has(g.id) && <div style={{ color: COLORS.gold, fontSize: 12.5 }}>提出済み</div>}
                    </div>
                    <div style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22 }}>{g.total}</div>
                  </button>
                );
              })}
          </div>
        ))}
      </div>
      <div
        className="px-4 pt-3 space-y-2"
        style={{ background: COLORS.ink, paddingBottom: "calc(14px + env(safe-area-inset-bottom))", borderTop: "1px solid rgba(224,168,0,0.3)" }}
      >
        <div style={{ color: valid ? COLORS.gold : COLORS.cream, fontWeight: 700, fontSize: 14.5, textAlign: "center" }}>{hint}</div>
        {replaces && (
          <div style={{ color: COLORS.strike, fontSize: 13, textAlign: "center" }}>
            <Phrases text={`${formatMonthDay(roundDate)}は提出済みです。|提出すると入れ替わります`} />
          </div>
        )}
        {error && <div style={{ color: "#E8836A", fontSize: 13, textAlign: "center" }}>{error}</div>}
        <button type="button" onClick={submit} disabled={!valid || busy} className="w-full rounded-lg py-3" style={primaryButtonStyle(valid && !busy)}>
          {busy ? "提出中..." : "この3ゲームを提出する"}
        </button>
      </div>
    </div>,
    document.getElementById("root") || document.body
  );
}

// 成績比較の2位の色(1位は金)。白い文字と見分けやすい、青みのある銀色
const DUEL_SILVER = "#9DC3EA";

function DuelPanel({ authUser, deviceId, games, data, reload }) {
  const [picking, setPicking] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const [error, setError] = useState("");
  const [view, setView] = useState("overall"); // "overall" | 回の日付
  const phase = data.today < data.startDate ? "before" : data.today > data.endDate ? "after" : "live";
  const phaseLabel = { before: "開始前", live: "開催中", after: "終了" }[phase];
  const rounds = data.rounds || [];
  const overall = data.overall || [];
  const medal = ["#E0A800", "#C8CDD6", "#C98A5A"];
  const round = view === "overall" ? null : rounds.find((r) => r.date === view);
  useEffect(() => {
    if (view !== "overall" && !round) setView("overall");
  }, [view, round]);

  const remove = async (id) => {
    setError("");
    try {
      await duelFetch(authUser, deviceId, { action: "duelDelete", id });
      setConfirmId(null);
      reload();
    } catch (e) {
      setError(e.message);
    }
  };

  // 比較に使う成績(通算は合算、回ごとはその回の提出)
  const rows = round
    ? round.board.map((r) => ({ name: r.name, rank: r.rank, isMe: r.isMe, s: r.entry }))
    : overall.map((r) => ({ name: r.name, rank: r.rank, isMe: r.isMe, s: r.sum }));
  const pctOf = (a, b) => (b > 0 ? (a / b) * 100 : null);
  const cmpRows = [
    [round ? "トータル" : "平均トータル", (s) => (round ? s.total : s.avgTotal), "high", (v) => (round ? `${v}` : Number(v).toFixed(1))],
    ["アベレージ", (s) => s.avg, "high", (v) => Number(v).toFixed(1)],
    ["ストライク率", (s) => pctOf(s.strikes, s.frames), "high"],
    ["スペア率", (s) => pctOf(s.spares, s.spareChances), "high"],
    ["オープン率", (s) => pctOf(s.opens, s.frames), "low"],
    ["スプリット率", (s) => pctOf(s.splits, s.frames), "low"],
    ["スプリットカバー率", (s) => pctOf(s.splitCovers, s.splitChances), "high"],
    ["ガター率", (s) => pctOf(s.gutters, s.balls), "low"],
  ];
  const fmtPct = (v) => `${Math.round(v)}%`;
  const colStyle = { width: `${Math.floor(60 / Math.max(rows.length, 1))}%`, textAlign: "center", padding: "7px 2px" };

  const chip = (key, label) => (
    <button
      key={key}
      type="button"
      onClick={() => setView(key)}
      className="rounded-full"
      style={{
        padding: "6px 14px",
        fontSize: 13.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
        flexShrink: 0,
        border: view === key ? `1.5px solid ${COLORS.gold}` : "1px solid rgba(245,241,228,0.25)",
        background: view === key ? "rgba(224,168,0,0.15)" : "transparent",
        color: view === key ? COLORS.gold : COLORS.strike,
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-xl" style={{ padding: 14 }}>
        <div className="flex items-center justify-between gap-2">
          <DuelTitle info={data} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "2px 10px",
              borderRadius: 999,
              flexShrink: 0,
              whiteSpace: "nowrap",
              background: phase === "live" ? COLORS.gold : "rgba(255,255,255,0.14)",
              color: phase === "live" ? COLORS.ink : COLORS.strike,
            }}
          >
            {phaseLabel}
          </span>
        </div>
        <div style={{ color: COLORS.strike, fontSize: 13.5, marginTop: 6 }}>
          {formatMonthDay(data.startDate)}〜{formatMonthDay(data.endDate)}
          {phase === "live" && `(あと${daysBetween(data.today, data.endDate)}日)`}
          {rounds.length > 0 && ` ・ ${rounds.length}回終了`}
        </div>
      </div>

      {/* 通算 / 回ごと の切り替え */}
      <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {chip("overall", "通算")}
        {rounds.map((r, i) => chip(r.date, `第${rounds.length - i}回 ${formatMonthDay(r.date)}`))}
      </div>

      <div className="space-y-2">
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl"
            style={{
              padding: "12px 14px",
              background: r.isMe ? "rgba(224,168,0,0.12)" : "rgba(10, 16, 34, 0.55)",
              border: r.isMe ? `1.5px solid ${COLORS.gold}` : "1px solid rgba(224,168,0,0.2)",
            }}
          >
            <div style={{ width: 30, flexShrink: 0, textAlign: "center" }}>
              {r.rank && r.rank <= 3 ? (
                <Trophy size={22} style={{ color: medal[r.rank - 1], margin: "0 auto" }} />
              ) : (
                <span style={{ color: COLORS.strike, opacity: 0.6, fontSize: 16 }}>ー</span>
              )}
            </div>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <div style={{ color: COLORS.cream, fontWeight: 700, fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
                {r.isMe && <span style={{ color: COLORS.gold, fontSize: 12.5 }}> あなた</span>}
              </div>
              <div style={{ color: COLORS.strike, opacity: 0.85, fontSize: 13 }}>
                {!r.s
                  ? round
                    ? "この回は未提出"
                    : "まだ提出なし"
                  : round
                  ? r.s.scores.join(" / ")
                  : <Phrases text={`${r.s.rounds}回参加 ・ |ベスト ${r.s.bestTotal}`} />}
              </div>
            </div>
            {r.s && (
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ color: r.rank === 1 ? COLORS.gold : COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 26, lineHeight: 1.1 }}>
                  {round ? r.s.total : Number(r.s.avgTotal).toFixed(1)}
                </div>
                <div style={{ color: COLORS.strike, opacity: 0.85, fontSize: 12.5 }}>
                  {round ? `平均 ${Number(r.s.avg).toFixed(1)}` : "合計の平均"}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {rows.some((r) => r.s) && (
        <div className="glass-card rounded-xl" style={{ padding: "12px 10px" }}>
          <div style={{ color: COLORS.gold, fontWeight: 700, fontSize: 15, padding: "0 4px 6px" }}>
            成績比較<span style={{ color: COLORS.strike, fontWeight: 500, fontSize: 12.5 }}> {round ? `第${rounds.length - rounds.indexOf(round)}回 ${formatMonthDay(round.date)}` : "通算"}</span>
          </div>
          <div className="flex items-center gap-3" style={{ padding: "0 4px 6px", fontSize: 12 }}>
            <span style={{ color: COLORS.gold, fontWeight: 700 }}>● 1位</span>
            <span style={{ color: DUEL_SILVER, fontWeight: 700 }}>● 2位</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ width: "40%" }} />
                {rows.map((r, i) => (
                  <th key={i} style={{ ...colStyle, color: COLORS.cream, fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cmpRows.map(([label, get, dir, fmt]) => {
                const vals = rows.map((r) => (r.s ? get(r.s) : null));
                const key = (v) => Math.round(v * 10);
                const ok = vals.filter((v) => v !== null && Number.isFinite(v));
                // 良い順に並べた値(同じ値は同じ順位)。1位=金、2位=銀
                const order = ok.length >= 2 ? [...new Set(ok.map(key))].sort((a, b) => (dir === "high" ? b - a : a - b)) : [];
                return (
                  <tr key={label} style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                    <td style={{ color: COLORS.strike, fontSize: 13, padding: "7px 4px", wordBreak: "keep-all", lineHeight: 1.3 }}>
                      {label === "スプリットカバー率" ? (
                        <>
                          スプリット<wbr />カバー率
                        </>
                      ) : (
                        label
                      )}
                    </td>
                    {vals.map((v, i) => {
                      const place = v !== null && Number.isFinite(v) ? order.indexOf(key(v)) : -1;
                      const color = place === 0 ? COLORS.gold : place === 1 ? DUEL_SILVER : COLORS.cream;
                      return (
                        <td key={i} style={{ ...colStyle, color, fontWeight: place === 0 || place === 1 ? 700 : 500, fontSize: 15 }}>
                          {v === null || !Number.isFinite(v) ? "ー" : (fmt || fmtPct)(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {phase === "live" && (
        <button type="button" onClick={() => setPicking(true)} className="w-full rounded-lg py-3" style={primaryButtonStyle()}>
          3ゲームを提出する
        </button>
      )}
      {phase === "before" && (
        <div className="text-center" style={{ color: COLORS.strike, fontSize: 14 }}>
          {formatMonthDay(data.startDate)}から提出できます
        </div>
      )}

      {error && <div style={{ color: "#E8836A", fontSize: 13 }}>{error}</div>}

      {data.mine.length > 0 && (
        <div className="space-y-2">
          <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14 }}>あなたの提出</div>
          {data.mine.map((e) => (
            <div key={e.id} className="glass-card rounded-xl" style={{ padding: "10px 14px" }}>
              <div className="flex items-center gap-3">
                <div className="flex-1" style={{ minWidth: 0 }}>
                  <div style={{ color: COLORS.cream, fontSize: 14.5, fontWeight: 700 }}>
                    {formatMonthDay(e.date)} ・ {e.scores.join(" / ")}
                  </div>
                </div>
                <div style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20 }}>{e.total}</div>
                {phase === "live" && (
                  <button type="button" onClick={() => setConfirmId(confirmId === e.id ? null : e.id)} aria-label="取り消す" style={{ padding: 6 }}>
                    <Trash2 size={17} style={{ color: COLORS.strike, opacity: 0.8 }} />
                  </button>
                )}
              </div>
              {confirmId === e.id && (
                <div className="flex items-center justify-between rounded-lg" style={{ marginTop: 8, padding: "8px 10px", background: "#FBEAE5" }}>
                  <span style={{ color: COLORS.danger, fontWeight: 700, fontSize: 13 }}>この提出を取り消しますか?</span>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setConfirmId(null)} className="rounded px-2 py-1 border text-xs" style={{ borderColor: COLORS.oak, color: COLORS.ink }}>
                      やめる
                    </button>
                    <button type="button" onClick={() => remove(e.id)} className="rounded px-2 py-1 text-xs" style={{ background: COLORS.danger, color: "white", fontWeight: 700 }}>
                      取り消す
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {picking && (
        <DuelPickSheet
          games={games}
          duel={data}
          mine={data.mine}
          authUser={authUser}
          deviceId={deviceId}
          onClose={() => setPicking(false)}
          onDone={() => {
            setPicking(false);
            reload();
          }}
        />
      )}
      <DuelRules />
    </div>
  );
}

// 文章を「|」の位置(文節の区切り)でだけ折り返す。文字が大きい時に、
// 行末に1〜2文字だけ取り残される不自然な折り返しを防ぐ。
function Phrases({ text }) {
  return text.split("|").map((t, i) => (
    <span key={i} style={{ display: "inline-block" }}>
      {t}
    </span>
  ));
}

// イベント名(大きく)と大会名(小さく)
function DuelTitle({ info, size = 18 }) {
  return (
    <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
      <Trophy size={size} style={{ color: COLORS.gold, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: COLORS.gold, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: size, letterSpacing: 1, lineHeight: 1.2, whiteSpace: "nowrap" }}>
          {info.name || "SERIES BATTLE"}
        </div>
        <div style={{ color: COLORS.cream, fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{info.title}</div>
      </div>
    </div>
  );
}

// イベントのルール(お知らせと同じ内容を短く)
function DuelRules() {
  const sections = [
    ["ルール", ["提出する3ゲームは|3人で決める", "決めた3ゲームを|履歴から選んで提出", "同じ日に出し直すと、|前の提出と入れ替わる", "提出の取り消しも|できる"]],
    ["順位", ["回ごと:|3ゲームの合計が|高い順", "通算:|参加した回の|合計の平均が高い順", "同点は、|ハイとローの差が|小さい方が上"]],
  ];
  return (
    <div className="glass-card rounded-xl space-y-3" style={{ padding: 14 }}>
      {sections.map(([h, items]) => (
        <div key={h}>
          <div style={{ color: COLORS.gold, fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>{h}</div>
          {items.map((t) => (
            <div key={t} className="flex gap-2" style={{ color: COLORS.cream, fontSize: 14, lineHeight: 1.7 }}>
              <span style={{ color: COLORS.gold }}>•</span>
              <span>
                <Phrases text={t} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// 参加前: 開催情報と参加ボタン
function DuelJoinCard({ info, onJoin }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ended = info.today > info.endDate;
  const join = async () => {
    setBusy(true);
    setError("");
    try {
      await onJoin();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="glass-card rounded-xl space-y-3" style={{ padding: 16 }}>
        <DuelTitle info={info} />
        <div style={{ color: COLORS.strike, fontSize: 14 }}>
          {formatMonthDay(info.startDate)}〜{formatMonthDay(info.endDate)}
        </div>
        <div style={{ color: COLORS.cream, fontSize: 15, lineHeight: 1.7 }}><Phrases text="3ゲームの合計スコアで|競います。|参加すると、|参加者の成績を|見くらべられます。" /></div>
        {!ended && (
          <button type="button" onClick={join} disabled={busy} className="w-full rounded-lg py-3" style={primaryButtonStyle(!busy)}>
            {busy ? "参加中..." : "参加する"}
          </button>
        )}
        {error && <div style={{ color: "#E8836A", fontSize: 13 }}>{error}</div>}
      </div>
      <DuelRules />
    </div>
  );
}

// イベント一覧の1行(押すと詳細)
function EventListRow({ info, onOpen }) {
  const phase = info.today < info.startDate ? "before" : info.today > info.endDate ? "after" : "live";
  const phaseLabel = { before: "開始前", live: "開催中", after: "終了" }[phase];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full glass-card rounded-xl flex items-center gap-3 text-left"
      style={{ padding: "14px 14px" }}
    >
      <div className="flex-1 space-y-1" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-2">
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "2px 9px",
              borderRadius: 999,
              background: phase === "live" ? COLORS.gold : "rgba(255,255,255,0.14)",
              color: phase === "live" ? COLORS.ink : COLORS.strike,
            }}
          >
            {phaseLabel}
          </span>
          <span style={{ color: COLORS.strike, fontSize: 13 }}>
            {formatMonthDay(info.startDate)}〜{formatMonthDay(info.endDate)}
          </span>
          {info.participant && <span style={{ color: COLORS.gold, fontSize: 12.5, fontWeight: 700 }}>参加中</span>}
        </div>
        <DuelTitle info={info} size={17} />
      </div>
      <ChevronRight size={20} style={{ color: COLORS.strike, flexShrink: 0 }} />
    </button>
  );
}

// ランキングタブ: 対象の人には「月間ランキング / イベント」の切り替えを出す。
// イベントは「一覧 → 押すと内容」の2階層。
function RankingTab({ authUser, deviceId, games, nickname, onGoToSettings }) {
  const [duel, setDuel] = useState(authUser ? undefined : null); // undefined = 確認中, null = 取得できない
  const [view, setView] = useState("monthly");
  const [openEvent, setOpenEvent] = useState(false);
  const decidedRef = useRef(false);

  const load = useCallback(async () => {
    if (!authUser) return;
    try {
      setDuel(await duelFetch(authUser, deviceId, null));
    } catch (e) {
      setDuel((prev) => (prev === undefined ? null : prev));
    }
  }, [authUser, deviceId]);

  useEffect(() => {
    load();
  }, [load]);

  // 参加している人は、最初から「イベント」を開く
  useEffect(() => {
    if (duel === undefined || decidedRef.current) return;
    decidedRef.current = true;
    if (duel && duel.participant) setView("event");
  }, [duel]);

  if (authUser && duel === undefined) {
    return <div className="text-center py-8" style={{ color: COLORS.strike, opacity: 0.8 }}>読み込み中...</div>;
  }
  const showDuel = !!duel && (duel.participant || (duel.canJoin && duel.today <= duel.endDate));
  if (!showDuel) {
    return <RankingPanel embedded authUser={authUser} deviceId={deviceId} onGoToSettings={onGoToSettings} />;
  }
  const join = async () => {
    await duelFetch(authUser, deviceId, { action: "duelJoin", name: (nickname || "").trim() });
    await load();
  };
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {[
          { key: "monthly", label: "月間ランキング" },
          { key: "event", label: "イベント" },
        ].map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => {
              setView(o.key);
              setOpenEvent(false);
            }}
            className="flex-1 rounded-lg py-2 text-sm"
            style={toggleStyle(view === o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {view === "monthly" ? (
        <RankingPanel embedded authUser={authUser} deviceId={deviceId} onGoToSettings={onGoToSettings} />
      ) : !openEvent ? (
        <div className="space-y-2">
          <EventListRow info={duel} onOpen={() => setOpenEvent(true)} />
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setOpenEvent(false)}
            className="flex items-center gap-1"
            style={{ color: COLORS.strike, fontSize: 14, fontWeight: 600, padding: "2px 0" }}
          >
            <ChevronLeft size={18} />
            イベント一覧
          </button>
          {duel.participant ? (
            <DuelPanel authUser={authUser} deviceId={deviceId} games={games} data={duel} reload={load} />
          ) : (
            <DuelJoinCard info={duel} onJoin={join} />
          )}
        </div>
      )}
    </div>
  );
}

// 月間ランキング (all users who opted in). Opened from the trophy in the header.
// Scores are the final score read from each photo; the server does the
// counting, so this screen only shows what it gets back.
function monthOf(d) {
  return toLocalISODate(d).slice(0, 7);
}
function monthLabel(m) {
  return `${Number(m.slice(0, 4))}年${Number(m.slice(5))}月`;
}

const RANKING_AGE_OPTIONS = [
  ["10s", "10代"],
  ["20s", "20代"],
  ["30s", "30代"],
  ["40s", "40代"],
  ["50s", "50代"],
  ["60s", "60代"],
  ["70s+", "70代以上"],
];

function RankingPanel({ authUser, deviceId, onClose, onGoToSettings, embedded = false }) {
  const now = new Date();
  const thisMonth = monthOf(now);
  const lastMonth = monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const [month, setMonth] = useState(thisMonth);
  const [kind, setKind] = useState("average"); // "average" | "high"
  const [fAge, setFAge] = useState(""); // filters — "" means すべて
  const [fGender, setFGender] = useState("");
  const [fBall, setFBall] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    setData(null);
    setError("");
    (async () => {
      try {
        const token = await authUser.getIdToken();
        const q = new URLSearchParams({ ranking: month });
        if (fAge) q.set("age", fAge);
        if (fGender) q.set("gender", fGender);
        if (fBall) q.set("ball", fBall);
        const res = await fetch(`/api/data?${q.toString()}`, {
          headers: { Authorization: `Bearer ${token}`, "X-Device-Id": deviceId },
        });
        const d = await res.json();
        if (!res.ok) throw new Error();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError("ランキングを読み込めませんでした。時間をおいてお試しください。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authUser, deviceId, month, fAge, fGender, fBall]);

  const medal = ["#E0A800", "#C9CED6", "#C08457"];
  const filtered = !!(fAge || fGender || fBall);
  const list = data ? data[kind] : null;
  const fmt = (v) => (kind === "average" ? Number(v).toFixed(1) : String(v));
  const Row = ({ r }) => (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5"
      style={{
        background: r.isMe ? "rgba(224,168,0,0.12)" : "rgba(10, 16, 34, 0.55)",
        border: r.isMe ? `1.5px solid ${COLORS.gold}` : "1px solid rgba(224,168,0,0.2)",
      }}
    >
      <div style={{ width: 34, flexShrink: 0, textAlign: "center" }}>
        {r.rank <= 3 ? (
          <Trophy size={20} style={{ color: medal[r.rank - 1], margin: "0 auto" }} />
        ) : (
          <span style={{ color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16 }}>{r.rank}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {r.nickname}
          {r.isMe && <span style={{ color: COLORS.gold, fontSize: 11 }}> あなた</span>}
        </div>
        <div style={{ color: COLORS.strike, opacity: 0.6, fontSize: 11 }}>
          {r.rank <= 3 ? `${r.rank}位・` : ""}
          {r.games}ゲーム
        </div>
      </div>
      <div style={{ color: r.rank <= 3 ? medal[r.rank - 1] : COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, flexShrink: 0 }}>
        {fmt(r.value)}
      </div>
    </div>
  );

  const content = (
    <>
        {!authUser ? (
          <div className="glass-card rounded-xl p-4 space-y-3 text-center">
            <Trophy size={32} style={{ color: COLORS.gold, margin: "0 auto" }} />
            <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 15 }}>ランキングにはアカウントが必要です</div>
            <div style={{ color: COLORS.strike, opacity: 0.8, fontSize: 13, lineHeight: 1.7 }}>
              アカウントを作成すると、月間ランキングを見たり、参加したりできます。
            </div>
            <button type="button" onClick={onGoToSettings} className="w-full rounded-lg py-3" style={primaryButtonStyle()}>
              設定でアカウントを作成
            </button>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              {[
                { key: lastMonth, label: monthLabel(lastMonth) },
                { key: thisMonth, label: `${monthLabel(thisMonth)}(今月)` },
              ].map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setMonth(o.key)}
                  className="flex-1 rounded-lg py-2 text-sm"
                  style={{ ...toggleStyle(month === o.key), minWidth: 0, whiteSpace: "nowrap", padding: "8px 4px", letterSpacing: "-0.02em" }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              {[
                { key: "average", label: "アベレージ" },
                { key: "high", label: "ハイゲーム" },
              ].map((o) => (
                <button key={o.key} type="button" onClick={() => setKind(o.key)} className="flex-1 rounded-lg py-2 text-sm" style={toggleStyle(kind === o.key)}>
                  {o.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              {[
                { label: "年代", value: fAge, set: setFAge, options: RANKING_AGE_OPTIONS },
                { label: "性別", value: fGender, set: setFGender, options: [["male", "男性"], ["female", "女性"]] },
                { label: "ボール", value: fBall, set: setFBall, options: [["house", "ハウス"], ["own", "マイボール"]] },
              ].map((f) => (
                <div key={f.label} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: COLORS.strike, opacity: 0.65, fontSize: 11, marginBottom: 2 }}>{f.label}</div>
                  <select
                    value={f.value}
                    onChange={(e) => f.set(e.target.value)}
                    className="w-full rounded-lg px-1.5 py-1.5"
                    style={{
                      fontSize: 16,
                      background: f.value ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                      color: f.value ? COLORS.gold : COLORS.strike,
                      border: `1px solid ${f.value ? COLORS.gold : "rgba(184, 153, 104, 0.6)"}`,
                      fontWeight: f.value ? 700 : 400,
                    }}
                  >
                    <option value="">すべて</option>
                    {f.options.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {error && <div className="glass-card rounded-xl p-4" style={{ color: COLORS.strike, fontSize: 13 }}>{error}</div>}
            {!data && !error && <div className="text-center py-8" style={{ color: COLORS.strike, opacity: 0.8 }}>読み込み中...</div>}

            {data && (
              <>
                <div className="rounded-xl p-3" style={{ border: "1px solid rgba(224,168,0,0.35)" }}>
                  <div style={{ color: COLORS.strike, opacity: 0.65, fontSize: 11.5 }}>あなたの{monthLabel(month)}の成績</div>
                  <div className="flex items-baseline gap-4" style={{ marginTop: 2 }}>
                    {[
                      ["ゲーム", `${data.me.games}`],
                      ["アベレージ", data.me.avg !== null ? Number(data.me.avg).toFixed(1) : "ー"],
                      ["ハイ", data.me.high !== null ? `${data.me.high}` : "ー"],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <span style={{ color: COLORS.strike, opacity: 0.6, fontSize: 11 }}>{k} </span>
                        <span style={{ color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 17 }}>{v}</span>
                      </div>
                    ))}
                  </div>
                  {data.me.excluded ? (
                    <div style={{ color: "#E8836A", fontSize: 12, marginTop: 6 }}>ランキングの対象外に設定されています</div>
                  ) : !data.me.optIn ? (
                    <div className="flex items-center justify-between gap-2" style={{ marginTop: 8 }}>
                      <span style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12, whiteSpace: "nowrap" }}>ランキングに未参加です</span>
                      <button
                        type="button"
                        onClick={onGoToSettings}
                        className="rounded-full px-3 py-1"
                        style={{ border: `1px solid ${COLORS.gold}`, color: COLORS.gold, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        設定から参加する
                      </button>
                    </div>
                  ) : null}
                </div>

                {list.top.length === 0 ? (
                  <div className="text-center py-8" style={{ color: COLORS.strike, opacity: 0.8, fontSize: 13.5 }}>
                    {filtered ? "この条件に当てはまる参加者はいません" : "まだランキングに載っている人はいません"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {list.top.map((r, i) => (
                      <Row key={i} r={r} />
                    ))}
                    {list.me && (
                      <>
                        <div className="text-center" style={{ color: COLORS.strike, opacity: 0.5 }}>⋮</div>
                        <Row r={list.me} />
                      </>
                    )}
                  </div>
                )}

                <div className="text-center" style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12.5 }}>
                  アベレージは月{data.minGames}ゲーム以上が対象です
                </div>
              </>
            )}
          </>
        )}
    </>
  );
  // As the 「ランキング」 tab: a normal page inside the app.
  if (embedded) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2" style={{ color: COLORS.cream, fontWeight: 700 }}>
          <Trophy size={18} style={{ color: COLORS.gold }} /> 月間ランキング
        </div>
        {content}
      </div>
    );
  }
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
          <Trophy size={20} style={{ color: COLORS.gold }} />
          <div style={{ color: COLORS.cream, fontWeight: 700 }}>月間ランキング</div>
        </div>
        <button type="button" onClick={onClose} aria-label="閉じる">
          <X size={22} style={{ color: COLORS.cream }} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}>
        {content}
      </div>
    </div>
  );
}

function BellPanel({ items, readIds, onOpenItem, onClose }) {
  const [openId, setOpenId] = useState(null);
  const current = openId ? items.find((a) => a.id === openId) : null;
  return (
    <div
      className="fixed left-0 right-0 top-0 bottom-0 flex flex-col"
      style={{ background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, zIndex: 50 }}
    >
      <div
        className="flex items-center justify-between px-4"
        style={{ background: COLORS.ink, paddingTop: "calc(16px + max(env(safe-area-inset-top), 20px))", paddingBottom: 16 }}
      >
        {current ? (
          <button type="button" onClick={() => setOpenId(null)} className="flex items-center gap-1" aria-label="お知らせ一覧に戻る">
            <ChevronLeft size={24} style={{ color: COLORS.cream, marginLeft: -6 }} />
            <span style={{ color: COLORS.cream, fontWeight: 700 }}>お知らせ</span>
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <Bell size={20} style={{ color: COLORS.strike }} />
            <div style={{ color: COLORS.cream, fontWeight: 700 }}>お知らせ</div>
          </div>
        )}
        <button type="button" onClick={onClose} aria-label="閉じる">
          <X size={22} style={{ color: COLORS.cream }} />
        </button>
      </div>
      <div
        key={current ? current.id : "list"}
        className="flex-1 overflow-y-auto px-4 py-4"
        style={{ paddingBottom: "calc(24px + env(safe-area-inset-bottom))" }}
      >
        {current ? (
          <AnnouncementDetail a={current} />
        ) : (
          <div className="space-y-2">
            {items.length === 0 && (
              <div className="text-center py-10" style={{ color: COLORS.strike, opacity: 0.8, fontSize: 14 }}>
                お知らせはまだありません
              </div>
            )}
            {items.map((a) => (
              <AnnouncementListRow
                key={a.id}
                a={a}
                unread={!readIds.includes(a.id)}
                onOpen={() => {
                  setOpenId(a.id);
                  onOpenItem(a.id);
                }}
              />
            ))}
          </div>
        )}
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
          style={{ width: "100%", maxHeight: "calc(58vh / var(--app-zoom, 1))", objectFit: "contain", borderRadius: 10, display: "block", background: "rgba(0,0,0,0.25)" }}
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
      style={{ position: "fixed", inset: 0, width: "calc(100vw / var(--app-zoom, 1))", height: "calc(100vh / var(--app-zoom, 1))", pointerEvents: "none", zIndex: 61 }}
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

// ボウリング場 picker: centers used before (most recent first) in a dropdown,
// plus 「新しいボウリング場を入力」 to type one that isn't listed yet.
const NEW_CENTER = "__new__";
const CENTER_BACKFILL_KEY = "center-backfill-v1"; // set once past games have a ボウリング場
function CenterPicker({ value, onChange, known }) {
  const [typing, setTyping] = useState(false);
  const listed = known.includes(value);
  const showInput = typing || (value && !listed);
  return (
    <div className="space-y-2">
      <select
        value={showInput ? NEW_CENTER : value || ""}
        onChange={(e) => {
          if (e.target.value === NEW_CENTER) {
            setTyping(true);
            onChange("");
          } else {
            setTyping(false);
            onChange(e.target.value);
          }
        }}
        className="w-full px-3 py-2 rounded border"
        style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16 }}
      >
        <option value="">ボウリング場を選択</option>
        {known.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
        <option value={NEW_CENTER}>+ 新しいボウリング場を入力</option>
      </select>
      {showInput && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="例: 〇〇ボウル"
          autoFocus={typing}
          className="w-full px-3 py-2 rounded border"
          style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16 }}
        />
      )}
    </div>
  );
}

// Every center the user has played at, most recently used first (plus the
// ホームセンター from settings), so they can be picked instead of typed again.
function knownCentersFrom(games, homeCenter) {
  const seen = new Map();
  [...games]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0))
    .forEach((g) => {
      const n = (g.center || "").trim();
      if (n && !seen.has(n)) seen.set(n, true);
    });
  const h = (homeCenter || "").trim();
  if (h && !seen.has(h)) seen.set(h, true);
  return [...seen.keys()];
}

// 記録タブ「ボウリング場別の成績」: each center with 3+ games in the period,
// highest average first. Same 3-game rule as the ball analysis.
function CenterStats({ games }) {
  const groups = new Map();
  for (const g of games) {
    const n = (g.center || "").trim();
    if (!n) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(g);
  }
  const rows = [...groups.entries()]
    .map(([name, list]) => ({ name, list, stats: computeGameSetStats(list) }))
    .filter((r) => r.list.length >= 3)
    .sort((a, b) => b.stats.avg - a.stats.avg || b.list.length - a.list.length);
  const pct = (v) => `${v}%`;
  const medal = ["#E0A800", "#C9CED6", "#C08457"];
  return (
    <div className="px-3 pb-3 space-y-2">
      {rows.length === 0 ? (
        <div style={{ color: COLORS.strike, opacity: 0.8, fontSize: 12.5, lineHeight: 1.7 }}>
          この期間に3ゲーム以上記録したボウリング場はありません
        </div>
      ) : (
        rows.map((r, i) => (
          <div key={r.name} className="rounded-lg p-3" style={{ background: "rgba(10, 16, 34, 0.55)", border: "1px solid rgba(224,168,0,0.35)" }}>
            <div className="flex items-center gap-2">
              <span
                style={{
                  color: i < 3 ? medal[i] : "rgba(245,241,228,0.6)",
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 700,
                  fontSize: 14,
                  flexShrink: 0,
                }}
              >
                {i + 1}位
              </span>
              <MapPin size={14} style={{ color: COLORS.gold, flexShrink: 0 }} />
              <span style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
              </span>
              <span style={{ color: COLORS.strike, opacity: 0.65, fontSize: 11.5, flexShrink: 0 }}>{r.list.length}ゲーム</span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.15fr 0.9fr 0.9fr 1.25fr 1fr",
                marginTop: 10,
                paddingTop: 8,
                borderTop: "1px solid rgba(224,168,0,0.18)",
              }}
            >
              {[
                ["アベレージ", `${r.stats.avg}`],
                ["ハイ", `${r.stats.highGame}`],
                ["ロー", `${r.stats.lowGame}`],
                ["ストライク", pct(r.stats.strikeRate)],
                ["スペア", pct(r.stats.spareRate)],
              ].map(([k, v], j) => (
                <div key={k} className="text-center" style={{ borderLeft: j ? "1px solid rgba(224,168,0,0.15)" : "none", minWidth: 0 }}>
                  <div style={{ color: COLORS.strike, opacity: 0.6, fontSize: 10, whiteSpace: "nowrap" }}>{k}</div>
                  <div style={{ color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <div style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12.5 }}>3ゲーム以上記録したボウリング場が対象です</div>
    </div>
  );
}

// Account form shared by the first screen and the 設定 tab: two separate
// boxes — ログイン first, then アカウント作成. Each opens its own fields;
// only one is open at a time. 「パスワードを忘れた方」 lives in the ログイン box.
function AccountForm({ onLogin, onSignup, onReset, busy, errorMsg, infoMsg, intro, onBack }) {
  const [open, setOpen] = useState(null); // null | "login" | "reset" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const input = { borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink, fontSize: 16 };
  const openBox = (m) => {
    setOpen(m);
    setPassword("");
  };
  const submit = async () => {
    if (!email.trim()) return;
    if (open === "reset") return onReset(email.trim());
    if (!password) return;
    if (open === "login") await onLogin(email.trim(), password);
    else await onSignup(email.trim(), password);
  };
  const fields = (mode) => (
    <div className="space-y-2.5" style={{ marginTop: 10 }}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="メールアドレス"
        autoComplete="email"
        className="w-full px-3 py-2 rounded border"
        style={input}
      />
      {mode !== "reset" && (
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === "signup" ? "パスワード(6文字以上)" : "パスワード"}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          className="w-full px-3 py-2 rounded border"
          style={input}
        />
      )}
      {mode === "signup" && (
        <div className="text-left" style={{ color: COLORS.strike, opacity: 0.85, fontSize: 13, lineHeight: 1.6 }}>
          Gmailなどのメールがおすすめです(携帯会社のメールは再設定メールが届かないことがあります)
        </div>
      )}
      {errorMsg && <div className="text-left" style={{ color: "#E8836A", fontSize: 13 }}>{errorMsg}</div>}
      {infoMsg && <div className="text-left" style={{ color: COLORS.strike, fontSize: 13, lineHeight: 1.6 }}>{infoMsg}</div>}
      <button type="button" onClick={submit} disabled={busy} className="w-full rounded-lg py-3" style={primaryButtonStyle(!busy)}>
        {busy ? "処理中..." : mode === "login" ? "ログイン" : mode === "signup" ? "アカウントを作成" : "再設定メールを送る"}
      </button>
      {mode === "login" && (
        <button type="button" onClick={() => openBox("reset")} className="w-full text-sm underline" style={{ color: COLORS.strike }}>
          パスワードを忘れた方
        </button>
      )}
      {mode === "reset" && (
        <button type="button" onClick={() => openBox("login")} className="w-full text-sm underline" style={{ color: COLORS.strike }}>
          ログインにもどる
        </button>
      )}
    </div>
  );
  const box = (key, title, sub, openLabel, body) => {
    const isOpen = open === key || (key === "login" && open === "reset");
    return (
      <div className="rounded-xl p-3 text-left" style={{ border: `1px solid ${isOpen ? COLORS.gold : "rgba(184, 153, 104, 0.6)"}`, background: "rgba(10, 16, 34, 0.35)" }}>
        <div style={{ color: isOpen ? COLORS.gold : COLORS.strike, fontWeight: 700, fontSize: 14.5 }}>
          {key === "login" && open === "reset" ? "パスワードの再設定" : title}
        </div>
        <div style={{ color: COLORS.strike, opacity: 0.7, fontSize: 12, lineHeight: 1.6, marginTop: 2 }}>
          {key === "login" && open === "reset" ? "登録したメールアドレスに、パスワード再設定用のメールを送ります。" : sub}
        </div>
        {isOpen ? (
          body
        ) : (
          <button
            type="button"
            onClick={() => openBox(key)}
            className="w-full rounded-lg py-2.5 text-sm"
            style={{ marginTop: 10, border: `1px solid ${COLORS.gold}`, color: COLORS.gold, fontWeight: 700 }}
          >
            {openLabel}
          </button>
        )}
      </div>
    );
  };
  return (
    <div className="space-y-3">
      {box("login", "ログイン", "アカウントをお持ちの方", "ログインする", fields(open === "reset" ? "reset" : "login"))}
      {box("signup", "アカウント作成", intro || "はじめての方", "アカウントを作成する", fields("signup"))}
      {onBack && (
        <button type="button" onClick={onBack} className="w-full text-sm underline" style={{ color: COLORS.strike }}>
          もどる
        </button>
      )}
    </div>
  );
}

// Centered popup used for prompts that need the user's attention.
// 設定の「文字の大きさ」: 1行に収まる小さな切り替え(押すとすぐ反映)
function TextSizeSegment({ value, onChange }) {
  return (
    <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid rgba(245,241,228,0.25)", flexShrink: 0 }}>
      {TEXT_SIZES.map((s, i) => {
        const on = value === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(s.key)}
            aria-pressed={on}
            style={{
              padding: "6px 10px",
              fontSize: 13,
              fontWeight: 700,
              whiteSpace: "nowrap",
              borderLeft: i ? "1px solid rgba(245,241,228,0.2)" : "none",
              background: on ? "rgba(224,168,0,0.18)" : "transparent",
              color: on ? COLORS.gold : COLORS.strike,
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// 「+ ○○を登録」: 押すと登録フォームが開く(設定画面を短く保つため)
function AddRowButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl flex items-center justify-center gap-1"
      style={{ padding: "10px 12px", border: `1px dashed ${COLORS.oak}`, color: COLORS.strike, fontSize: 14, fontWeight: 700 }}
    >
      <Plus size={16} />
      {label}
    </button>
  );
}

// 開いた登録フォームの見出し(右上の × で閉じる)
function FormHeader({ label, onClose }) {
  return (
    <div className="flex items-center justify-between">
      <div style={{ color: COLORS.strike, fontSize: 13.5, fontWeight: 700 }}>{label}</div>
      <button type="button" onClick={onClose} aria-label="閉じる" style={{ color: COLORS.strike, padding: 4 }}>
        <X size={18} />
      </button>
    </div>
  );
}

// 文字の大きさの選択(初回の案内で使う)。押すとすぐ画面に反映される。
function TextSizeChooser({ value, onChange }) {
  const glyph = { normal: 18, large: 23, xlarge: 28 };
  return (
    <div className="flex gap-2">
      {TEXT_SIZES.map((s) => {
        const on = value === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(s.key)}
            aria-pressed={on}
            className="flex-1 rounded-xl flex flex-col items-center justify-end"
            style={{
              padding: "10px 4px 8px",
              minHeight: 74,
              border: on ? `2px solid ${COLORS.gold}` : "1px solid rgba(245,241,228,0.25)",
              background: on ? "rgba(224,168,0,0.14)" : "rgba(10,16,34,0.45)",
              color: on ? COLORS.gold : COLORS.cream,
            }}
          >
            <span style={{ fontSize: glyph[s.key], fontWeight: 700, lineHeight: 1.1 }}>あ</span>
            <span style={{ fontSize: 13, fontWeight: 700, marginTop: 6 }}>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// 初めて開いた時に1回だけ出す「文字の大きさ」の案内
function TextSizeWelcome({ value, onChange, onDone }) {
  return (
    <AppModal
      title="文字の大きさ"
      footer={
        <button type="button" onClick={onDone} className="w-full rounded-lg py-3" style={primaryButtonStyle()}>
          この大きさにする
        </button>
      }
    >
      <div className="space-y-3">
        <div style={{ color: COLORS.cream, fontSize: 15, lineHeight: 1.7 }}>
          <Phrases text="見やすい大きさを|選んでください。|あとから「設定」でも|変えられます。" />
        </div>
        <TextSizeChooser value={value} onChange={onChange} />
        <div className="rounded-lg" style={{ padding: "10px 12px", background: "rgba(10,16,34,0.55)" }}>
          <div style={{ color: COLORS.strike, fontSize: 13 }}>アベレージ</div>
          <div style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 28, lineHeight: 1.2 }}>168.5</div>
          <div style={{ color: COLORS.strike, fontSize: 13 }}>
            <Phrases text="ストライク率 32.4% ・ |スペア率 41.0%" />
          </div>
        </div>
      </div>
    </AppModal>
  );
}

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
      <div className="glass-card rounded-2xl w-full" style={{ maxWidth: 360, padding: "20px 18px", maxHeight: "calc(85vh / var(--app-zoom, 1))", overflowY: "auto" }}>
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
      card("main", "1stボール", points.main, mains, (m) => m.name, (m) => [
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
    { title: "ゲーム数", unit: "組み合わせ", rows: byValue(sets, (s) => s.games.length, (v) => `${v}ゲーム`) },
    { title: "アベレージ", unit: "組み合わせ", rows: byValue(sets, (s) => s.stats.avg, (v) => `${v}`) },
    { title: "ハイゲーム", unit: "組み合わせ", rows: byValue(sets, (s) => s.stats.highGame, (v) => `${v}`) },
    { title: "ローゲーム(ワースト)", unit: "組み合わせ", rows: byValue(sets, (s) => s.stats.lowGame, (v) => `${v}`, { asc: true }) },
    { title: "ストライク", unit: "1stボール", rows: byRate(mains, (m) => m.stats.strikeCount, (m) => m.stats.frameCount) },
    { title: "スペア", unit: "スペアボール", rows: byRate(spares, (s) => s.stats.spareCount, (s) => s.stats.spareChances) },
    {
      title: "オープンフレーム(ワースト)",
      unit: "組み合わせ",
      rows: byRate(sets, (s) => s.stats.openFrameCount, (s) => s.stats.frameCount),
    },
    { title: "スプリット(ワースト)", unit: "1stボール", rows: byRate(mains, (m) => m.roles.splits, (m) => m.roles.firstBalls) },
    { title: "スプリットカバー", unit: "スペアボール", rows: byRate(spares, (s) => s.roles.splitCovers, (s) => s.roles.splitChances) },
    {
      title: "ガター(ワースト)",
      unit: "1stボール",
      rows: byRate(mains, (m) => m.roles.firstGutters, (m) => m.roles.firstBalls),
    },
  ];

  const medal = ["#E0A800", "#C9CED6", "#C08457"];
  const points = computeBallPoints({ sets, mains, spares }, setName);
  const evaluation = buildEvaluationCards({ sets, mains, spares }, points, setName);
  if (!sets.length && !mains.length && !spares.length) {
    return (
      <div className="px-3 pb-4" style={{ color: COLORS.strike, fontSize: 13, lineHeight: 1.7, opacity: 0.85 }}>
        この期間に3ゲーム以上使ったボールはありません
        <br />
        期間を広げると表示される場合があります
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
              順位の合計点(1位3点・2位2点・3位1点)
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
        <img src={src} alt="囲んだ範囲のプレビュー" style={{ display: "block", maxWidth: "100%", maxHeight: "calc(45vh / var(--app-zoom, 1))" }} />
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
  onReset,
  authBusy,
  authErrorMsg,
  authInfoMsg,
  justSignedOut,
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showAccountForm, setShowAccountForm] = useState(false);

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

  return (
    <div
      style={{ minHeight: "calc(100vh / var(--app-zoom, 1))", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
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
              style={{ background: COLORS.gold, color: COLORS.ink, fontWeight: 700 }}
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
          <div className="rounded-xl p-4" style={{ border: `1px solid ${COLORS.oak}` }}>
            <AccountForm
              onLogin={onLogin}
              onSignup={onSignup}
              onReset={onReset}
              busy={authBusy}
              errorMsg={authErrorMsg}
              infoMsg={authInfoMsg}
              intro="はじめての方。作っておくと、機種変更した時に承認を待たずに、ログインするだけで引き継げます(同時に使えるのは1台のみ)"
              onBack={() => setShowAccountForm(false)}
            />
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

// 管理画面のAPI呼び出し。アプリのアカウントでログインしていれば、そのIDトークンを付ける
// (管理者アカウントならパスワードなしで通る。api/_adminAuth.js)
async function adminFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const user = auth && auth.currentUser;
  if (user) {
    try {
      headers.Authorization = `Bearer ${await user.getIdToken()}`;
    } catch (e) {
      // トークンが取れなければパスワードだけで試す
    }
  }
  return fetch(url, { ...opts, headers });
}

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
      const res = await adminFetch(
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
      const res = await adminFetch("/api/admin/requests", {
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
    const res = await adminFetch("/api/announcements", {
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
          <div className="text-xs" style={{ color: COLORS.strike }}>プレビュー:ベルの一覧</div>
          <AnnouncementListRow a={previewItem} imageSrc={previewImageSrc} unread onOpen={() => {}} />
          <div className="text-xs" style={{ color: COLORS.strike }}>プレビュー:押したあとの詳細</div>
          <AnnouncementDetail a={previewItem} imageSrc={previewImageSrc} />
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


// ---------- 管理画面:登録者カード ----------
// "2026-10-01T12:03:44.512Z" → "10/1 21:03" (Japan time). Anything unparsable is shown as is.
function formatAdminDateTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function AdminChip({ children, tone = "muted" }) {
  const tones = {
    gold: { background: "rgba(224, 168, 0, 0.16)", color: COLORS.gold, border: "1px solid rgba(224, 168, 0, 0.55)" },
    muted: { background: "rgba(255,255,255,0.08)", color: COLORS.strike, border: "1px solid rgba(255,255,255,0.18)" },
    warn: { background: "rgba(232, 131, 106, 0.16)", color: "#E8836A", border: "1px solid rgba(232, 131, 106, 0.5)" },
  };
  return (
    <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap", ...tones[tone] }}>
      {children}
    </span>
  );
}

function AdminButton({ children, onClick, kind = "outline", ariaLabel }) {
  const styles = {
    primary: { background: COLORS.gold, color: COLORS.ink, border: `1px solid ${COLORS.gold}` },
    light: { background: COLORS.strike, color: COLORS.ink, border: `1px solid ${COLORS.strike}` },
    outline: { background: "transparent", color: COLORS.cream, border: `1px solid ${COLORS.oak}` },
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="rounded-lg flex items-center justify-center"
      style={{ minHeight: 36, padding: "0 14px", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", ...styles[kind] }}
    >
      {children}
    </button>
  );
}

// One registrant. Top: number + kind. Middle: name, email, ranking. Bottom: date and the buttons.
// Plans the admin can set by hand until Stripe sets them (api/_plans.js).
const ADMIN_PLAN_OPTIONS = [
  { id: "", label: "未設定(今まで通り)" },
  { id: "basic", label: "ベーシック 1,000円" },
  { id: "premium", label: "プレミアム 2,000円" },
  { id: "premium_plus", label: "プレミアム＋ 3,000円" },
  { id: "free", label: "招待(無料・全機能)" },
];

function AdminRequestCard({ r, dateLabel, onToggleRanking, onSetPlan, actions, children }) {
  const migrated = !!r.linkedAccountUid;
  const showEmail = r.email && r.email !== r.name;
  return (
    <div className="rounded-xl border glass-card" style={{ borderColor: COLORS.oak, padding: 14, opacity: migrated ? 0.75 : 1 }}>
      <div className="flex items-center justify-between gap-2">
        <span style={{ color: COLORS.strike, fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>No.{formatRequestNumber(r.requestNumber)}</span>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {migrated ? (
            <AdminChip>移行済み(古い記録)</AdminChip>
          ) : r.isAccount ? (
            <AdminChip tone="gold">アカウント</AdminChip>
          ) : (
            <AdminChip>端末のみ</AdminChip>
          )}
        </div>
      </div>

      <div
        style={{ color: COLORS.cream, fontWeight: 700, fontSize: 17, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {r.name || "(名前なし)"}
      </div>
      {showEmail && (
        <div style={{ color: COLORS.strike, fontSize: 13, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {r.email}
        </div>
      )}

      {r.rankingOptIn && (
        <div className="flex items-center justify-between gap-2 rounded-lg" style={{ marginTop: 10, padding: "8px 10px", background: "rgba(255,255,255,0.05)" }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <Trophy size={15} style={{ color: r.rankingExcluded ? "#E8836A" : COLORS.gold, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: r.rankingExcluded ? "#E8836A" : COLORS.cream, fontSize: 13, fontWeight: 700 }}>
                {r.rankingExcluded ? "ランキング除外中" : "ランキング参加中"}
              </div>
              {r.rankingNickname && (
                <div style={{ color: COLORS.strike, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  表示名:{r.rankingNickname}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleRanking}
            className="rounded-lg"
            style={{ padding: "6px 10px", fontSize: 12, fontWeight: 700, color: COLORS.strike, border: "1px solid rgba(255,255,255,0.25)", whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {r.rankingExcluded ? "除外を解除" : "除外する"}
          </button>
        </div>
      )}

      {onSetPlan && !migrated && (
        <div className="flex items-center justify-between gap-2 rounded-lg" style={{ marginTop: 10, padding: "8px 10px", background: "rgba(255,255,255,0.05)" }}>
          <span style={{ color: COLORS.cream, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>プラン</span>
          <select
            value={r.plan || ""}
            onChange={(e) => onSetPlan(e.target.value || null)}
            className="rounded-lg"
            style={{ fontSize: 13, padding: "6px 8px", color: COLORS.ink, background: COLORS.cream, minWidth: 0, maxWidth: "70%" }}
          >
            {ADMIN_PLAN_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center justify-between gap-2" style={{ marginTop: 12 }}>
        <span style={{ color: COLORS.strike, fontSize: 12, opacity: 0.85 }}>{dateLabel}</span>
        <div className="flex gap-2">{actions}</div>
      </div>
      {children}
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

  const [checking, setChecking] = useState(!!auth); // アカウントでの自動ログインを確認中
  const [usePassword, setUsePassword] = useState(false); // 予備: 管理者パスワードで入る
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPw, setLoginPw] = useState("");

  // 管理者のアカウントでログイン済みなら、そのまま開く
  useEffect(() => {
    if (!auth) return undefined;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) await load("", true);
      setChecking(false);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginWithAdminAccount = async () => {
    if (!auth || !loginEmail.trim() || !loginPw) return;
    setLoading(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPw);
      await load("");
    } catch (e) {
      setError("メールアドレスかパスワードが違います");
      setLoading(false);
    }
  };

  const load = async (pw, silent = false) => {
    setLoading(true);
    setError("");
    try {
      const [rReq, rFb] = await Promise.all([
        adminFetch(`/api/admin/requests?password=${encodeURIComponent(pw)}`),
        adminFetch(`/api/admin/feedback?password=${encodeURIComponent(pw)}`),
      ]);
      if (!rReq.ok || !rFb.ok) throw new Error("auth failed");
      const reqData = await rReq.json();
      const fbData = await rFb.json();
      setRequests(reqData.items || []);
      setServiceAlerts(reqData.alerts || []);
      setFeedbackList(fbData.items || []);
      setAuthed(true);
    } catch (e) {
      if (!silent) setError(pw ? "パスワードが違うか、読み込みに失敗しました" : "このアカウントには管理者の権限がありません");
    } finally {
      setLoading(false);
    }
  };

  // Remove someone from the monthly ranking (or restore them).
  const toggleRankingExclude = async (uid, excluded) => {
    await adminFetch("/api/admin/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action: "rankingExclude", uid, excluded }),
    });
    load(password);
  };

  // Set someone's plan by hand (null = 未設定).
  const setPlan = async (id, plan) => {
    await adminFetch("/api/admin/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action: "setPlan", id, plan }),
    });
    load(password);
  };

  const updateStatus = async (deviceId, status) => {
    await adminFetch("/api/admin/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, deviceId, status }),
    });
    load(password);
  };

  // Old phone records whose owner has moved to an account (approval, name
  // and number already copied over) — safe to remove.
  const deleteMigrated = async (ids) => {
    if (!ids.length) return;
    if (!window.confirm(`アカウントに移行済みの記録を${ids.length}件削除します。よろしいですか?\n(アカウント側の承認・記録には影響しません)`)) return;
    for (const id of ids) {
      await adminFetch("/api/admin/requests", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, deviceId: id }),
      });
    }
    load(password);
  };

  const deleteRequest = async (deviceId) => {
    await adminFetch("/api/admin/requests", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, deviceId }),
    });
    setConfirmDeleteRequestId(null);
    load(password);
  };

  const updateFeedbackStatus = async (id, status) => {
    await adminFetch("/api/admin/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, id, status }),
    });
    load(password);
  };

  const deleteFeedback = async (id) => {
    await adminFetch("/api/admin/feedback", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, id }),
    });
    setConfirmDeleteFeedbackId(null);
    load(password);
  };

  if (!authed) {
    return (
      <div style={{ minHeight: "calc(100vh / var(--app-zoom, 1))", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 320, width: "100%" }} className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={22} style={{ color: COLORS.gold }} />
            <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, color: COLORS.cream }}>管理者ログイン</div>
          </div>
          {checking ? (
            <div style={{ color: COLORS.strike, fontSize: 14 }}>確認中...</div>
          ) : !usePassword && auth ? (
            <>
              <div style={{ color: COLORS.strike, fontSize: 14 }}>アプリのアカウントでログインしてください。次回からは自動で開きます。</div>
              <input
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="メールアドレス"
                autoComplete="username"
                className="w-full px-3 py-2 rounded border"
                style={{ borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink, fontSize: 16 }}
              />
              <input
                type="password"
                value={loginPw}
                onChange={(e) => setLoginPw(e.target.value)}
                placeholder="パスワード"
                autoComplete="current-password"
                className="w-full px-3 py-2 rounded border"
                style={{ borderColor: COLORS.oak, background: COLORS.cream, color: COLORS.ink, fontSize: 16 }}
              />
              {error && <div style={{ color: "#E8836A", fontSize: 14 }}>{error}</div>}
              <button
                onClick={loginWithAdminAccount}
                disabled={loading}
                className="w-full rounded-lg py-2"
                style={{ background: COLORS.gold, color: COLORS.ink, fontWeight: 700 }}
              >
                {loading ? "確認中..." : "ログイン"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUsePassword(true);
                  setError("");
                }}
                className="w-full"
                style={{ color: COLORS.strike, fontSize: 13, opacity: 0.8, padding: "4px 0" }}
              >
                管理者パスワードで入る
              </button>
            </>
          ) : (
            <>
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
              style={{ background: COLORS.gold, color: COLORS.ink, fontWeight: 700 }}
            >
              {loading ? "確認中..." : "ログイン"}
            </button>
              {auth && (
                <button
                  type="button"
                  onClick={() => {
                    setUsePassword(false);
                    setError("");
                  }}
                  className="w-full"
                  style={{ color: COLORS.strike, fontSize: 13, opacity: 0.8, padding: "4px 0" }}
                >
                  アカウントでログインする
                </button>
              )}
            </>
          )}
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
    <div style={{ minHeight: "calc(100vh / var(--app-zoom, 1))", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, padding: 16 }}>
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
                await adminFetch("/api/admin/requests", {
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
              <AdminRequestCard
                key={r.id}
                r={r}
                dateLabel={`申請 ${formatAdminDateTime(r.requestedAt)}`}
                onToggleRanking={() => toggleRankingExclude(r.id, !r.rankingExcluded)}
                actions={
                  <>
                    <AdminButton kind="light" onClick={() => updateStatus(r.id, "rejected")}>却下</AdminButton>
                    <AdminButton kind="primary" onClick={() => updateStatus(r.id, "approved")}>承認</AdminButton>
                  </>
                }
              />
            ))}
          </div>
        </div>

        <div>
          <div className="text-sm mb-2" style={{ color: COLORS.strike, fontWeight: 700 }}>
            承認済み ({approved.length})
          </div>
          {approved.some((r) => r.linkedAccountUid) && (
            <button
              type="button"
              onClick={() => deleteMigrated(approved.filter((r) => r.linkedAccountUid).map((r) => r.id))}
              className="w-full rounded-lg py-2 text-sm mb-2"
              style={{ border: "1px solid rgba(184, 153, 104, 0.6)", color: COLORS.strike, fontWeight: 700 }}
            >
              アカウントに移行済みの記録をまとめて削除({approved.filter((r) => r.linkedAccountUid).length}件)
            </button>
          )}
          <div className="space-y-2">
            {approved.length === 0 && <div className="text-xs" style={{ color: COLORS.strike }}>承認済みの申請はありません</div>}
            {approved.map((r) => (
              <AdminRequestCard
                key={r.id}
                r={r}
                dateLabel={`承認 ${formatAdminDateTime(r.updatedAt)}`}
                onToggleRanking={() => toggleRankingExclude(r.id, !r.rankingExcluded)}
                onSetPlan={(plan) => setPlan(r.id, plan)}
                actions={
                  r.linkedAccountUid ? (
                    <AdminButton onClick={() => deleteMigrated([r.id])}>削除</AdminButton>
                  ) : (
                    <AdminButton onClick={() => updateStatus(r.id, "rejected")}>却下に変更</AdminButton>
                  )
                }
              />
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
              <AdminRequestCard
                key={r.id}
                r={r}
                dateLabel={`却下 ${formatAdminDateTime(r.updatedAt)}`}
                onToggleRanking={() => toggleRankingExclude(r.id, !r.rankingExcluded)}
                actions={
                  <>
                    <AdminButton onClick={() => setConfirmDeleteRequestId(r.id)} ariaLabel="削除">
                      <Trash2 size={15} style={{ color: COLORS.strike }} />
                    </AdminButton>
                    <AdminButton onClick={() => updateStatus(r.id, "approved")}>承認に変更</AdminButton>
                  </>
                }
              >
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
              </AdminRequestCard>
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

// ---------- 初回設定の案内 (setup wizard) ----------
// Shown once to new users: one setting per page, 「次へ」 saves it and moves
// on, 「あとで設定する」 skips it (everything can be changed later in 設定).
// The current page lives in the parent (step/setStep) so the wizard picks
// up where it left off even if the screen reloads mid-way (e.g. right after
// creating an account, while the records sync).
const SETUP_STEPS = ["welcome", "textSize", "names", "goals", "center", "balls", "shoes", "account", "done"];
const SETUP_DONE_KEY = "setup-done-v1";

function SetupField({ label, hint, children }) {
  return (
    <div>
      <div style={{ color: COLORS.cream, fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12.5, lineHeight: 1.6, marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

const setupInputStyle = { borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16, width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${COLORS.oak}`, background: "#fff" };

function SetupWizard({
  step,
  setStep,
  textSize,
  onTextSize,
  initial,
  knownCenters,
  myBalls,
  myShoes,
  authUser,
  authBusy,
  authErrorMsg,
  onSaveProfile,
  onSavePlayerName,
  onAddBall,
  onAddShoe,
  onSignup,
  onFinish,
}) {
  const [nickname, setNickname] = useState(initial.nickname || "");
  const [playerName, setPlayerName] = useState(initial.playerName || "");
  const [hand, setHand] = useState(initial.dominantHand || "right");
  const [goalAverage, setGoalAverage] = useState(initial.goalAverage || "");
  const [goalScore, setGoalScore] = useState(initial.goalScore || "");
  const [center, setCenter] = useState(initial.homeCenter || "");
  const [ballType, setBallType] = useState("own");
  const [ballRole, setBallRole] = useState("strike");
  const [ballWeight, setBallWeight] = useState("");
  const [ballName, setBallName] = useState("");
  const [shoeChoice, setShoeChoice] = useState(myShoes.some((s) => s.type === "own") ? "own" : "rental");
  const [shoeName, setShoeName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const key = SETUP_STEPS[step] || "done";
  const total = SETUP_STEPS.length - 2; // pages between the welcome and the last page
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [step]);

  const go = (n) => setStep(Math.max(0, Math.min(SETUP_STEPS.length - 1, n)));
  const next = () => go(step + 1);
  const back = () => go(step - 1);

  const addBall = () => {
    if (!ballWeight) return;
    const typeLabel = ballType === "house" ? "ハウスボール" : "マイボール";
    onAddBall({
      id: uid(),
      type: ballType,
      role: ballRole,
      label: ballName.trim() || `${typeLabel} ${ballWeight}lb`,
      weight: Number(ballWeight),
      thumbless: false,
    });
    setBallWeight("");
    setBallName("");
    setBallRole(ballRole === "strike" ? "spare" : "strike");
  };

  // 「次へ」: save this page, then move on. Returns false to stay (input missing).
  const saveAndNext = async () => {
    if (key === "names") {
      onSaveProfile({ nickname: nickname.trim() });
      onSavePlayerName(playerName.trim());
    } else if (key === "goals") {
      const ga = goalAverage === "" ? "" : String(Math.max(0, Math.min(300, Number(goalAverage) || 0)));
      const gs = goalScore === "" ? "" : String(Math.max(0, Math.min(300, Number(goalScore) || 0)));
      onSaveProfile({ dominantHand: hand, goalAverage: ga, goalScore: gs });
    } else if (key === "center") {
      onSaveProfile({ homeCenter: center.trim() });
    } else if (key === "balls") {
      if (ballWeight) addBall();
    } else if (key === "shoes") {
      if (shoeChoice === "own" && shoeName.trim() && !myShoes.some((s) => s.label === shoeName.trim())) {
        onAddShoe({ id: uid(), type: "own", label: shoeName.trim() });
      }
    } else if (key === "account") {
      if (!authUser) {
        if (!email.trim() || password.length < 6) return;
        await onSignup(email.trim(), password);
        return; // moves on once the account exists (see effect below)
      }
    }
    next();
  };

  // After signing up the account appears — continue to the last page.
  useEffect(() => {
    if (key === "account" && authUser && email) next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser]);

  const nextEnabled =
    key === "account" ? !!authUser || (email.trim() && password.length >= 6 && !authBusy) : key === "names" ? true : true;

  const titleOf = {
    textSize: "文字の大きさ",
    names: "お名前",
    goals: "利き手と目標",
    center: "よく行くボウリング場",
    balls: "使っているボール",
    shoes: "シューズ",
    account: "アカウントの作成",
  };

  const choice = (on) => ({
    flex: 1,
    padding: "12px 6px",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 15,
    ...toggleStyle(on),
  });

  let body = null;
  if (key === "welcome") {
    body = (
      <div className="flex flex-col items-center text-center" style={{ paddingTop: 24 }}>
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 72, height: 72, border: `2px solid ${COLORS.gold}`, background: "rgba(224,168,0,0.12)" }}
        >
          <Settings size={36} style={{ color: COLORS.gold }} />
        </div>
        <div style={{ color: COLORS.cream, fontSize: 22, fontWeight: 700, marginTop: 18 }}>ようこそ STRIKE LOG へ</div>
        <div style={{ color: COLORS.strike, fontSize: 15, lineHeight: 1.8, marginTop: 12 }}>
          <Phrases text="はじめに、|いくつか設定をします。|1〜2分で終わります。" />
        </div>
        <div style={{ color: COLORS.strike, opacity: 0.75, fontSize: 13, lineHeight: 1.7, marginTop: 10 }}>
          <Phrases text="どの項目も「あとで設定する」で|飛ばせます。あとから「設定」で|いつでも変えられます。" />
        </div>
      </div>
    );
  } else if (key === "textSize") {
    body = (
      <div className="space-y-4">
        <div style={{ color: COLORS.strike, fontSize: 14, lineHeight: 1.7 }}>見やすい大きさを選んでください。押すとすぐに変わります。</div>
        <TextSizeChooser value={textSize} onChange={onTextSize} />
        <div className="rounded-lg" style={{ padding: "10px 12px", background: "rgba(10,16,34,0.55)" }}>
          <div style={{ color: COLORS.strike, fontSize: 13 }}>アベレージ</div>
          <div style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 28, lineHeight: 1.2 }}>168.5</div>
          <div style={{ color: COLORS.strike, fontSize: 13 }}>ストライク率 32.4% ・ スペア率 41.0%</div>
        </div>
      </div>
    );
  } else if (key === "names") {
    body = (
      <div className="space-y-5">
        <SetupField label="ニックネーム" hint="アプリの中で表示される名前です。">
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="例: ヤマダ" maxLength={20} style={setupInputStyle} />
        </SetupField>
        <SetupField
          label="スコア画面に表示される自分の名前"
          hint="ボウリング場のスコア画面に出る名前を、そのとおりに入れてください(例: ヤマダ、YAMADA)。写真から自分の行を見つけるのに使います。"
        >
          <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="例: ヤマダ" maxLength={20} style={setupInputStyle} />
        </SetupField>
      </div>
    );
  } else if (key === "goals") {
    body = (
      <div className="space-y-5">
        <SetupField label="利き手">
          <div className="flex gap-2">
            <button type="button" onClick={() => setHand("right")} style={choice(hand === "right")}>
              右
            </button>
            <button type="button" onClick={() => setHand("left")} style={choice(hand === "left")}>
              左
            </button>
          </div>
        </SetupField>
        <SetupField label="目標アベレージ" hint="記録タブで、目標まであといくつかを表示します。">
          <input type="number" inputMode="numeric" min={0} max={300} value={goalAverage} onChange={(e) => setGoalAverage(e.target.value)} placeholder="例: 180" style={setupInputStyle} />
        </SetupField>
        <SetupField label="目標スコア(1ゲームの最高点)">
          <input type="number" inputMode="numeric" min={0} max={300} value={goalScore} onChange={(e) => setGoalScore(e.target.value)} placeholder="例: 250" style={setupInputStyle} />
        </SetupField>
      </div>
    );
  } else if (key === "center") {
    body = (
      <SetupField label="ホームセンター" hint="スコアを記録する時に、最初から選ばれた状態になります。">
        <CenterPicker value={center} onChange={setCenter} known={knownCenters} />
      </SetupField>
    );
  } else if (key === "balls") {
    body = (
      <div className="space-y-4">
        {myBalls.length > 0 && (
          <div className="space-y-1.5">
            <div style={{ color: COLORS.strike, fontSize: 13 }}>登録済み</div>
            {myBalls.map((b) => (
              <div key={b.id} className="flex items-center gap-2 rounded-lg" style={{ padding: "8px 10px", border: "1px solid rgba(224,168,0,0.35)" }}>
                <Check size={16} style={{ color: COLORS.gold, flexShrink: 0 }} />
                <span style={{ color: COLORS.cream, fontWeight: 700, fontSize: 14 }}>{b.label}</span>
                <span style={{ color: COLORS.strike, fontSize: 12 }}>{b.role === "spare" ? "スペアボール" : "1stボール"}</span>
              </div>
            ))}
          </div>
        )}
        <SetupField label="種類">
          <div className="flex gap-2">
            <button type="button" onClick={() => setBallType("own")} style={choice(ballType === "own")}>
              マイボール
            </button>
            <button type="button" onClick={() => setBallType("house")} style={choice(ballType === "house")}>
              ハウスボール
            </button>
          </div>
        </SetupField>
        <SetupField label="用途">
          <div className="flex gap-2">
            <button type="button" onClick={() => setBallRole("strike")} style={choice(ballRole === "strike")}>
              1stボール
            </button>
            <button type="button" onClick={() => setBallRole("spare")} style={choice(ballRole === "spare")}>
              スペアボール
            </button>
          </div>
        </SetupField>
        <SetupField label="重さ">
          <select value={ballWeight} onChange={(e) => setBallWeight(e.target.value)} style={setupInputStyle}>
            <option value="">選んでください</option>
            {Array.from({ length: 11 }, (_, i) => 6 + i).map((w) => (
              <option key={w} value={w}>
                {w}ポンド
              </option>
            ))}
          </select>
        </SetupField>
        {ballType === "own" && (
          <SetupField label="ボールの名前(任意)">
            <input value={ballName} onChange={(e) => setBallName(e.target.value)} placeholder="例: フェイズ2" maxLength={30} style={setupInputStyle} />
          </SetupField>
        )}
        <button
          type="button"
          onClick={addBall}
          disabled={!ballWeight}
          className="w-full rounded-xl flex items-center justify-center gap-1"
          style={{ padding: "11px 12px", border: `1px dashed ${COLORS.oak}`, color: COLORS.strike, fontSize: 14, fontWeight: 700, opacity: ballWeight ? 1 : 0.5 }}
        >
          <Plus size={16} /> このボールを登録して、もう1つ追加する
        </button>
        <div style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12.5, lineHeight: 1.6 }}>
          ボールの細かい情報(コアの種類など)は、あとから「設定」で追加できます。
        </div>
      </div>
    );
  } else if (key === "shoes") {
    body = (
      <div className="space-y-4">
        <div className="flex gap-2">
          <button type="button" onClick={() => setShoeChoice("rental")} style={choice(shoeChoice === "rental")}>
            レンタル
          </button>
          <button type="button" onClick={() => setShoeChoice("own")} style={choice(shoeChoice === "own")}>
            マイシューズ
          </button>
        </div>
        {shoeChoice === "own" && (
          <SetupField label="シューズの名前">
            <input value={shoeName} onChange={(e) => setShoeName(e.target.value)} placeholder="例: ABS NV-1" maxLength={30} style={setupInputStyle} />
          </SetupField>
        )}
      </div>
    );
  } else if (key === "account") {
    body = authUser ? (
      <div className="flex items-center gap-3 rounded-lg" style={{ padding: "12px", border: "1px solid rgba(224,168,0,0.4)" }}>
        <CircleCheck size={26} style={{ color: COLORS.gold, flexShrink: 0 }} />
        <div>
          <div style={{ color: COLORS.cream, fontWeight: 700, fontSize: 15 }}>アカウントは作成済みです</div>
          <div style={{ color: COLORS.strike, fontSize: 13 }}>{authUser.email}</div>
        </div>
      </div>
    ) : (
      <div className="space-y-4">
        <div className="space-y-1.5">
          {["記録がクラウドにも保存されます", "機種変更しても、ログインするだけで記録を引き継げます"].map((t) => (
            <div key={t} className="flex gap-2" style={{ color: COLORS.strike, fontSize: 13.5, lineHeight: 1.6 }}>
              <Check size={16} style={{ color: COLORS.gold, flexShrink: 0, marginTop: 3 }} />
              <span>{t}</span>
            </div>
          ))}
        </div>
        <SetupField label="メールアドレス">
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="example@mail.com" style={setupInputStyle} />
        </SetupField>
        <SetupField label="パスワード(6文字以上)">
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} style={setupInputStyle} />
        </SetupField>
        {authErrorMsg && <div style={{ color: "#E8836A", fontSize: 13, fontWeight: 700 }}>{authErrorMsg}</div>}
      </div>
    );
  } else if (key === "done") {
    body = (
      <div className="flex flex-col items-center text-center" style={{ paddingTop: 24 }}>
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 72, height: 72, border: `2px solid ${COLORS.gold}`, background: "rgba(224,168,0,0.12)" }}
        >
          <CircleCheck size={38} style={{ color: COLORS.gold }} />
        </div>
        <div style={{ color: COLORS.cream, fontSize: 22, fontWeight: 700, marginTop: 18 }}>準備ができました</div>
        <div style={{ color: COLORS.strike, fontSize: 15, lineHeight: 1.8, marginTop: 12 }}>
          <Phrases text="ボウリング場のスコア画面を|撮影して、記録してみましょう。" />
        </div>
        <a href="/guide" target="_blank" rel="noreferrer" style={{ color: COLORS.gold, fontSize: 14, fontWeight: 700, marginTop: 16, textDecoration: "underline" }}>
          使い方ガイドを見る
        </a>
      </div>
    );
  }

  const isEnd = key === "done";
  const isStart = key === "welcome";
  return (
    <div
      role="dialog"
      aria-label="はじめの設定"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        display: "flex",
        flexDirection: "column",
        background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`,
        fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif",
      }}
    >
      {!isStart && !isEnd && (
        <div style={{ padding: "calc(env(safe-area-inset-top) + 14px) 20px 0" }}>
          <div className="flex items-center justify-between" style={{ color: COLORS.strike, fontSize: 13 }}>
            <button type="button" onClick={back} className="flex items-center gap-1" style={{ color: COLORS.strike, padding: "4px 0" }}>
              <ChevronLeft size={18} /> 戻る
            </button>
            <span>
              {step} / {total}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 999, background: "rgba(255,255,255,0.12)", marginTop: 8, overflow: "hidden" }}>
            <div style={{ width: `${(step / total) * 100}%`, height: "100%", background: COLORS.gold, borderRadius: 999, transition: "width 0.25s" }} />
          </div>
          <div style={{ color: COLORS.gold, fontSize: 21, fontWeight: 700, marginTop: 18 }}>{titleOf[key]}</div>
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px 20px" }}>
        <div className="max-w-md mx-auto">{body}</div>
      </div>
      <div style={{ padding: "12px 20px calc(env(safe-area-inset-bottom) + 14px)", borderTop: "1px solid rgba(224,168,0,0.2)" }}>
        <div className="max-w-md mx-auto space-y-2">
          <button
            type="button"
            onClick={isEnd ? onFinish : isStart ? next : saveAndNext}
            disabled={!nextEnabled}
            className="w-full rounded-xl flex items-center justify-center gap-2"
            style={{ ...primaryButtonStyle(!!nextEnabled), padding: "14px 12px", fontSize: 16 }}
          >
            {authBusy && key === "account" ? <Loader2 className="animate-spin" size={18} /> : null}
            {isEnd ? "はじめる" : isStart ? "設定をはじめる" : key === "account" && !authUser ? "作成して次へ" : "次へ"}
          </button>
          {!isEnd && (
            <button
              type="button"
              onClick={isStart ? onFinish : next}
              className="w-full rounded-xl"
              style={{ padding: "11px 12px", fontSize: 14, fontWeight: 700, color: COLORS.strike, border: "1px solid rgba(184, 153, 104, 0.6)" }}
            >
              {isStart ? "設定せずにはじめる" : "あとで設定する"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// 設定画面: the current plan and this month's counts.
function PlanUsage({ plan }) {
  const rows = [
    { key: "analyze", label: "スコアの読み取り" },
    { key: "chat", label: "AIチャット相談" },
  ];
  return (
    <div className="space-y-2" style={{ borderTop: "1px solid rgba(224,168,0,0.18)", paddingTop: 10 }}>
      <div className="flex items-center justify-between gap-2">
        <span style={{ color: COLORS.strike, opacity: 0.7, fontSize: 12 }}>ご利用中のプラン</span>
        <span style={{ color: COLORS.gold, fontWeight: 700, fontSize: 15 }}>
          {plan.id === "premium_plus" ? (
            <>
              プレミアム<ruby>＋<rt style={{ fontSize: 8 }}>プラス</rt></ruby>
            </>
          ) : (
            plan.label
          )}
        </span>
      </div>
      {rows.map((r) => {
        const limit = plan.limits?.[r.key];
        const used = plan.used?.[r.key];
        const full = limit != null && used != null && used >= limit;
        return (
          <div key={r.key} className="flex items-center justify-between gap-2">
            <span style={{ color: COLORS.strike, fontSize: 13 }}>今月の{r.label}</span>
            <span style={{ color: full ? "#E8836A" : COLORS.strike, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>
              {limit == null ? "回数無制限" : `${used ?? "ー"} / ${limit}回`}
            </span>
          </div>
        );
      })}
      {(plan.limits?.analyze != null || plan.limits?.chat != null) && (
        <div style={{ color: COLORS.strike, opacity: 0.6, fontSize: 11 }}>回数は{plan.resetsOn || "毎月1日"}に戻ります</div>
      )}
    </div>
  );
}

// A short "this is in プレミアム" line for features the current plan doesn't include.
function PlanLockNote({ text, inset = false }) {
  return (
    <div
      className="flex items-center gap-2"
      style={{
        color: COLORS.strike,
        fontSize: 13,
        lineHeight: 1.6,
        padding: inset ? "4px 12px 12px" : "8px 12px",
        borderRadius: inset ? 0 : 10,
        background: inset ? "transparent" : "rgba(224, 168, 0, 0.12)",
        border: inset ? "none" : "1px solid rgba(224, 168, 0, 0.4)",
      }}
    >
      {!inset && <Lock size={14} style={{ color: COLORS.gold, flexShrink: 0 }} />}
      <span>{text}</span>
    </div>
  );
}

// ---------- 使い方ガイド (/guide) ----------
// Public page (no login needed) linked from the flyer's QR code, the setup
// wizard and 設定. Light, paper-like design so it reads well on a phone and
// prints cleanly on A4 (see the print styles below).
const GUIDE_URL = "https://strike-log-app.vercel.app/";

function GuideShot({ src, alt, caption }) {
  return (
    <figure className="g-shot">
      <img src={src} alt={alt} loading="lazy" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function GuideSteps({ items, start = 1 }) {
  return (
    <ol className="g-steps">
      {items.map((t, i) => (
        <li key={i}>
          <span className="g-num">{i + start}</span>
          <span>{t}</span>
        </li>
      ))}
    </ol>
  );
}

function GuidePage() {
  const toc = [
    ["install", "アプリを入れる"],
    ["start", "使いはじめる"],
    ["record", "スコアを記録する"],
    ["history", "履歴を見る"],
    ["stats", "成績を見る"],
    ["more", "そのほかの機能"],
    ["plans", "料金プラン"],
    ["faq", "困ったときは"],
  ];
  return (
    <div className="g-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');
        .g-root { min-height: 100vh; background: #F6F1E6; color: #1E2340; font-family: 'Noto Sans JP', 'Hiragino Sans', sans-serif; font-size: 16px; line-height: 1.8; }
        .g-wrap { max-width: 760px; margin: 0 auto; padding: 0 16px 48px; }
        .g-hero { background: linear-gradient(160deg, #26305E 0%, #161D38 100%); color: #F5F1E4; padding: 28px 16px 26px; }
        .g-hero-in { max-width: 760px; margin: 0 auto; display: flex; gap: 18px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
        .g-logo { font-family: 'Oswald', sans-serif; font-weight: 700; font-size: 30px; letter-spacing: 0.04em; color: #E0A800; line-height: 1.1; }
        .g-title { font-size: 24px; font-weight: 700; margin-top: 4px; }
        .g-lead { font-size: 14.5px; opacity: 0.85; margin-top: 6px; }
        .g-qr { background: #fff; border-radius: 12px; padding: 8px; text-align: center; color: #1E2340; }
        .g-qr img { width: 112px; height: 112px; display: block; }
        .g-qr div { font-size: 11px; font-weight: 700; margin-top: 2px; }
        .g-toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 6px; padding: 0; list-style: none; }
        .g-toc a { display: inline-block; padding: 6px 12px; border-radius: 999px; background: #fff; border: 1px solid #D9CDB2; color: #1E2340; font-size: 14px; font-weight: 700; text-decoration: none; }
        .g-sec { margin-top: 34px; }
        .g-h2 { display: flex; align-items: center; gap: 10px; font-size: 21px; font-weight: 700; color: #1E2340; border-bottom: 3px solid #E0A800; padding-bottom: 6px; margin-bottom: 14px; }
        .g-h2 .g-badge { font-family: 'Oswald', sans-serif; background: #1E2340; color: #E0A800; border-radius: 8px; min-width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; font-size: 18px; }
        .g-h3 { font-size: 17px; font-weight: 700; margin: 18px 0 8px; }
        .g-card { background: #fff; border: 1px solid #E3D8C0; border-radius: 14px; padding: 14px 16px; }
        .g-grid2 { display: grid; grid-template-columns: 1fr; gap: 12px; }
        @media (min-width: 640px) { .g-grid2 { grid-template-columns: 1fr 1fr; } }
        .g-steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
        .g-steps li { display: flex; gap: 10px; align-items: flex-start; }
        .g-num { flex: none; width: 26px; height: 26px; border-radius: 50%; background: #E0A800; color: #1E2340; font-family: 'Oswald', sans-serif; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; font-size: 15px; margin-top: 2px; }
        .g-row { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start; }
        @media (min-width: 640px) { .g-row { grid-template-columns: 1fr 220px; } }
        .g-shot { margin: 0; text-align: center; }
        .g-shot img { width: 100%; max-width: 230px; border-radius: 18px; border: 6px solid #1E2340; box-shadow: 0 4px 14px rgba(0,0,0,0.15); }
        .g-shot figcaption { font-size: 13px; color: #5B6080; margin-top: 4px; }
        .g-shots { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
        .g-note { background: #FFF6D9; border-left: 4px solid #E0A800; border-radius: 8px; padding: 10px 12px; font-size: 14.5px; margin-top: 12px; }
        .g-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; font-size: 14.5px; }
        .g-table th, .g-table td { border: 1px solid #E3D8C0; padding: 8px 10px; text-align: center; vertical-align: middle; }
        .g-table th { background: #1E2340; color: #F5F1E4; font-weight: 700; }
        .g-table td:first-child { text-align: left; font-weight: 700; background: #FBF8F1; }
        .g-ok { color: #B88600; font-weight: 700; }
        .g-faq dt { font-weight: 700; margin-top: 12px; }
        .g-faq dt::before { content: "Q. "; color: #E0A800; font-family: 'Oswald', sans-serif; }
        .g-faq dd { margin: 2px 0 0; padding-left: 1.6em; }
        .g-foot { margin-top: 36px; font-size: 13.5px; color: #5B6080; text-align: center; }
        .g-foot a { color: #1E2340; }
        .g-print-only { display: none; }
        @page { size: A4; margin: 14mm 12mm; }
        @media print {
          .g-root { background: #fff; font-size: 11.5pt; line-height: 1.7; }
          .g-toc { display: none; }
          .g-hero { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .g-h2 .g-badge, .g-num, .g-table th, .g-note { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .g-sec { break-inside: auto; }
          .g-card, .g-row, figure, .g-table, .g-note, .g-faq-item { break-inside: avoid; }
          .g-h2 { break-after: avoid; }
          .g-shot img { max-width: 170px; box-shadow: none; }
          .g-print-only { display: block; }
          .g-grid2 { grid-template-columns: 1fr 1fr; }
          .g-row { grid-template-columns: 1fr 180px; }
        }
      `}</style>

      <header className="g-hero">
        <div className="g-hero-in">
          <div>
            <div className="g-logo">STRIKE LOG</div>
            <div className="g-title">使い方ガイド</div>
            <div className="g-lead">スコア画面を撮るだけで、記録と分析ができるボウリングアプリです。</div>
          </div>
          <div className="g-qr">
            <img src="/guide-img/qr.svg" alt="アプリのQRコード" />
            <div>アプリはこちら</div>
          </div>
        </div>
      </header>

      <main className="g-wrap">
        <ul className="g-toc">
          {toc.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>

        <section id="install" className="g-sec">
          <h2 className="g-h2">
            <span className="g-badge">1</span>アプリを入れる
          </h2>
          <p style={{ margin: "0 0 12px" }}>
            STRIKE LOG は、アプリストアからではなく、インターネットのページをスマホの「ホーム画面」に追加して使います。追加すると、ふつうのアプリと同じようにアイコンから開けます。
          </p>
          <div className="g-card" style={{ marginBottom: 12 }}>
            アドレス:<b>{GUIDE_URL.replace("https://", "").replace(/\/$/, "")}</b>
            <br />
            <span style={{ fontSize: 14, color: "#5B6080" }}>上のQRコードをスマホのカメラで読み取ると、すぐに開けます。</span>
          </div>
          <div className="g-grid2">
            <div className="g-card">
              <div className="g-h3" style={{ marginTop: 0 }}>iPhone の場合(Safari)</div>
              <GuideSteps
                items={[
                  "Safari で上のアドレスを開く(QRコードからでもOK)",
                  "画面の下にある共有ボタン(四角から上向きの矢印のマーク)を押す。見当たらない時は「…」を押すと出てきます",
                  "「ホーム画面に追加」を押す(出てこない時は、下へスクロール)",
                  "右上の「追加」を押すと、ホーム画面に STRIKE LOG のアイコンができます",
                ]}
              />
            </div>
            <div className="g-card">
              <div className="g-h3" style={{ marginTop: 0 }}>Android の場合(Chrome)</div>
              <GuideSteps
                items={[
                  "Chrome で上のアドレスを開く(QRコードからでもOK)",
                  "右上の「︙」(点が縦に3つのマーク)を押す",
                  "「ホーム画面に追加」または「アプリをインストール」を押す",
                  "「追加」(または「インストール」)を押すと、ホーム画面にアイコンができます",
                ]}
              />
            </div>
          </div>
          <div className="g-note">次からは、ホーム画面の STRIKE LOG のアイコンから開いてください。</div>
        </section>

        <section id="start" className="g-sec">
          <h2 className="g-h2">
            <span className="g-badge">2</span>使いはじめる
          </h2>
          <GuideSteps
            items={[
              "アイコンから STRIKE LOG を開き、画面の案内に沿って利用の手続きをします。手続きが終わると使えるようになります。",
              "はじめて使う時は「はじめの設定」が出てきます。1ページずつ入力して「次へ」を押してください。どの項目も「あとで設定する」で飛ばせて、あとから「設定」でいつでも変えられます。",
            ]}
          />
          <div className="g-card" style={{ marginTop: 12 }}>
            <div className="g-h3" style={{ marginTop: 0 }}>はじめの設定で入れるもの</div>
            <table className="g-table" style={{ fontSize: 14 }}>
              <tbody>
                {[
                  ["文字の大きさ", "標準・大きめ・特大から、見やすいものを選びます"],
                  ["ニックネーム", "アプリの中で表示される名前"],
                  ["スコア画面の名前", "ボウリング場のスコア画面に出る自分の名前(例: ヤマダ、YAMADA)。写真から自分の行を見つけるのに使います"],
                  ["利き手・目標", "目標アベレージと目標スコア。記録の画面で「あといくつ」が出ます"],
                  ["ホームセンター", "よく行くボウリング場"],
                  ["ボール", "マイボールやハウスボールの重さと用途(1stボール・スペアボール)"],
                  ["シューズ", "レンタルかマイシューズか"],
                  ["アカウント", "メールアドレスとパスワード。機種変更しても記録を引き継げます"],
                ].map(([a, b]) => (
                  <tr key={a}>
                    <td style={{ width: "34%" }}>{a}</td>
                    <td style={{ textAlign: "left" }}>{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="record" className="g-sec g-page">
          <h2 className="g-h2">
            <span className="g-badge">3</span>スコアを記録する
          </h2>
          <div className="g-row">
            <div>
              <GuideSteps
                items={[
                  "下の「スコア分析」を開き、「スコア画面に表示されている自分の名前」が合っているか確かめます",
                  "「スコア画面を撮影 / アップロード」を押して、ボウリング場のスコア画面(電光掲示板)や紙のスコアシートを撮ります。あとから、撮っておいた写真を選ぶこともできます",
                  "自分の行(名前から合計まで)を指でなぞって囲み、「解析する」を押します。プレミアム以上のプランでは、自動で切り取って読み取ります",
                ]}
              />
              <div className="g-note">
                <b>上手に撮るコツ</b>
                <br />
                ・画面の正面から、明るさの反射が入らないように撮る
                <br />
                ・自分の名前から合計までが、すべて写るようにする
                <br />
                ・1枚に何ゲーム分写っていても、まとめて読み取れます
              </div>
            </div>
            <GuideShot src="/guide-img/scan.jpg" alt="スコア分析の画面" caption="スコア分析の画面" />
          </div>
          <div className="g-row" style={{ marginTop: 18 }}>
            <div>
              <GuideSteps
                items={[
                  "読み取った結果がスコア表で出ます。写真と見比べて、違うところがあればマスを押して直せます。うまく読み取れなかった時は、確認してほしいフレームをお知らせします",
                  "プレー日・何ゲーム目・ボウリング場・使ったボール・シューズを選びます",
                  "「記録を保存」を押して完了です。自己ベストや目標を達成すると、お祝いの花火が上がります",
                ]}
                start={4}
              />
            </div>
            <GuideShot src="/guide-img/result.jpg" alt="読み取り結果の画面" caption="読み取った結果" />
          </div>
          <div className="g-shots">
            <GuideShot src="/guide-img/auto.jpg" alt="自動で切り取った画面" caption="自動で切り取り(プレミアム以上)" />
            <GuideShot src="/guide-img/save.jpg" alt="保存の画面" caption="ボウリング場やボールを選んで保存" />
          </div>
        </section>

        <section id="history" className="g-sec">
          <h2 className="g-h2">
            <span className="g-badge">4</span>履歴を見る
          </h2>
          <div className="g-row">
            <div>
              <p style={{ marginTop: 0 }}>
                下の「履歴」では、これまでの記録が日ごとにまとまっています。日付の欄には、その日のゲーム数・トータル・アベレージ・ハイゲームが出ます。
              </p>
              <GuideSteps
                items={[
                  "日付の欄を押すと、その日のゲームがスコア表で開きます",
                  "えんぴつのマークで記録を直せます(日付・ボウリング場・ボール・各フレームなど)",
                  "× のマークで記録を消せます",
                ]}
              />
            </div>
            <GuideShot src="/guide-img/history.jpg" alt="履歴の画面" caption="履歴の画面" />
          </div>
        </section>

        <section id="stats" className="g-sec">
          <h2 className="g-h2">
            <span className="g-badge">5</span>成績を見る
          </h2>
          <div className="g-row">
            <div>
              <p style={{ marginTop: 0 }}>下の「記録」では、期間を選んで成績を見られます。</p>
              <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                <li>日・週・月・年・期間指定で切り替え(年と期間指定はプレミアム以上)</li>
                <li>アベレージ、トータル、ハイゲーム・ローゲーム、目標まであといくつ</li>
                <li>ストライク・スペア・スプリットなどの回数と割合</li>
                <li>スコアの推移のグラフ</li>
                <li>「日」では、その日のゲームをスコア表で縦に並べて表示</li>
                <li>ボール別・ボウリング場別の成績(プレミアム以上)</li>
              </ul>
              <div className="g-note">「用語と計算式」を開くと、ストライク率などの意味と計算のしかたが見られます。</div>
            </div>
            <GuideShot src="/guide-img/stats.jpg" alt="成績の画面" caption="記録(成績)の画面" />
          </div>
        </section>

        <section id="more" className="g-sec g-page">
          <h2 className="g-h2">
            <span className="g-badge">6</span>そのほかの機能
          </h2>
          <div className="g-grid2">
            {[
              ["ランキング", "アカウントを作ると、月間ランキングに参加できます(参加は自由)。表示されるのは、自分で決めた表示名と成績だけです。"],
              ["AIチャット相談", "右上の吹き出しのマークから、アプリの使い方やボウリング用語について質問できます。"],
              ["お知らせ", "右上のベルのマークで、アップデートやイベントのお知らせを確認できます。"],
              ["設定", "文字の大きさ、目標、ボール・シューズの登録や変更、アカウントの作成・ログインができます。「はじめの設定をやり直す」もここからできます。"],
            ].map(([t, d]) => (
              <div className="g-card" key={t}>
                <div className="g-h3" style={{ marginTop: 0 }}>{t}</div>
                <div style={{ fontSize: 15 }}>{d}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="plans" className="g-sec">
          <h2 className="g-h2">
            <span className="g-badge">7</span>料金プラン
          </h2>
          <table className="g-table">
            <thead>
              <tr>
                <th></th>
                <th>ベーシック</th>
                <th>プレミアム</th>
                <th>
                  プレミアム<ruby>＋<rt style={{ fontSize: 9 }}>プラス</rt></ruby>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>月額(税込)</td>
                <td>1,000円</td>
                <td>2,000円</td>
                <td>3,000円</td>
              </tr>
              <tr>
                <td>スコアの読み取り</td>
                <td>月60回</td>
                <td>月150回</td>
                <td className="g-ok">回数無制限</td>
              </tr>
              <tr>
                <td>AIチャット相談</td>
                <td>月30回</td>
                <td>月150回</td>
                <td className="g-ok">回数無制限</td>
              </tr>
              <tr>
                <td>自動で切り取って読み取り</td>
                <td>ー</td>
                <td className="g-ok">○</td>
                <td className="g-ok">○</td>
              </tr>
              <tr>
                <td>年・期間指定のグラフ、ボール別・ボウリング場別の成績</td>
                <td>ー</td>
                <td className="g-ok">○</td>
                <td className="g-ok">○</td>
              </tr>
            </tbody>
          </table>
          <div className="g-note">
            回数は毎月1日に戻ります。お支払いは毎月1日です(1〜15日のお申し込みは翌月1日から、16日〜末日のお申し込みは翌々月1日から)。くわしくは
            <a href="/terms">利用規約</a>をご覧ください。
          </div>
        </section>

        <section id="faq" className="g-sec">
          <h2 className="g-h2">
            <span className="g-badge">8</span>困ったときは
          </h2>
          <dl className="g-faq">
            {[
              ["読み取った数字が間違っている", "スコア表のマスを押すと直せます。保存したあとでも、「履歴」のえんぴつのマークから直せます。"],
              ["自分の行が見つからないと出る", "「スコア画面に表示されている自分の名前」が、スコア画面の表示と同じか確かめてください。指で自分の行を囲んで解析することもできます。"],
              ["文字が小さくて読みにくい", "「設定」の文字の大きさで、「大きめ」や「特大」に変えられます。"],
              ["機種変更する", "アカウントを作っておけば、新しいスマホでログインするだけで記録を引き継げます。同時に使えるのは1台のスマホだけです。"],
              ["今月の回数を使い切った", "毎月1日に回数が戻ります。たくさん使う方は、上のプランへの変更もご検討ください。写真はスマホのカメラで撮って残しておくと、あとから選んで記録できます。"],
              ["解約したい", "アプリ内の設定、またはお問い合わせ先からいつでも解約できます。解約後も記録は1年間保管されます。"],
            ].map(([q, a]) => (
              <div key={q} className="g-faq-item">
                <dt>{q}</dt>
                <dd>{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <footer className="g-foot">
          お問い合わせ:smmryut.9021@gmail.com
          <br />
          <a href="/terms">利用規約</a> ・ <a href="/privacy">プライバシーポリシー</a> ・ <a href="/tokushoho">特定商取引法に基づく表記</a>
          <div className="g-print-only" style={{ marginTop: 8 }}>
            最新のガイドは {GUIDE_URL}guide で見られます
          </div>
        </footer>
      </main>
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

第3条(アカウント)
1つのアカウントで同時に利用できる端末は1台です。新しい端末でログインすると、それまで使っていた端末は自動的にログアウトされます。利用者は、アカウントを第三者に利用させてはなりません。

第4条(料金プラン)
本サービスには以下の有料プランがあります(価格はいずれも税込)。
・ベーシック:月額1,000円
・プレミアム:月額2,000円
・プレミアム＋:月額3,000円
各プランで利用できる機能と、各機能の1か月あたりの利用回数の上限は以下の通りです。
・ベーシック:スコアの読み取り(自分の行を指で囲んで読み取る方式)月60回、AIチャット相談 月30回
・プレミアム:スコアの読み取り(自分の行を自動で見つけて読み取る方式を含む)月150回、AIチャット相談 月150回、期間別のグラフ、ボール別・ボウリング場別の成績
・プレミアム＋:プレミアムのすべての機能を、スコアの読み取り・AIチャット相談ともに回数の上限なく利用できます
利用回数は毎月1日に戻ります。上限に達した場合、その月はその機能を利用できなくなりますが、それまでの記録や他の機能はそのまま利用できます。
プレミアム＋を含むすべてのプランにおいて、運営者は、公平なサービス提供のため、通常の利用の範囲を著しく超える利用や、プログラム等による自動的な利用が認められた場合、その利用者の利用を制限することがあります。

第5条(料金の支払い)
料金はクレジットカード決済による自動継続課金とします。請求日は全利用者共通で、毎月1日とします。初回はお申し込み時に1か月分を課金し、日割り計算は行いません。2回目以降は、次の通り毎月1日に自動的に請求されます。
・毎月1日〜15日にお申し込みの場合:お申し込みの翌月1日から
・毎月16日〜末日にお申し込みの場合:お申し込みの翌々月1日から

第6条(プランの変更)
利用者は、アプリ内からいつでもプランを変更できます。変更後の料金は、次回の請求日から適用されます。

第7条(紹介特典)
本サービスを利用中の利用者が新たな利用者を紹介し、紹介された方が有料プランの利用を開始した場合、紹介した利用者の翌月分の料金を半額とします。特典の適用は1か月につき1回までとします。運営者は、不正な利用が認められた場合、特典を適用しないことがあります。

第8条(禁止事項)
利用者は以下の行為を行ってはなりません。
・法令または公序良俗に違反する行為
・本サービスの運営を妨害する行為
・他の利用者に迷惑をかける行為
・不正アクセスやシステムの脆弱性を悪用する行為
・アカウントの共有、譲渡、売買

第9条(解約)
利用者はいつでも解約できます。解約後は次回請求日以降の課金が停止しますが、既にお支払いいただいた分の返金は行いません。
解約後も、アカウントに保存された記録は解約日から1年間保管し、その間に利用を再開した場合は元の記録を引き続き利用できます。1年を過ぎた記録は削除します。

第10条(サービスの変更・停止・終了)
運営者は、システムの保守、障害、その他やむを得ない事情がある場合、事前の通知なく本サービスの全部または一部を一時的に停止できるものとします。また、運営者は本サービスの内容を変更し、または本サービスの提供を終了することがあります。終了する場合は、本サービス上で事前にお知らせします。

第11条(免責事項)
運営者は、本サービスの内容(AIによる解析結果を含む)の正確性・完全性について保証しません。アカウントを作成していない場合、記録は利用者の端末内にのみ保存されるため、機種変更、端末の故障・紛失、ブラウザのデータ削除などにより失われることがあり、運営者は復元できません。本サービスの利用により生じた損害について、運営者は故意または重過失がある場合を除き責任を負いません。

第12条(規約の変更)
運営者は、必要に応じて本規約を変更できるものとし、変更後の規約は本サービス上に掲示した時点で効力を生じます。

第13条(準拠法・管轄)
本規約の解釈には日本法を準拠法とし、本サービスに関して紛争が生じた場合には、運営者の所在地を管轄する裁判所を専属的合意管轄とします。

制定日:2026年8月17日
改定日:2026年10月21日`,
    },
    privacy: {
      title: "プライバシーポリシー",
      body: `下村優斗(以下「運営者」)は、「STRIKE LOG」(以下「本サービス」)における利用者の情報の取り扱いについて、以下の通りプライバシーポリシーを定めます。

1. 取得する情報
・メールアドレス(お申し込み時、およびアカウントを作成された場合)
・お名前(2026年10月以前に利用申請をされた方が入力した表示名)
・端末を識別するための番号(本サービスが端末ごとに発行するもの)
・スコアシートの写真
・記録されたスコア・統計データ、登録されたボール・シューズ等の情報
・記録時に選択・入力されたボウリング場の名称
・月間ランキングへの参加の有無、ランキング表示名、および任意で登録された年代・性別
・サポートチャットでの質問内容
・改善要望として送信された内容
・本サービスの利用状況(スコア解析・サポートチャットの利用回数と日時、読み取り結果の修正の有無など)

2. 利用目的
・本サービスの提供(スコアの自動読み取りなど)のため
・利用申請の承認・本人確認、料金の請求・領収書の送付のため
・機種変更時などに、記録を新しい端末へ引き継ぐため
・お問い合わせ・改善要望への対応のため
・紹介特典の適用のため
・利用状況の把握、サービスの品質改善、および公平な利用のための利用量の管理のため
・月間ランキングの集計・表示のため(参加を選択された場合)

3. AIサービスの利用について
スコア画像の解析とサポートチャットの回答には、Anthropic社のClaude APIを利用しています。解析のためにアップロードされた画像、およびサポートチャットでの質問内容は、処理の目的でAnthropic社のサーバーに送信されます。スコアシートの写真は読み取りのためだけに送信し、運営者のサーバーには保存しません。

4. 月間ランキングについて
月間ランキングへの参加を選択された利用者のランキング表示名と月間の成績(アベレージ、ハイゲーム、ゲーム数)は、ランキングを閲覧する他の利用者にも表示されます。任意で登録された年代・性別、および各ゲームで使用したボールの種類(ハウスボール・マイボール)は、ランキングの絞り込みにのみ使用し、それ自体を他の利用者に表示することはありません。ただし、絞り込んだランキングに表示されることにより、その条件に該当することが他の利用者に推測される場合があります。メールアドレス、ID、写真は他の利用者に表示されません。参加は設定画面からいつでも取りやめることができ、取りやめた時点でランキングに表示されなくなります。また、運営者は公平な運営のため、特定の利用者をランキングの対象外とする場合があります。

5. 外部サービスの利用
本サービスは、データの保存にGoogle Firebaseを、決済処理にStripeを利用しています。それぞれの外部サービスにおける情報の取り扱いは、各社のプライバシーポリシーに準じます。

6. 第三者提供
運営者は、法令に基づく場合を除き、利用者の同意なく個人情報を第三者に提供しません。

7. 情報の管理
運営者は、取得した情報の漏洩・滅失・毀損の防止のため、適切な安全管理措置を講じます。

8. 保管期間
・アカウントに保存された記録は、利用中は保管し、解約した場合は解約日から1年間保管したのち削除します。
・アカウントを作成していない場合、記録は利用者の端末内にのみ保存され、運営者のサーバーには保存されません。機種変更やブラウザのデータ削除などにより失われることがあり、運営者は復元できません。記録を残したい場合はアカウントの作成をおすすめします。
・スコアシートの写真は、運営者のサーバーには保存しません。

9. 開示・削除等の請求
利用者は、運営者に対して、自己の個人情報の開示・訂正・削除を請求できます。ご希望の場合は下記お問い合わせ先までご連絡ください。削除のご依頼を受けた場合は、ご本人であることを確認のうえ、30日以内に削除します。

10. お問い合わせ先
smmryut.9021@gmail.com

制定日:2026年8月17日
改定日:2026年10月21日`,
    },
    tokushoho: {
      title: "特定商取引法に基づく表記",
      body: `販売事業者名:下村優斗

運営統括責任者:下村優斗

所在地:ご請求をいただいた場合、メールにて遅滞なく開示いたします

電話番号:ご請求をいただいた場合、メールにて遅滞なく開示いたします

メールアドレス:smmryut.9021@gmail.com

販売価格:ベーシックプラン 月額1,000円(税込)/プレミアムプラン 月額2,000円(税込)/プレミアム＋プラン 月額3,000円(税込)

商品代金以外の必要料金:インターネット接続に伴う通信費は利用者のご負担となります。

支払方法:クレジットカード決済(Stripe)

支払時期:お申し込み時に初回1か月分を課金し(日割り計算はありません)、以後は毎月1日に自動課金されます。なお、2回目の課金は、1日〜15日のお申し込みの場合は翌月1日、16日〜末日のお申し込みの場合は翌々月1日となります。

サービス提供時期:決済完了後、即時にご利用いただけます。

動作環境:インターネットに接続できるスマートフォン(iPhoneのSafari、AndroidのChromeの最新版を推奨)

返品・返金について:サービスの性質上、返金・返品には対応しておりません。解約はいつでも可能ですが、既にお支払いいただいた分の返金は行いません。

解約方法:アプリ内設定画面、または上記お問い合わせ先までご連絡ください。次回請求日以降の課金が停止します。`,
    },
  };

  const content = pages[page];

  return (
    <div style={{ minHeight: "calc(100vh / var(--app-zoom, 1))", background: `linear-gradient(160deg, ${COLORS.navyLight} 0%, ${COLORS.navyBg} 55%, #161D38 100%)`, padding: 24 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');`}</style>
      <div className="max-w-xl mx-auto" style={{ fontFamily: "'Noto Sans JP', sans-serif" }}>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.strike, marginBottom: 4 }}>
          STRIKE LOG
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: COLORS.cream, marginBottom: 16 }}>{content.title}</h1>
        <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.8, color: COLORS.cream }}>{content.body.split("＋").map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ruby>＋<rt style={{ fontSize: 9 }}>プラス</rt></ruby>}
            {part}
          </React.Fragment>
        ))}</div>
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
  const guideRoute = typeof window !== "undefined" && /^\/guide\/?$/.test(window.location.pathname);
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
  // The person's plan and this month's counts (api/_plans.js). null until
  // the server has answered; then { id, label, premiumStats, autoLocate,
  // limits: { analyze, chat }, used: { analyze, chat } | null, resetsOn }.
  const [planInfo, setPlanInfo] = useState(null);
  const [planNotice, setPlanNotice] = useState(""); // "プレミアムで使えます" etc.
  const [authUser, setAuthUser] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authErrorMsg, setAuthErrorMsg] = useState("");
  const [authInfoMsg, setAuthInfoMsg] = useState(""); // e.g. 「再設定メールを送信しました」
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
  const [locating, setLocating] = useState(false); // プレミアム: finding the player's row automatically
  const [locateMissed, setLocateMissed] = useState(false); // auto-find failed → asked to box by finger
  const [autoCropped, setAutoCropped] = useState(false); // the current box came from auto-find
  const [celebration, setCelebration] = useState(null); // achievements to celebrate, or null
  const [saveBlockItems, setSaveBlockItems] = useState(null); // what's still unselected when 記録を保存 is pressed
  const [rolePromptDismissed, setRolePromptDismissed] = useState(false); // 「あとで」 for this session
  const [announcements, setAnnouncements] = useState([]); // active お知らせ, newest first
  const [bellOpen, setBellOpen] = useState(false);
  const [annReadIds, setAnnReadIds] = useState(() => readIdList(ANN_READ_KEY));
  const [eventPopup, setEventPopup] = useState(null);
  const [textSize, setTextSize] = useState(() => readTextSize() || "normal");
  const [textSizeAsk, setTextSizeAsk] = useState(() => !readTextSize()); // まだ選んでいなければ、最初に1回だけ聞く
  const [setupOpen, setSetupOpen] = useState(false); // 初回設定の案内
  const [setupStep, setSetupStep] = useState(0);
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
  const [center, setCenter] = useState(""); // ボウリング場 for the game being recorded
  const [storageLoaded, setStorageLoaded] = useState(false); // games, profile, balls… all read at startup
  const [accountFormOpen, setAccountFormOpen] = useState(false); // 設定: account form shown?
  const [accountDone, setAccountDone] = useState(null); // "signup" | "login" — show the completion popup
  const [photoHash, setPhotoHash] = useState(null); // fingerprint of the chosen photo
  const [rankingOptIn, setRankingOptIn] = useState(false); // 月間ランキングに参加する
  const [rankingName, setRankingName] = useState(""); // ランキング表示名 (separate from the nickname)
  const [ageGroup, setAgeGroup] = useState(""); // "10s"…"70s+" or "" — only for ranking filters
  const [gender, setGender] = useState(""); // "male" | "female" | "" — only for ranking filters
  const [rankingNeedNickname, setRankingNeedNickname] = useState(false);
  const [accountNotice, setAccountNotice] = useState(null); // { kind: "created" | "login", email } → completion popup
  const [centerBackfillOpen, setCenterBackfillOpen] = useState(false); // ask which center past games were at
  const [centerBackfillDraft, setCenterBackfillDraft] = useState("");
  const [centerBackfillDismissed, setCenterBackfillDismissed] = useState(false);
  const [centerTouched, setCenterTouched] = useState(false);
  const [editCenter, setEditCenter] = useState("");
  const [selectedShoeId, setSelectedShoeId] = useState(null);
  const [myShoes, setMyShoes] = useState([]); // [{ id, type, label }]
  const [editingShoeNameId, setEditingShoeNameId] = useState(null);
  const [shoeNameDraft, setShoeNameDraft] = useState("");
  const [newShoeName, setNewShoeName] = useState("");
  const [newBallOpen, setNewBallOpen] = useState(false); // 設定の「新しいボールを登録」を開いているか
  const [newShoeOpen, setNewShoeOpen] = useState(false); // 設定の「新しいマイシューズを登録」を開いているか
  const [openDayGames, setOpenDayGames] = useState(() => new Set());
  const [openHistoryDays, setOpenHistoryDays] = useState(null); // 履歴: open days (null = just the newest) // 記録タブ「日」: games whose breakdown is open
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
          setRankingOptIn(!!p.rankingOptIn);
          if (p.rankingName) setRankingName(p.rankingName);
          if (p.ageGroup) setAgeGroup(p.ageGroup);
          if (p.gender) setGender(p.gender);
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
    loadAllFromStorage().then(() => setStorageLoaded(true));
  }, [loadAllFromStorage]);

  // Suggests the next game number for the selected date (existing games for
  // that date + 1), unless the person has manually edited the field for this
  // session — manual edits are never silently overwritten.
  useEffect(() => {
    if (gameNumberTouched) return;
    const sameDay = games.filter((g) => g.date === gameDate).length;
    setGameNumber(sameDay + 1);
  }, [gameDate, games, gameNumberTouched]);

  // For a 2nd+ game on the same day, start with the same shoes as the most
  // recent game recorded that day (same rule as the balls below). Runs again
  // once everything is read from storage, so the saved "shoe-config" read at
  // startup can't overwrite it. Never overrides a manual change in this session.
  useEffect(() => {
    if (shoeTouched || !storageLoaded) return;
    const sameDay = games.filter((g) => g.date === gameDate && g.shoe);
    if (sameDay.length === 0) return;
    const last = sameDay.reduce((a, b) =>
      (b.gameNumber || 0) > (a.gameNumber || 0) ||
      ((b.gameNumber || 0) === (a.gameNumber || 0) && (b.createdAt || 0) > (a.createdAt || 0))
        ? b
        : a
    );
    const type = last.shoe.type || "rental";
    setShoeType(type);
    if (type !== "own") {
      setSelectedShoeId(null);
      return;
    }
    // Registered id first; if that shoe was re-registered, find it by name.
    const id = last.shoe.shoeRegistryId;
    const own = myShoes.filter((x) => (x.type || "own") === "own");
    const found =
      (id && own.find((x) => x.id === id)) || (last.shoe.label && own.find((x) => x.label === last.shoe.label)) || null;
    setSelectedShoeId(found ? found.id : id || null);
  }, [gameDate, games, myShoes, shoeTouched, storageLoaded]);

  // ボウリング場 default: the one used earlier the same day, else the
  // ホームセンター, else the most recent one. A manual choice always wins.
  useEffect(() => {
    if (centerTouched) return;
    const byRecent = [...games].sort(
      (a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0)
    );
    const sameDay = byRecent.find((g) => g.date === gameDate && g.center);
    const last = byRecent.find((g) => g.center);
    setCenter((sameDay && sameDay.center) || homeCenter || (last && last.center) || "");
  }, [games, gameDate, homeCenter, centerTouched]);

  // For a 2nd+ game on the same day, start with the same balls (all of them —
  // 2nd, 3rd and on included) as the most recent game recorded that day.
  // Reads from saved games, so it still works after closing and reopening the
  // app between games. Never overrides a manual change in this session.
  useEffect(() => {
    if (ballTouched || !storageLoaded) return;
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
  }, [gameDate, games, myBalls, ballTouched, storageLoaded]);

  // Device-based access (users without an account). Waits until Firebase has
  // said whether an account is signed in, and ignores a late answer if an
  // account signs in meanwhile — otherwise a slow reply here could overwrite
  // the account's status and wrongly show the "not approved" screen.
  useEffect(() => {
    if (isAdminRoute || !deviceId || !authReady || authUser) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/access/status?deviceId=${encodeURIComponent(deviceId)}&usage=1`);
        const data = await res.json();
        if (cancelled) return;
        setAccessStatus(data.status || "not_found");
        if (data.plan) setPlanInfo(data.plan);
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
    let firstCheck = true; // this month's counts only on the first check, not every poll
    const check = async () => {
      try {
        const token = await authUser.getIdToken();
        const withUsage = firstCheck ? "&usage=1" : "";
        firstCheck = false;
        const res = await fetch(`/api/account/device-check?deviceId=${encodeURIComponent(deviceId)}${withUsage}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!cancelled && data.active === false) {
          await handleKickedOut();
        } else if (!cancelled) {
          setAccessStatus(data.status || "pending");
          if (data.requestNumber) setMyRequestNumber(data.requestNumber);
          // Polls carry the plan but not the counts — keep the counts we have
          // (unless the plan itself changed, e.g. after an upgrade).
          if (data.plan) setPlanInfo((prev) => (data.plan.used || !prev || prev.id !== data.plan.id ? data.plan : { ...data.plan, used: prev.used }));
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

  // 年・期間指定のグラフ、ボール別・ボウリング場別の成績 (プレミアム以上).
  // Until the server has answered, nothing is locked.
  const premiumStatsOk = !planInfo || planInfo.premiumStats !== false;
  useEffect(() => {
    if (!premiumStatsOk && (periodMode === "year" || periodMode === "custom")) setPeriodMode("month");
  }, [premiumStatsOk, periodMode]);

  // After each analysis / chat reply the server reports this month's count.
  useEffect(() => {
    setUsageListener((u) => {
      if (!u || !u.feature) return;
      setPlanInfo((prev) => (prev && prev.used ? { ...prev, used: { ...prev.used, [u.feature]: u.used } } : prev));
    });
    return () => setUsageListener(null);
  }, []);

  // 初回設定の案内: new users only (no records, no balls, no nickname yet),
  // once the app is open for them. People who already use the app never see
  // it — they're marked as done. For accounts, wait until the cloud records
  // have loaded, so someone logging in on a new phone isn't treated as new.
  useEffect(() => {
    if (isAdminRoute || !storageLoaded || accessStatus !== "approved" || setupOpen) return;
    if (authUser && syncState !== "ready") return;
    let done = false;
    try {
      done = !!localStorage.getItem(SETUP_DONE_KEY);
    } catch (e) {
      done = true; // storage unavailable — don't nag on every launch
    }
    if (done) return;
    const isNew = games.length === 0 && myBalls.length === 0 && !nickname.trim();
    if (isNew) {
      setSetupStep(0);
      setSetupOpen(true);
      setTextSizeAsk(false); // the wizard asks for the text size itself
    } else {
      try {
        localStorage.setItem(SETUP_DONE_KEY, "1");
      } catch (e) {
        // ignore
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminRoute, storageLoaded, accessStatus, authUser, syncState]);

  const finishSetup = () => {
    try {
      localStorage.setItem(SETUP_DONE_KEY, "1");
    } catch (e) {
      // ignore
    }
    saveTextSize(textSize);
    setTextSizeAsk(false);
    setAccountDone(null);
    setAccountNotice(null);
    setSetupOpen(false);
    setTab("scan");
    window.scrollTo(0, 0);
  };

  const setupSaveProfile = (patch) => {
    if ("nickname" in patch) setNickname(patch.nickname);
    if ("dominantHand" in patch) setDominantHand(patch.dominantHand);
    if ("goalAverage" in patch) setGoalAverage(patch.goalAverage);
    if ("goalScore" in patch) setGoalScore(patch.goalScore);
    if ("homeCenter" in patch) setHomeCenter(patch.homeCenter);
    saveProfile(patch);
  };

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
      setAccountDone("login");
      setAccountFormOpen(false);
      setAccountNotice({ kind: "login", email });
      setAccountFormOpen(false);
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
      setAccountDone("signup");
      setAccountFormOpen(false);
      setAccountNotice({ kind: "created", email });
      setAccountFormOpen(false);
    } catch (e) {
      if (e.code === "auth/email-already-in-use") setAuthErrorMsg("このメールアドレスは既に登録されています");
      else if (e.code === "auth/weak-password") setAuthErrorMsg("パスワードは6文字以上にしてください");
      else if (e.code === "auth/invalid-email") setAuthErrorMsg("メールアドレスの形式が正しくありません");
      else setAuthErrorMsg("登録に失敗しました。もう一度お試しください");
    } finally {
      setAuthBusy(false);
    }
  };

  // 「パスワードを忘れた方」: Firebase emails a link to set a new password.
  // The same message is shown whether or not the address is registered, so
  // the form can't be used to find out who has an account.
  const resetPassword = async (email) => {
    if (!auth) {
      setAuthErrorMsg("現在アカウント機能を利用できません。時間をおいてお試しください");
      return;
    }
    setAuthBusy(true);
    setAuthErrorMsg("");
    setAuthInfoMsg("");
    try {
      auth.languageCode = "ja"; // the email is sent in Japanese
      await sendPasswordResetEmail(auth, email);
      setAuthInfoMsg("パスワード再設定用のメールを送信しました。メール内のリンクから新しいパスワードを設定してください。届かない場合は、迷惑メールフォルダもご確認ください。");
    } catch (e) {
      if (e.code === "auth/invalid-email") setAuthErrorMsg("メールアドレスの形式が正しくありません");
      else if (e.code === "auth/user-not-found")
        setAuthInfoMsg("パスワード再設定用のメールを送信しました。メール内のリンクから新しいパスワードを設定してください。届かない場合は、迷惑メールフォルダもご確認ください。");
      else setAuthErrorMsg("送信に失敗しました。時間をおいてお試しください");
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
    if (eventPopupShownRef.current || eventPopup || textSizeAsk || setupOpen) return;
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
  }, [announcements, accessStatus, authUser, syncState, tab, celebration, chatOpen, bellOpen, eventPopup, textSizeAsk, setupOpen]);

  // 写真の「自分の行を囲む」画面は、指の位置と写真の位置を正確に合わせる必要があるので、
  // 開いている間だけ拡大を外す(閉じたら選んだ文字の大きさに戻す)
  useEffect(() => {
    // スマホは画面全体の拡大なので位置はずれない。パソコンの CSS zoom の時だけ外す
    applyTextSize(cropEditorOpen && usesCssZoom(textSize) ? "normal" : textSize);
  }, [cropEditorOpen, textSize]);

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
      if (!response.ok) throw new Error(friendlyAiError(data?.error, "チャット相談", data));
      reportUsage(data._usage);
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
    const next = { dominantHand, goalAverage, goalScore, homeCenter, nickname, rankingOptIn, rankingName, ageGroup, gender, ...patch };
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
    setNewBallOpen(false);
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
    setNewShoeOpen(false);
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

  // One-time: games recorded before ボウリング場 existed have none. Fill them
  // with the ホームセンター from settings; if that isn't set, ask once (and
  // save the answer as the ホームセンター too). Games that already have a
  // center are never changed. Runs on each person's own phone, since that's
  // where their records live.
  useEffect(() => {
    if (!storageLoaded || loadingGames) return;
    if (localStorage.getItem(CENTER_BACKFILL_KEY)) return;
    const missing = games.filter((g) => !(g.center || "").trim());
    if (!missing.length) {
      localStorage.setItem(CENTER_BACKFILL_KEY, "1");
      return;
    }
    const h = (homeCenter || "").trim();
    if (!h) {
      setCenterBackfillOpen(true);
      return;
    }
    // Not marked done here: another startup upgrade may save the game list at
    // the same moment and overwrite this. The effect runs again whenever the
    // games change, and only marks itself done (above) once none are missing.
    persistGames(games.map((g) => ((g.center || "").trim() ? g : { ...g, center: h })));
  }, [storageLoaded, loadingGames, games, homeCenter, persistGames]);

  const applyCenterBackfill = async (name) => {
    const n = name.trim();
    if (!n) return;
    await persistGames(games.map((g) => ((g.center || "").trim() ? g : { ...g, center: n })));
    if (!(homeCenter || "").trim()) {
      setHomeCenter(n);
      await saveProfile({ homeCenter: n });
    }
    setCenterBackfillOpen(false);
  };

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
    setLocateMissed(false);
    setAutoCropped(false);
    try {
      const rawUrl = await readFileAsDataUrl(file);
      setImagePreview(rawUrl);
    } catch (e) {
      // non-fatal: preview is best-effort, processing below still runs
    }
    try {
      const img = await loadImageFromFile(file);
      // A short fingerprint of the photo file, to spot the same photo used again.
      try {
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        setPhotoHash(
          [...new Uint8Array(digest)]
            .slice(0, 12)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
        );
      } catch (e) {
        setPhotoHash(null);
      }
      sourceImgRef.current = img;
      const { base64, mediaType } = renderImageForAI(img, null);
      setImageMeta({ base64, mediaType });
      setImagePreview(`data:${mediaType};base64,${base64}`);
      setCropRect(null);
      // プレミアム: find the player's row automatically and analyze it straight
      // away. If it can't be found (or no name is set), fall back to boxing
      // the row by finger, exactly like ベーシック.
      const name = playerName.trim();
      if (planInfo?.autoLocate && name) {
        setLocating(true);
        const rect = await locatePlayerRow(img, name);
        setLocating(false);
        if (sourceImgRef.current !== img) return; // another photo was picked meanwhile
        if (rect) {
          setCropRect(rect);
          setAutoCropped(true);
          runAnalysis(rect);
          return;
        }
        setLocateMissed(true);
      }
      setCropEditorOpen(true); // go straight to boxing the row, full screen
    } catch (e) {
      setLocating(false);
      setAnalyzeError(withPhotoTip(e.message));
    }
  };

  // rectOverride: a crop decided just now (auto-find), before state updates land.
  const runAnalysis = async (rectOverride) => {
    if (!imageMeta && !sourceImgRef.current) return;
    const rect = rectOverride && typeof rectOverride.w === "number" ? rectOverride : cropRect;
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      const built = sourceImgRef.current
        ? buildAnalysisImages(sourceImgRef.current, rect)
        : { images: [imageMeta], cropped: false, zoomed: false };
      const result = await analyzeScoreImage(built.images, playerName.trim(), built);
      const noScoreFound =
        result.screen_type === "none" || !Array.isArray(result.games) || result.games.length === 0;
      if (result.player_matched === false || noScoreFound) {
        const notScore = result.screen_type === "none" || (noScoreFound && !(result.other_players_detected || []).length);
        setPendingResult({ ...result, player_matched: false, notScore });
        if (notScore) reportAnalysisOutcome({ notScore: 1 });
      } else {
        const normalize = (res) =>
          (Array.isArray(res.games) ? res.games : []).map((game) => {
          const framesWithSplitRolls = (game.frames || []).map((f) => {
            const splitRolls = [];
            if (typeof f.split_roll_index === "number") splitRolls[f.split_roll_index] = true;
            return { ...f, splitRolls };
          });
          let norm = normalizeGame(framesWithSplitRolls);
          // Number(null) is 0, so an unreadable total must be kept as "none"
          // explicitly — otherwise it would count as a 0-point game.
          const rawTotal = game.total_score;
          const ocrTotal = rawTotal === null || rawTotal === undefined || rawTotal === "" ? NaN : Number(rawTotal);
          const hasOcrTotal = Number.isFinite(ocrTotal);
          // The per-frame cumulative numbers exactly as copied off the screen.
          // Prefer the row of cumulative scores the AI copied first
          // (screen_cumulative); fall back to each frame's score.
          const copied = Array.isArray(game.screen_cumulative) ? game.screen_cumulative : [];
          const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
          const ocrScores = (game.frames || []).slice(0, 10).map((f, i) => (Number.isFinite(num(copied[i])) ? num(copied[i]) : Number(f?.score)));
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
        let normalizedGames = normalize(result);
        // Didn't add up (a frame's marks and the cumulative score disagree)?
        // Take one more look before asking the user to fix it by hand: tell
        // the AI which frames were off and keep whichever reading has fewer
        // problems. Costs one more AI call, only when the first one failed.
        const flagged = normalizedGames.filter((g) => g.totalMismatch);
        if (flagged.length) {
          const lines = normalizedGames
            .map((g, i) =>
              g.totalMismatch
                ? `・${i + 1}つ目のゲーム: 読み取った累計スコアが [${g.ocrScores.map((n) => (Number.isFinite(n) ? n : "?")).join(", ")}] で、${(g.totalMismatch.frames || []).map((f) => `${f + 1}`).join("・") || "いくつかの"}フレーム目付近で投球の記号と累計が合いませんでした`
                : null
            )
            .filter(Boolean)
            .join("\n");
          const note = `【再確認のお願い】
前回この画像を読み取った結果、次の食い違いがありました。
${lines}
前回の読み取りは間違っている可能性が高いので、先入観を持たずに、もう一度最初から画像を見直してください。特に、累計スコアの段の数字(大きく表示されている数字)を1フレーム目から順に1つずつ正確に書き写し、その差分と投球の記号が合うかをフレームごとに確かめてください。行の取り違え(別のプレイヤーの行や、ヘッダーの行を読んでいないか)にも注意してください。出力形式は上と同じJSONのみです。`;
          try {
            const second = await analyzeScoreImage(built.images, playerName.trim(), { ...built, recheckNote: note });
            if (second && second.player_matched !== false && Array.isArray(second.games) && second.games.length) {
              const again = normalize(second);
              if (again.filter((g) => g.totalMismatch).length <= flagged.length) normalizedGames = again;
            }
          } catch (e) {
            // the first reading stands
          }
        }
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
    // The ボウリング場, every ball slot and (for マイシューズ) the shoes must be chosen first.
    const missing = [];
    if (!center.trim()) missing.push("ボウリング場");
    if (!selectedBallId || !myBalls.some((b) => b.id === selectedBallId)) missing.push("1stボール");
    if (useSecondBall && (!selectedBallId2 || !myBalls.some((b) => b.id === selectedBallId2))) missing.push("スペアボール");
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
      center: center.trim() || null,
      // 月間ランキング: the final score as read from the photo (hand edits to
      // the frames don't change it), and which photo it came from, so the
      // same photo uploaded twice is only counted once.
      photoTotal: Number.isFinite(g.ocrTotal) ? g.ocrTotal : null,
      photoKey: photoHash ? `${photoHash}:${idx}` : null,
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
    setCenterTouched(false);
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
    setEditCenter(g.center || "");
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
              center: editCenter.trim() || null,
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
  // isn't meaningful); longer periods (week / month / year / custom) show one
  // point per day played, using that day's average, since plotting every
  // single game gets cluttered once there are multiple games per day.
  const chartData =
    periodMode === "day"
      ? periodGames
          .slice()
          .sort((a, b) => (a.gameNumber || 1) - (b.gameNumber || 1))
          .map((g) => ({ label: `第${g.gameNumber || 1}G`, total: g.total }))
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
  if (guideRoute) return <GuidePage />;

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
        onReset={resetPassword}
        authBusy={authBusy}
        authErrorMsg={authErrorMsg}
        authInfoMsg={authInfoMsg}
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

      {setupOpen && (
        <SetupWizard
          step={setupStep}
          setStep={setSetupStep}
          textSize={textSize}
          onTextSize={(k) => {
            setTextSize(k);
            applyTextSize(k);
            saveTextSize(k);
          }}
          initial={{ nickname, playerName, dominantHand, goalAverage, goalScore, homeCenter }}
          knownCenters={knownCentersFrom(games, homeCenter)}
          myBalls={myBalls}
          myShoes={myShoes}
          authUser={authUser}
          authBusy={authBusy}
          authErrorMsg={authErrorMsg}
          onSaveProfile={setupSaveProfile}
          onSavePlayerName={savePlayerName}
          onAddBall={(ball) => persistMyBalls([...myBalls, ball])}
          onAddShoe={(shoe) => persistMyShoes([...myShoes, shoe])}
          onSignup={signupWithAccount}
          onFinish={finishSetup}
        />
      )}

      {textSizeAsk && !setupOpen && !celebration && (
        <TextSizeWelcome
          value={textSize}
          onChange={(k) => {
            setTextSize(k);
            applyTextSize(k);
          }}
          onDone={() => {
            saveTextSize(textSize);
            setTextSizeAsk(false);
          }}
        />
      )}

      {!textSizeAsk &&
        !setupOpen &&
        centerBackfillOpen &&
        !centerBackfillDismissed &&
        !accountDone &&
        !celebration &&
        !eventPopup &&
        !cropEditorOpen &&
        !saveBlockItems &&
        accessStatus === "approved" &&
        !myBalls.some((b) => b.role !== "strike" && b.role !== "spare") && (
          <AppModal
            title="これまでの記録のボウリング場"
            footer={
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => applyCenterBackfill(centerBackfillDraft)}
                  disabled={!centerBackfillDraft.trim()}
                  className="w-full rounded-lg py-3"
                  style={primaryButtonStyle(!!centerBackfillDraft.trim())}
                >
                  反映する
                </button>
                <button
                  type="button"
                  onClick={() => setCenterBackfillDismissed(true)}
                  className="w-full rounded-lg py-2.5 text-sm"
                  style={{ border: "1px solid rgba(184, 153, 104, 0.6)", color: COLORS.strike, fontWeight: 700 }}
                >
                  あとで設定する
                </button>
              </div>
            }
          >
            <div style={{ color: COLORS.strike, fontSize: 13, lineHeight: 1.7 }}>
              ボウリング場が未設定の記録が{games.filter((g) => !(g.center || "").trim()).length}
              ゲームあります。よく行くボウリング場を選ぶと、未設定の記録すべてに反映します。
            </div>
            <div style={{ marginTop: 10 }}>
              <CenterPicker value={centerBackfillDraft} onChange={setCenterBackfillDraft} known={knownCentersFrom(games, homeCenter)} />
            </div>
            <div style={{ color: COLORS.strike, opacity: 0.8, fontSize: 12.5, marginTop: 8 }}>
              選んだボウリング場は「ホームセンター」にも登録されます
            </div>
          </AppModal>
        )}

      {accountNotice && !setupOpen && accessStatus === "approved" && syncState !== "syncing" && !celebration && (
        <AppModal
          title={accountNotice.kind === "created" ? "アカウントを作成しました" : "ログインしました"}
          footer={
            <button type="button" onClick={() => setAccountNotice(null)} className="w-full rounded-lg py-3" style={primaryButtonStyle()}>
              OK
            </button>
          }
        >
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center rounded-full"
              style={{ width: 40, height: 40, flexShrink: 0, border: `1.5px solid ${COLORS.gold}`, background: "rgba(224,168,0,0.12)" }}
            >
              <Check size={22} style={{ color: COLORS.gold }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: COLORS.strike, opacity: 0.65, fontSize: 11.5 }}>メールアドレス</div>
              <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {accountNotice.email}
              </div>
            </div>
          </div>
          <div style={{ color: COLORS.strike, fontSize: 13, lineHeight: 1.7, marginTop: 12 }}>
            {accountNotice.kind === "created" ? (
              <>
                これからの記録は、クラウドにも自動で保存されます。
                <br />
                機種変更の時は、新しいスマホでこのメールアドレスとパスワードでログインしてください。
              </>
            ) : (
              <>記録の読み込みが完了しました。</>
            )}
          </div>
        </AppModal>
      )}

      {accountDone && !setupOpen && authUser && accessStatus === "approved" && syncState !== "syncing" && (
        <AppModal
          title={accountDone === "signup" ? "アカウントを作成しました" : "ログインしました"}
          footer={
            <button type="button" onClick={() => setAccountDone(null)} className="w-full rounded-lg py-3" style={primaryButtonStyle()}>
              OK
            </button>
          }
        >
          <div className="flex flex-col items-center" style={{ marginBottom: 12 }}>
            <div
              className="flex items-center justify-center rounded-full"
              style={{ width: 56, height: 56, border: `2px solid ${COLORS.gold}`, background: "rgba(224,168,0,0.12)" }}
            >
              <CircleCheck size={30} style={{ color: COLORS.gold }} />
            </div>
            <div style={{ color: COLORS.strike, fontSize: 13, marginTop: 8, opacity: 0.8 }}>{authUser.email}</div>
          </div>
          <div className="space-y-2">
            {(accountDone === "signup"
              ? ["これまでの記録は、クラウドにも保存されます", "機種変更しても、このメールアドレスとパスワードでログインすれば記録を引き継げます"]
              : ["このアカウントの記録を読み込みました", "この端末でアカウントを利用中です(同時に使えるのは1台のみ)"]
            ).map((t) => (
              <div key={t} className="flex gap-2" style={{ color: COLORS.strike, fontSize: 13, lineHeight: 1.6 }}>
                <Check size={16} style={{ color: COLORS.gold, flexShrink: 0, marginTop: 2 }} />
                <span>{t}</span>
              </div>
            ))}
          </div>
        </AppModal>
      )}

      {saveBlockItems && (
        <AppModal
          title="未選択の項目があります"
          footer={
            <button
              type="button"
              onClick={() => {
                const target = saveBlockItems[0] === "ボウリング場" ? "scan-center-card" : "scan-ball-card";
                setSaveBlockItems(null);
                document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        </AppModal>
      )}

      {(() => {
        // Balls whose role (1stボール / スペア) hasn't been set yet.
        const unset = myBalls.filter((b) => b.role !== "strike" && b.role !== "spare");
        const busy = celebration || eventPopup || cropEditorOpen || saveBlockItems || accountDone || setupOpen;
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
                      { key: "spare", label: "スペアボール" },
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
      {bellOpen && (
        <BellPanel
          items={announcements}
          readIds={annReadIds}
          onOpenItem={(id) => markAnnouncementsRead([id])}
          onClose={() => setBellOpen(false)}
        />
      )}
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
              <div
                className="tracking-wide"
                style={{
                  color: COLORS.cream,
                  fontFamily: "'Oswald', sans-serif",
                  fontWeight: 700,
                  // 24px normally; a little smaller on narrow phones so it stays on one line
                  fontSize: "clamp(19px, calc(6.4vw / var(--app-zoom, 1)), 24px)",
                  lineHeight: 1.25,
                  whiteSpace: "nowrap",
                }}
              >
                STRIKE LOG
              </div>
              <div className="text-xs mt-0.5" style={{ color: COLORS.strike }}>スコア分析 &amp; 記録</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                // Each one becomes "read" when it's opened (the red dot / badge stay until then).
                setBellOpen(true);
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

            {imagePreview && !pendingResult && locating && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Loader2 className="animate-spin" size={18} style={{ color: COLORS.gold, flexShrink: 0 }} />
                  <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 15 }}>「{playerName.trim()}」の行を探しています…</div>
                </div>
                <CropPreview src={imagePreview} rect={null} />
              </div>
            )}

            {imagePreview && !pendingResult && !locating && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Crop size={18} style={{ color: COLORS.gold, flexShrink: 0 }} />
                  <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 15 }}>
                    {autoCropped && cropRect ? "スコアの部分を自動で切り取りました" : "自分の行を指で囲む"}
                  </div>
                </div>
                <div style={{ color: COLORS.strike, opacity: 0.75, fontSize: 12 }}>
                  {autoCropped && cropRect
                    ? `この中から「${playerName.trim()}」の行を読み取ります`
                    : locateMissed
                    ? "自動で見つけられなかったので、指で囲んでください"
                    : "名前〜合計まで囲むと精度アップ(省略OK)"}
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
                      setAutoCropped(false);
                      setCropEditorOpen(false);
                    }}
                    onSkip={() => setCropEditorOpen(false)}
                  />
                )}
              </div>
            )}

            {imagePreview && !pendingResult && !locating && (
              <div className="flex gap-2">
                <button
                  onClick={() => runAnalysis()}
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
                    <span className="text-sm flex items-center gap-2" style={{ color: COLORS.cream, whiteSpace: "nowrap" }}>
                      <Hash size={16} style={{ flexShrink: 0 }} /> {pendingResult.games?.length > 1 ? "何ゲーム目から" : "何ゲーム目"}
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
                      <Phrases text={`${pendingResult.games.length}ゲーム分を、|${gameNumber}ゲーム目から|連番で保存します`} />
                    </div>
                  )}
                </div>

                <div id="scan-center-card" className="glass-card rounded-xl p-3 space-y-2">
                  <div className="text-sm flex items-center gap-2" style={{ color: COLORS.cream }}>
                    <MapPin size={16} /> ボウリング場
                  </div>
                  <CenterPicker
                    value={center}
                    onChange={(v) => {
                      setCenterTouched(true);
                      setCenter(v);
                    }}
                    known={knownCentersFrom(games, homeCenter)}
                  />
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
                              {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? "・1stボール" : b.role === "spare" ? "・スペアボール" : ""}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>

                  {useSecondBall && (
                    <div className="space-y-2" style={{ borderTop: `1px solid rgba(224, 168, 0, 0.3)`, paddingTop: 10 }}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ color: COLORS.oak }}>スペアボール</span>
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
                          aria-label="スペアボールを削除"
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
                                {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? "・1stボール" : b.role === "spare" ? "・スペアボール" : ""}
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
                                  {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? "・1stボール" : b.role === "spare" ? "・スペアボール" : ""}
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
            {(() => {
              // 履歴: grouped by day (newest first), each day folds open to show
              // its games stacked like the 記録 tab's score table. The newest
              // day starts open; month headings give a running overview.
              const byDate = new Map();
              for (const g of games) {
                const k = g.date || "";
                if (!byDate.has(k)) byDate.set(k, []);
                byDate.get(k).push(g);
              }
              const days = [...byDate.entries()]
                .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
                .map(([date, list]) => ({
                  date,
                  games: [...list].sort((a, b) => (a.gameNumber || 0) - (b.gameNumber || 0) || (a.createdAt || 0) - (b.createdAt || 0)),
                }));
              const monthOf = (d) => (d || "").slice(0, 7);
              const monthGames = new Map();
              for (const d of days) {
                const m = monthOf(d.date);
                monthGames.set(m, [...(monthGames.get(m) || []), ...d.games]);
              }
              const isOpen = (date, i) => (openHistoryDays ? openHistoryDays.has(date) : i === 0) || days[i].games.some((g) => g.id === editingGameId);
              const toggle = (date, i) =>
                setOpenHistoryDays((prev) => {
                  const next = new Set(prev || (days[0] ? [days[0].date] : []));
                  if (isOpen(date, i)) next.delete(date);
                  else next.add(date);
                  return next;
                });
              const ballLine = (g) => {
                const name = (b) => (b.label ? b.label : b.type === "own" ? "マイボール" : "ハウスボール");
                const parts = [];
                if (g.ball && (g.ball.weight || g.ball.type)) parts.push(name(g.ball));
                if (g.ball2 && (g.ball2.weight || g.ball2.type)) parts.push(`${name(g.ball2)}(スペア)`);
                (g.extraBalls || []).forEach((eb) => parts.push(name(eb)));
                if (g.shoe && g.shoe.type) parts.push(g.shoe.label ? g.shoe.label : g.shoe.type === "own" ? "マイシューズ" : "レンタルシューズ");
                return parts.join(" / ");
              };
              return days.map((day, di) => {
                const m = monthOf(day.date);
                const showMonth = di === 0 || monthOf(days[di - 1].date) !== m;
                const open = isOpen(day.date, di);
                const centers = [...new Set(day.games.map((g) => g.center).filter(Boolean))].join("・");
                const mSum = daySummary(monthGames.get(m) || []);
                return (
                  <React.Fragment key={day.date || "nodate"}>
                    {showMonth && (
                      <div className="flex items-baseline justify-between" style={{ padding: di ? "10px 2px 0" : "0 2px", color: COLORS.strike }}>
                        <span style={{ fontWeight: 700, fontSize: 15, color: COLORS.cream }}>
                          {/^\d{4}-\d{2}$/.test(m) ? `${m.slice(0, 4)}年${+m.slice(5)}月` : "日付なし"}
                        </span>
                        <span style={{ fontSize: 12 }}>
                          {mSum.count}ゲーム ・ アベレージ {mSum.avg ?? "ー"}
                        </span>
                      </div>
                    )}
                    <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: open ? COLORS.gold : COLORS.oak }}>
                      <button
                        type="button"
                        onClick={() => toggle(day.date, di)}
                        aria-expanded={open}
                        className="w-full text-left"
                        style={{ padding: "10px 12px 8px" }}
                      >
                        <div className="flex items-center justify-between gap-2" style={{ marginBottom: 6 }}>
                          <div className="flex items-baseline gap-2" style={{ minWidth: 0 }}>
                            <span style={{ color: COLORS.cream, fontWeight: 700, fontSize: 17, whiteSpace: "nowrap" }}>{formatDayLabel(day.date)}</span>
                            {centers && (
                              <span style={{ color: COLORS.strike, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{centers}</span>
                            )}
                          </div>
                          {open ? <ChevronDown size={18} style={{ color: COLORS.gold, flexShrink: 0 }} /> : <ChevronRight size={18} style={{ color: COLORS.gold, flexShrink: 0 }} />}
                        </div>
                        <DayTotals games={day.games} compact />
                      </button>
                      {open && (
                        <div style={{ padding: "4px 8px 10px", borderTop: "1px solid rgba(224, 168, 0, 0.3)" }}>
                          {day.games.map((g, gi) =>
                            editingGameId === g.id ? (
                <div key={g.id} className="rounded-xl p-3 border glass-card space-y-3" style={{ borderColor: COLORS.gold }}>
                  <div className="flex items-center justify-between gap-2">
                    <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 15, whiteSpace: "nowrap" }}>記録を編集中</div>
                    <div className="flex gap-2" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
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
                      style={{ borderColor: COLORS.oak, color: COLORS.ink, minWidth: 0 }}
                    />
                    <input
                      type="number"
                      min={1}
                      value={editGameNumber}
                      onChange={(e) => setEditGameNumber(Math.max(1, Number(e.target.value) || 1))}
                      className="w-12 px-1 py-1 rounded border text-sm text-center"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink, flexShrink: 0 }}
                    />
                    <span className="text-xs" style={{ color: COLORS.strike, whiteSpace: "nowrap", flexShrink: 0 }}>ゲーム目</span>
                  </div>

                  <div>
                    <div className="text-xs mb-1 flex items-center gap-1" style={{ color: COLORS.oak }}>
                      <MapPin size={12} /> ボウリング場
                    </div>
                    <CenterPicker value={editCenter} onChange={setEditCenter} known={knownCentersFrom(games, homeCenter)} />
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
                                {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? "・1stボール" : b.role === "spare" ? "・スペアボール" : ""}
                              </option>
                            ))}
                        </select>
                      )}
                    </div>

                    {editUseSecondBall && (
                      <div className="space-y-2" style={{ borderTop: `1px solid rgba(224, 168, 0, 0.3)`, paddingTop: 10 }}>
                        <div className="flex items-center justify-between">
                          <div className="text-xs" style={{ color: COLORS.oak }}>スペアボール</div>
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
                                  {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? "・1stボール" : b.role === "spare" ? "・スペアボール" : ""}
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
                                    {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""}){b.role === "strike" ? "・1stボール" : b.role === "spare" ? "・スペアボール" : ""}
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
                              <div key={g.id} style={{ marginTop: gi ? 10 : 4 }}>
                                <div className="flex items-center justify-between" style={{ padding: "2px 2px 4px" }}>
                                  <span style={{ color: COLORS.strike, fontWeight: 700, fontSize: 13 }}>{g.gameNumber ? `${g.gameNumber}ゲーム目` : "ゲーム"}</span>
                                  <div className="flex items-center gap-3">
                                    <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 17, color: COLORS.gold, lineHeight: 1 }}>{g.total}</span>
                                    <button onClick={() => startEditGame(g)} aria-label="編集" style={{ padding: 2 }}>
                                      <Pencil size={15} style={{ color: COLORS.strike }} />
                                    </button>
                                    <button onClick={() => setConfirmDeleteId(g.id)} aria-label="削除" style={{ padding: 2 }}>
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
                                <CompactScoreSheet frames={g.frames} />
                                {ballLine(g) && (
                                  <div className="flex items-start gap-1" style={{ color: COLORS.strike, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
                                    <CircleDot size={11} style={{ flexShrink: 0, marginTop: 3 }} />
                                    <span>{ballLine(g)}</span>
                                  </div>
                                )}
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                );
              });
            })()}
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
                  ].map((p) => {
                    const locked = !premiumStatsOk && (p.key === "year" || p.key === "custom");
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => {
                          if (locked) {
                            setPlanNotice("年・期間指定のグラフは、プレミアム以上のプランで使えます");
                            return;
                          }
                          setPlanNotice("");
                          setPeriodMode(p.key);
                        }}
                        className="rounded-lg py-2 text-sm flex items-center justify-center gap-1"
                        style={{
                          ...toggleStyle(periodMode === p.key),
                          // 「期間指定」 has 4 characters; the others have 1
                          flex: p.key === "custom" ? 2.2 : 1,
                          minWidth: 0,
                          whiteSpace: "nowrap",
                          padding: "8px 4px",
                          opacity: locked ? 0.55 : 1,
                        }}
                      >
                        {locked && <Lock size={12} />}
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                {planNotice && <PlanLockNote text={planNotice} />}

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
                    {/* Summary: the average as the headline, total and game count
                        beside it, high/low underneath — one card, like a score board. */}
                    <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                      <div className="flex items-end justify-between" style={{ padding: "14px 16px 12px" }}>
                        <div>
                          <div style={{ color: COLORS.strike, fontSize: 12, letterSpacing: "0.08em" }}>アベレージ</div>
                          <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 46, lineHeight: 1, color: COLORS.cream, marginTop: 4 }}>{avg}</div>
                        </div>
                        <div className="text-right">
                          <div style={{ color: COLORS.strike, fontSize: 12, letterSpacing: "0.08em" }}>トータル</div>
                          <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 28, lineHeight: 1.1, color: COLORS.gold }}>
                            {daySummary(periodGames).sum.toLocaleString()}
                          </div>
                          <div style={{ color: COLORS.strike, fontSize: 12, marginTop: 2 }}>
                            <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, color: COLORS.cream }}>{periodGames.length}</span> ゲーム
                          </div>
                        </div>
                      </div>
                      {(goalAverage || goalScore) && (
                        <div className="space-y-2" style={{ padding: "10px 16px 12px", borderTop: "1px solid rgba(224, 168, 0, 0.3)" }}>
                          {[
                            goalAverage && { label: "目標アベレージ", goal: Number(goalAverage), now: Number(avg) || 0 },
                            goalScore && { label: "目標スコア", goal: Number(goalScore), now: Number(highGame) || 0 },
                          ]
                            .filter(Boolean)
                            .map((g) => {
                              const done = g.now >= g.goal;
                              const pct = Math.max(0, Math.min(100, (g.now / g.goal) * 100));
                              return (
                                <div key={g.label}>
                                  <div className="flex items-baseline justify-between" style={{ fontSize: 12, color: COLORS.strike }}>
                                    <span className="flex items-center gap-1">
                                      <Target size={12} style={{ color: COLORS.gold }} />
                                      {g.label}{" "}
                                      <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 14, color: COLORS.cream }}>{g.goal}</span>
                                    </span>
                                    {done ? (
                                      <span style={{ color: COLORS.gold, fontWeight: 700, fontSize: 13 }}>達成!</span>
                                    ) : (
                                      <span>
                                        あと{" "}
                                        <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16, color: COLORS.gold }}>
                                          {Math.round((g.goal - g.now) * 10) / 10}
                                        </span>
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ height: 5, borderRadius: 999, background: "rgba(255,255,255,0.12)", marginTop: 4, overflow: "hidden" }}>
                                    <div style={{ width: `${pct}%`, height: "100%", borderRadius: 999, background: COLORS.gold }} />
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      )}
                      <div className="flex" style={{ borderTop: "1px solid rgba(224, 168, 0, 0.3)" }}>
                        {[
                          { label: "ハイゲーム", value: highGame, icon: true },
                          { label: "ローゲーム", value: lowGame },
                        ].map((x, i) => (
                          <div
                            key={x.label}
                            className="flex items-center justify-between"
                            style={{ flex: 1, padding: "10px 16px", borderLeft: i ? "1px solid rgba(224, 168, 0, 0.3)" : "none" }}
                          >
                            <span className="flex items-center gap-1" style={{ color: COLORS.strike, fontSize: 13 }}>
                              {x.icon && <Trophy size={13} style={{ color: COLORS.gold }} />}
                              {x.label}
                            </span>
                            <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream, lineHeight: 1 }}>{x.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>

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
                        {periodMode === "day" ? "本日のゲームごとのスコア" : "日ごとの平均スコア推移"}
                      </div>
                      {(() => {
                        // 点が多い時(年・月など)は横にスクロールできるようにして、1日ずつのスコアを読めるようにする。
                        // 縦軸は左に固定し、開いた時は一番新しい日(右端)が見える位置にする。
                        const many = periodMode !== "day" && chartData.length > 8;
                        const plotWidth = chartData.length * 46 + 36;
                        const scrollKey = `${periodMode}-${chartData.length}-${chartData.length ? chartData[chartData.length - 1].label : ""}`;
                        const yTicks = [0, 50, 100, 150, 200, 250, 300];
                        const body = (
                          <>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E5DCC8" />
                            <XAxis dataKey="label" tick={{ fontSize: 13, fill: COLORS.strike }} padding={{ left: 18, right: 18 }} interval={0} />
                            <YAxis hide domain={[0, 300]} ticks={yTicks} />
                            <Tooltip
                              contentStyle={{ fontSize: 14, borderColor: COLORS.oak }}
                              itemStyle={{ color: "#23262B" }}
                              labelStyle={{ color: "#23262B" }}
                              formatter={(v) => [v, periodMode === "day" ? "スコア" : "その日の平均"]}
                            />
                            <Line
                              type="monotone"
                              dataKey="total"
                              stroke={COLORS.strike}
                              strokeWidth={2.5}
                              dot={{ r: 3, fill: COLORS.strike }}
                              label={{ position: "top", fontSize: 13, fontWeight: 700, fill: COLORS.strike }}
                            />
                          </>
                        );
                        const margin = { top: 22, right: 8, left: 4, bottom: 0 };
                        return (
                          <div style={{ display: "flex" }}>
                            <div style={{ width: 38, flex: "none" }}>
                              <LineChart width={38} height={240} data={chartData} margin={{ top: 22, right: 0, left: 0, bottom: 0 }}>
                                <XAxis dataKey="label" tick={false} axisLine={false} tickLine={false} />
                                <YAxis width={38} domain={[0, 300]} ticks={yTicks} tick={{ fontSize: 13, fill: COLORS.strike }} />
                              </LineChart>
                            </div>
                            {many ? (
                              <div
                                style={{ flex: 1, minWidth: 0, overflowX: "auto", WebkitOverflowScrolling: "touch" }}
                                ref={(el) => {
                                  if (el && el.dataset.k !== scrollKey) {
                                    el.dataset.k = scrollKey;
                                    el.scrollLeft = el.scrollWidth;
                                  }
                                }}
                              >
                                <LineChart width={plotWidth} height={240} data={chartData} margin={margin}>
                                  {body}
                                </LineChart>
                              </div>
                            ) : (
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <ResponsiveContainer width="100%" height={240}>
                                  <LineChart data={chartData} margin={margin}>
                                    {body}
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {periodMode !== "day" && chartData.length > 8 && (
                        <div className="text-xs mt-1" style={{ color: COLORS.strike, opacity: 0.75 }}>← 横にスクロールすると前の日も見られます</div>
                      )}
                    </div>

                    {periodMode === "day" && periodGames.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs flex items-center gap-1" style={{ color: COLORS.strike }}>
                          <Hash size={12} /> スコア表
                        </div>
                        {/* All of the day's games in one card, stacked like a center's
                            score printout, so as many as possible fit on one screen.
                            Tap a game's bar to open its strike/spare breakdown. */}
                        <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak, padding: "6px 8px 8px" }}>
                          {[...periodGames]
                            .sort((a, b) => (a.gameNumber || 1) - (b.gameNumber || 1))
                            .map((g, gi) => {
                              const gs = computeGameSetStats([g]);
                              return (
                                <div key={g.id} style={{ marginTop: gi ? 8 : 0 }}>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setOpenDayGames((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(g.id)) next.delete(g.id);
                                        else next.add(g.id);
                                        return next;
                                      })
                                    }
                                    aria-expanded={openDayGames.has(g.id)}
                                    className="w-full flex items-center justify-between"
                                    style={{ padding: "2px 2px 4px", color: COLORS.strike }}
                                  >
                                    <span className="flex items-center gap-1" style={{ fontSize: 13, fontWeight: 700 }}>
                                      {openDayGames.has(g.id) ? (
                                        <ChevronDown size={14} style={{ color: COLORS.gold }} />
                                      ) : (
                                        <ChevronRight size={14} style={{ color: COLORS.gold }} />
                                      )}
                                      {g.gameNumber ? `${g.gameNumber}ゲーム目` : "ゲーム"}
                                    </span>
                                    <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 17, color: COLORS.gold, lineHeight: 1 }}>
                                      {g.total}
                                    </span>
                                  </button>
                                  <CompactScoreSheet frames={g.frames} />
                                  {openDayGames.has(g.id) && (
                                  <div style={{ marginTop: 4 }}>
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
                                        className="flex items-center justify-between px-2 py-1"
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
                                  )}
                                </div>
                              );
                            })}
                          <div style={{ color: COLORS.strike, opacity: 0.7, fontSize: 12, marginTop: 6 }}>
                            ゲーム名を押すと、ストライク・スペアなどの内訳が見られます
                          </div>
                        </div>
                      </div>
                    )}

                    {periodGames.length > 0 && (
                      <details className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                        <summary className="px-3 py-2 cursor-pointer text-sm" style={{ color: COLORS.strike }}>
                          {!premiumStatsOk && <Lock size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />}
                          ボール別の成績
                        </summary>
                        {premiumStatsOk ? <BallRankings stats={ballStats} /> : <PlanLockNote text="ボール別の成績は、プレミアム以上のプランで見られます" inset />}
                      </details>
                    )}

                    {periodGames.length > 0 && (
                      <details className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                        <summary className="px-3 py-2 cursor-pointer text-sm" style={{ color: COLORS.strike }}>
                          {!premiumStatsOk && <Lock size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />}
                          ボウリング場別の成績
                        </summary>
                        {premiumStatsOk ? <CenterStats games={periodGames} /> : <PlanLockNote text="ボウリング場別の成績は、プレミアム以上のプランで見られます" inset />}
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

        {tab === "ranking" && (
          <RankingTab
            games={games}
            nickname={nickname}
            authUser={authUser}
            deviceId={deviceId}
            onGoToSettings={() => {
              setTab("profile");
              window.scrollTo(0, 0);
            }}
          />
        )}

        {tab === "profile" && (
          <div className="space-y-4">
            <div className="text-sm" style={{ color: COLORS.strike }}>アカウント</div>
            <div className="rounded-xl p-3 glass-card space-y-3" style={{ border: `1px solid ${COLORS.gold}` }}>
              <div className="flex items-center gap-3">
                <div
                  className="flex items-center justify-center rounded-full"
                  style={{ width: 46, height: 46, flexShrink: 0, border: `1.5px solid ${COLORS.gold}`, background: "rgba(224,168,0,0.1)" }}
                >
                  <User size={22} style={{ color: COLORS.gold }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 17, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {nickname.trim() || "ニックネーム未設定"}
                  </div>
                  <div style={{ color: COLORS.strike, opacity: 0.7, fontSize: 12.5, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.03em" }}>
                    ID {myRequestNumber ? formatRequestNumber(myRequestNumber) : "ー"}
                  </div>
                </div>
                <span
                  className="rounded-full px-2.5 py-0.5"
                  style={
                    authUser
                      ? { border: `1px solid ${COLORS.gold}`, color: COLORS.gold, fontSize: 11, fontWeight: 700, flexShrink: 0 }
                      : { border: "1px solid rgba(245,241,228,0.35)", color: "rgba(245,241,228,0.7)", fontSize: 11, flexShrink: 0 }
                  }
                >
                  {authUser ? "アカウント" : "アカウント未作成"}
                </span>
              </div>

              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.strike }}>ニックネーム</div>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  onBlur={(e) => saveProfile({ nickname: e.target.value })}
                  placeholder="例: ヤマダ"
                  className="w-full px-3 py-2 rounded border"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16 }}
                />
              </div>

              {planInfo && planInfo.id !== "legacy" && <PlanUsage plan={planInfo} />}

              {authUser ? (
                <div className="space-y-2" style={{ borderTop: "1px solid rgba(224,168,0,0.18)", paddingTop: 10 }}>
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ color: COLORS.strike, opacity: 0.7, fontSize: 12 }}>メールアドレス</span>
                    <span style={{ color: COLORS.strike, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {authUser.email}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3" style={{ paddingTop: 4 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: COLORS.strike, fontWeight: 700, fontSize: 13.5 }}>月間ランキングに参加する</div>
                      <div style={{ color: COLORS.strike, opacity: 0.6, fontSize: 11, lineHeight: 1.5 }}>
                        <Phrases text="表示名と成績が|他の人に|表示されます" />
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rankingOptIn}
                      aria-label="月間ランキングに参加する"
                      onClick={() => {
                        const next = !rankingOptIn;
                        if (next && !rankingName.trim()) {
                          setRankingNeedNickname(true);
                          return;
                        }
                        setRankingNeedNickname(false);
                        setRankingOptIn(next);
                        saveProfile({ rankingOptIn: next });
                      }}
                      style={{
                        width: 48,
                        height: 28,
                        borderRadius: 999,
                        flexShrink: 0,
                        position: "relative",
                        background: rankingOptIn ? COLORS.gold : "rgba(245,241,228,0.2)",
                        transition: "background .2s",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          top: 3,
                          left: rankingOptIn ? 23 : 3,
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          background: "#FFFFFF",
                          transition: "left .2s",
                        }}
                      />
                    </button>
                  </div>
                  <div className="space-y-2 rounded-lg p-2.5" style={{ background: "rgba(10, 16, 34, 0.45)" }}>
                    <div>
                      <div className="text-xs mb-1" style={{ color: COLORS.strike }}>ランキング表示名</div>
                      <input
                        type="text"
                        value={rankingName}
                        maxLength={20}
                        onChange={(e) => setRankingName(e.target.value)}
                        onBlur={(e) => saveProfile({ rankingName: e.target.value.trim() })}
                        placeholder="例: ボウラーY"
                        className="w-full px-3 py-2 rounded border"
                        style={{
                          borderColor: rankingNeedNickname && !rankingName.trim() ? "#E8836A" : COLORS.oak,
                          color: COLORS.ink,
                          fontSize: 16,
                        }}
                      />
                      {rankingNeedNickname && !rankingName.trim() && (
                        <div style={{ color: "#E8836A", fontSize: 12, marginTop: 4 }}>ランキングに参加するには、ランキング表示名を入力してください</div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <div style={{ flex: 1 }}>
                        <div className="text-xs mb-1" style={{ color: COLORS.strike }}>年代(任意)</div>
                        <select
                          value={ageGroup}
                          onChange={(e) => {
                            setAgeGroup(e.target.value);
                            saveProfile({ ageGroup: e.target.value });
                          }}
                          className="w-full px-2 py-2 rounded border"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16 }}
                        >
                          <option value="">未設定</option>
                          {RANKING_AGE_OPTIONS.map(([k, l]) => (
                            <option key={k} value={k}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="text-xs mb-1" style={{ color: COLORS.strike }}>性別(任意)</div>
                        <select
                          value={gender}
                          onChange={(e) => {
                            setGender(e.target.value);
                            saveProfile({ gender: e.target.value });
                          }}
                          className="w-full px-2 py-2 rounded border"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink, fontSize: 16 }}
                        >
                          <option value="">回答しない</option>
                          <option value="male">男性</option>
                          <option value="female">女性</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ color: COLORS.strike, opacity: 0.8, fontSize: 12.5 }}>
                      <Phrases text="年代・性別は|絞り込み用です|(他の人には|見えません)" />
                    </div>
                  </div>
                  <div style={{ color: COLORS.strike, opacity: 0.8, fontSize: 12.5 }}>
                    同時に使えるのは1台のみです
                  </div>
                  <button
                    type="button"
                    onClick={logoutAccount}
                    className="w-full rounded-lg py-2 text-sm"
                    style={{ border: "1px solid rgba(184, 153, 104, 0.6)", color: COLORS.strike, fontWeight: 700 }}
                  >
                    ログアウト
                  </button>
                </div>
              ) : (
                auth && (
                  <div style={{ borderTop: "1px solid rgba(224,168,0,0.18)", paddingTop: 10 }}>
                    <AccountForm
                      onLogin={loginWithAccount}
                      onSignup={signupWithAccount}
                      onReset={resetPassword}
                      busy={authBusy}
                      errorMsg={authErrorMsg}
                      infoMsg={authInfoMsg}
                      intro="はじめての方。作成すると、機種変更してもログインするだけで記録を引き継げます(今の記録もそのまま引き継がれ、承認も不要です)"
                    />
                  </div>
                )
              )}
            </div>

            <div className="flex gap-2">
              <a
                href="/guide"
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded-xl flex items-center justify-center"
                style={{ padding: "10px 8px", border: `1px solid ${COLORS.oak}`, color: COLORS.strike, fontSize: 13.5, fontWeight: 700 }}
              >
                使い方ガイド
              </a>
              <button
                type="button"
                onClick={() => {
                  setSetupStep(1);
                  setSetupOpen(true);
                }}
                className="flex-1 rounded-xl"
                style={{ padding: "10px 8px", border: `1px solid ${COLORS.oak}`, color: COLORS.strike, fontSize: 13.5, fontWeight: 700 }}
              >
                はじめの設定をやり直す
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div className="text-sm" style={{ color: COLORS.strike }}>基本情報</div>
              {profileSaved && <span style={{ color: COLORS.strike, fontSize: 13 }}>保存しました</span>}
            </div>

            <div className="rounded-xl p-3 border glass-card space-y-3" style={{ borderColor: COLORS.oak }}>
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
                                { key: "strike", label: "1stボール" },
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
                          <span style={{ color: COLORS.strike, fontWeight: 400, fontSize: 13, whiteSpace: "nowrap" }}>
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

            {!newBallOpen ? (
              <AddRowButton label="新しいボールを登録" onClick={() => setNewBallOpen(true)} />
            ) : (
            <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
              <FormHeader label="新しいボールを登録" onClose={() => setNewBallOpen(false)} />

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
                    { key: "strike", label: "1stボール" },
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
                  placeholder="例: エース(未入力なら自動で名付けます)"
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
            )}

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

            {!newShoeOpen ? (
              <AddRowButton label="新しいマイシューズを登録" onClick={() => setNewShoeOpen(true)} />
            ) : (
            <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
              <FormHeader label="新しいマイシューズを登録" onClose={() => setNewShoeOpen(false)} />

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
            )}

            <div className="text-sm" style={{ color: COLORS.strike }}>表示</div>
            <div className="rounded-xl glass-card flex items-center justify-between gap-3" style={{ padding: "10px 12px" }}>
              <span style={{ color: COLORS.cream, fontSize: 14, whiteSpace: "nowrap" }}>文字の大きさ</span>
              <TextSizeSegment
                value={textSize}
                onChange={(k) => {
                  setTextSize(k);
                  saveTextSize(k);
                }}
              />
            </div>

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

            <div className="legal-links flex items-center justify-center gap-2 pt-2 flex-nowrap" style={{ fontSize: 10, color: COLORS.strike, whiteSpace: "nowrap" }}>
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
            { key: "ranking", label: "ランキング", icon: Trophy },
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
                <span className="nav-label" style={{ fontSize: 12, whiteSpace: "nowrap", letterSpacing: "-0.03em" }}>{label}</span>
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
            height: chatViewportHeight ? `calc(${chatViewportHeight}px / var(--app-zoom, 1))` : "100%",
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
