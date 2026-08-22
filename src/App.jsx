import React, { useState, useEffect, useRef, useCallback } from "react";
import { Camera, History, BarChart3, Loader2, Check, X, Pencil, Trophy, TrendingUp, Calendar, CircleDot, Hash, User, Target, Trash2, ShieldCheck, CircleCheck, MessageCircle, Send, Settings } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

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
  navyBg: "#1D2540",
  danger: "#C0392B",
};

const STORAGE_KEY = "games";

// Drop-in replacement for the Claude-artifact-only `window.storage` API,
// backed by the browser's localStorage instead. Keeps the same shape
// ({ key, value } | null) so the rest of the app didn't need to change.
// NOTE: localStorage is per-browser/per-device, not per-account — swap this
// out for a real backend (Firebase, etc.) if you want data to follow the
// person across devices.
const storage = {
  async get(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return { key, value: raw };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
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

function preprocessImage(file) {
  return new Promise(async (resolve, reject) => {
    const HEIC_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
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
    img.onload = () => {
      try {
        // Target ~1568px on the long side: Claude's vision encoder works best
        // around this size, so we scale up small/blurry phone photos and scale
        // down oversized ones rather than sending whatever the camera produced.
        const targetLong = 1568;
        const longSide = Math.max(img.width, img.height);
        const scale = targetLong / longSide;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        // Mild contrast/brightness boost helps distinguish LED-style digits
        // and faint pencil marks on paper scoresheets from the background.
        ctx.filter = "contrast(130%) brightness(110%)";
        ctx.drawImage(img, 0, 0, w, h);
        ctx.filter = "none";
        // Only worth sharpening when we've upscaled a small/rough photo;
        // skip it on already-large, high-quality images to save time.
        if (scale > 1.1 && w * h < 4_000_000) {
          try {
            sharpen(ctx, w, h);
          } catch (sharpenErr) {
            // Sharpening is a bonus step; if it fails for any reason, fall
            // back to the plain upscaled+contrast image rather than erroring out.
          }
        }

        let outUrl;
        try {
          // JPEG at high quality keeps text legible while producing a much
          // smaller payload than PNG — large PNG uploads have been failing
          // partway through the request. Quality raised to 0.95 (was 0.85)
          // so small digits/marks on scoresheets stay crisp for the AI reader.
          outUrl = canvas.toDataURL("image/jpeg", 0.95);
        } catch (e) {
          reject(new Error("画像の処理中にエラーが発生しました。別の写真でお試しください。"));
          return;
        }
        resolve({ base64: outUrl.split(",")[1], mediaType: "image/jpeg" });
      } catch (e) {
        reject(new Error("画像の処理に失敗しました。別の写真でお試しください。"));
      }
    };
    img.onerror = () => {
      reject(new Error("画像を読み込めませんでした。対応形式(JPEG/PNG)の写真かご確認のうえ、もう一度お試しください。"));
    };
    img.src = dataUrl;
  });
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("解析結果の形式が不正です");
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
    (g.frames || []).forEach((f) => {
      const r0 = f.rolls?.[0];
      if (r0 !== undefined && r0 !== "") {
        frameCount += 1;
        if (r0 === "X") {
          strikes += 1;
        } else {
          spareChances += 1;
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
    strikeCount: strikes, strikeRate: pct(strikes, frameCount),
    spareCount: spares, spareRate: pct(spares, spareChances),
    openFrameCount: openFrames, openFrameRate: pct(openFrames, frameCount),
    splitCount: splitFrames, splitRate: pct(splitFrames, frameCount),
    splitCoverCount: splitCovers, splitCoverRate: pct(splitCovers, splitOpenCount),
    gutterCount: gutters, gutterRate: pct(gutters, totalBalls),
    foulCount: fouls, foulRate: pct(fouls, totalBalls),
  };
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

async function analyzeScoreImage(base64, mediaType, playerName) {
  const nameInstruction = playerName
    ? `この画像には複数人のスコアが表示されている可能性があります。名前「${playerName}」の行/列のスコアだけを読み取ってください。表記ゆれ(ひらがな・カタカナ・ローマ字・ニックネームなど)も考慮して、最も一致する列を選んでください。`
    : `この画像には1人分のスコアのみが表示されていると仮定して読み取ってください。`;

  const prompt = `これはボウリングのスコア画面またはスコアシートの写真です。${nameInstruction}

この写真には、対象プレイヤーの**1ゲーム分だけ**が写っている場合と、**複数ゲーム分(例: 1ゲーム目・2ゲーム目・3ゲーム目)がまとめて**写っている場合があります。まず、対象プレイヤーについて写っているゲームがいくつあるかを確認し、写っている**すべてのゲーム**を、それぞれ独立した10フレームのデータとして読み取ってください。

電光掲示板でよくある表示の特徴(該当する場合のみ考慮):
- 表の一番上に「1 2 3 4 5 6 7 8 9 10」のようなフレーム番号のヘッダー行がある場合、それを基準にして各列がどのフレームかを機械的に特定すること。ヘッダーがずれて見えても、フレーム数は必ず10個であることを前提に列を数え直して位置合わせする。フレームの取り違えは起きないよう、この基準を最優先で使う
- 複数ゲームが表示されている場合、「1G」「2G」「3G」やゲーム番号の見出しで区切られていることが多い。見出しを基準に、どこからどこまでが1ゲーム分かを正しく区切ること
- ストライクは文字の「X」ではなく、緑や黒の三角形・矢印のようなアイコン、または蝶ネクタイ(ネクタイ)のような形のアイコンで表示されることがある。これらの記号を見つけたらストライク(pins内部的には"X")として扱う。スペアも「/」ではなく記号やハイフンの組み合わせで表示される場合がある
- 各フレームのセルが上下2段になっていることが多い。上段は投球結果の記号、下段はそのフレーム終了時点の累計スコア(数字)
- 上段の記号アイコンが小さく判読しにくい場合は、下段の累計スコアの数字を最優先で正確に読み取ること。累計スコアの数字は判読しやすく、フレーム間の差分からストライク/スペア/オープンフレームをかなり正確に推定できる
- プレイヤー名の直後に区分ラベルらしき1文字の英字(例:「A」)が付いていることがある。これは名前そのものではない可能性があるため、名前照合の際は末尾の1文字英字を無視して比較する
- 「HDCP」はハンディキャップの略で、スコアそのものではない。「レーン合計」や複数ゲームの累計列も同様にゲームのスコアではない。読み取るべき合計スコアは、各ゲームの10フレーム分のスコア推移の直後にある「TOTAL」列の値のみで、HDCP・レーン合計・累計・順位などの列は無視する
- 写真が斜め・手ブレ・多少ぼやけている・画面の一部が反射で見えにくい場合でも、諦めずに文字の形状、周囲の数字との整合性、フレームの位置関係から可能な限り推測すること。多少画質が粗くても、数字の並び(1桁刻みで増える累計スコアなど)から妥当な値を推定できることが多い
- それでも判読が困難な箇所は、無理に確定せず、そのゲームの confidence_notes に具体的に記載する(例:「5フレーム目のマークが不鮮明」)

読み取りは、写っている**ゲームごとに**以下の手順で慎重に行ってください:
1. まず画面の種類(電光掲示板のデジタル表示か、紙のスコアシートか)と、対象プレイヤーの列/行の位置、そのゲームが何ゲーム目かを確認する
2. フレーム1から10まで、1フレームずつ順番に投球結果を読み取る。数字の間違えやすい組み合わせ(例: 6と8、1と7、Xと数字)は特に注意して見る
3. 各フレームを読み終えたら、そのフレームの累計スコアが「前のフレームの累計 + このフレームで倒したピン数」と矛盾していないか自分で検算する。矛盾があれば、数字の読み取りを見直して修正する
4. 全フレームを読み終えたら、10フレーム目の累計スコアと、画面に表示されている「TOTAL」列の数字を突き合わせる。一致しない場合は、どこかのフレームの投球結果(特にストライク/スペアの見落とし)を読み間違えている可能性が高いので、frame_by_frame_readingを最初から見直し、一致するまで修正すること。TOTAL表示は画像上で最も読み取りやすい数字であることが多いため、最終的な正解の基準として扱う
5. 他にゲームが写っていれば、同じ手順を繰り返す
6. 最後に、読み取った内容を次のJSON形式のみで出力する。前置き・説明・マークダウンの記号は一切含めない

{
  "screen_type": "digital" または "paper",
  "player_matched": true,
  "matched_name_on_screen": "画面上に表示されていた実際の表記",
  "other_players_detected": ["画面にいた他の人の名前など"],
  "games": [
    {
      "game_label": "1ゲーム目のように画面上のラベル、なければ null",
      "detected_date": "画面や紙に印字・記入されている日付があれば YYYY-MM-DD 形式に変換して。西暦2桁表記(例: 26/8/9)は20を補って西暦4桁にする。年が書かれておらず月日のみの場合は、その月日と今日の日付から最も自然な年を推測する。日付が一切見当たらない場合は null",
      "frame_by_frame_reading": ["1F: 7,スペア → 累計17", "2F: ストライク → 累計37", "..."],
      "frames": [
        {"rolls": ["7","/"], "score": 17, "split_roll_index": null},
        {"rolls": ["X"], "score": 37, "split_roll_index": null},
        {"rolls": ["8","1"], "score": 46, "split_roll_index": 0},
        {"rolls": ["X","X","6"], "score": 300, "split_roll_index": 2}
      ],
      "total_score": 178,
      "confidence_notes": ""
    }
  ]
}

ルール:
- games は配列。写っているゲームが1つだけでも、必ず配列(要素数1)として返す。複数ゲームが写っていれば、その数だけ要素を含める
- rolls の値は "0"〜"10" の数字文字列、ストライクは "X"、スペアの2投目は "/"
- frames は必ず10フレーム分(読み取れる範囲まで)
- 10フレーム目は最大3投
- score は各フレーム終了時点の累計スコア(手順3で検算した値)。10フレーム目まで画像に表示されている場合は、必ず10個分のscoreを埋めること。最終フレームの累計が画面上の「TOTAL」の値と一致するか必ず確認する
- split_roll_index は、そのフレームの中で数字が丸で囲まれている(スプリットを示す)投球が何投目か(0始まりのインデックス)を表す。スプリットは1投目とは限らず、10フレーム目のボーナス球(2投目・3投目)に付くこともあるので、実際に丸が付いている投球の位置を必ず確認すること。丸が付いた投球がなければ null
- frame_by_frame_reading は手順2〜3の思考過程を1フレームずつ短い日本語で記載する(この項目を必ず frames より先に埋めること)
- 指定された名前に一致する列が画面内に見つからない場合は player_matched を false にし、games は空配列、confidence_notes に「該当する名前が見つかりませんでした」等を記載(この場合 confidence_notes はJSONの一番外側に置いてよい)
- 名前の指定がない場合は player_matched を true とし、画面内の(唯一の、または最初の)プレイヤーのスコアを読み取る
- 数字がかすれている・反射で見えにくいなど読み取りに自信がない箇所は、そのゲームの confidence_notes に短く日本語で記載(なければ空文字)
- JSON以外は一切出力しない`;

  let response;
  try {
    response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64, mediaType, prompt }),
    });
  } catch (networkErr) {
    throw new Error(`通信自体に失敗しました: ${networkErr.message || networkErr}`);
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (_) {
      // ignore — body wasn't readable as text
    }
    throw new Error(`解析リクエストに失敗しました (status ${response.status}): ${bodyText.slice(0, 300)}`);
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
    throw new Error(`応答がJSON形式ではありませんでした: ${(bodyText || parseErr.message || "").slice(0, 300)}`);
  }

  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error(`解析結果が空でした: ${JSON.stringify(data).slice(0, 300)}`);
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

function RollMark({ val, split }) {
  if (val === undefined || val === "") return null;
  let content;
  if (val === "X") {
    // Strike: two triangles meeting point-to-point (bowtie shape), the
    // classic strike icon seen on paper scoresheets and electronic boards.
    content = (
      <svg width="17" height="17" viewBox="0 0 17 17" style={{ display: "block" }}>
        <polygon points="2,2 2,15 8.5,8.5" fill={COLORS.ink} />
        <polygon points="15,2 15,15 8.5,8.5" fill={COLORS.ink} />
      </svg>
    );
  } else if (val === "/") {
    // Spare: a single solid triangle filling the cell's corner.
    content = (
      <svg width="17" height="17" viewBox="0 0 17 17" style={{ display: "block" }}>
        <polygon points="2,15 15,15 15,2" fill={COLORS.ink} />
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
      <div className="text-center tracking-widest py-0.5" style={{ color: COLORS.oak, fontFamily: "'Oswald', sans-serif", fontSize: 12 }}>
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
        style={{ borderColor: COLORS.ink, color: COLORS.cream, fontWeight: 700, fontFamily: "'Oswald', sans-serif" }}
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
      className="glass-card rounded-lg py-2 text-sm"
      style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
    >
      {label}
    </button>
  );
  return (
    <div className="glass-card rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between text-xs" style={{ color: COLORS.oak }}>
        <span>
          フレーム{frameIdx + 1} ・ {rollIdx + 1}投目を選択
        </span>
        <button type="button" onClick={onClose} className="flex items-center gap-1" style={{ color: COLORS.oak }}>
          <X size={14} /> 閉じる
        </button>
      </div>

      <div className="grid grid-cols-6 gap-1.5">
        {Array.from({ length: 11 }).map((_, n) => numberBtn(String(n), String(n)))}
        <button
          type="button"
          onClick={() => onSelect("X")}
          className="glass-card rounded-lg py-2 flex items-center justify-center text-sm"
          style={{ border: `1px solid ${COLORS.strike}`, color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
        >
          X
        </button>
      </div>

      <div className="grid grid-cols-5 gap-1.5">
        <button
          type="button"
          onClick={() => onSelect("/")}
          className="glass-card rounded-lg py-2 flex items-center justify-center text-sm"
          style={{ border: `1px solid ${COLORS.gold}`, color: COLORS.gold, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
        >
          /
        </button>
        <button
          type="button"
          onClick={() => onSelect("G")}
          className="glass-card rounded-lg py-2 text-xs"
          style={{ color: COLORS.cream, fontWeight: 700 }}
        >
          G(ガーター)
        </button>
        <button
          type="button"
          onClick={() => onSelect("F")}
          className="glass-card rounded-lg py-2 text-xs"
          style={{ border: `1px solid ${COLORS.strike}`, color: COLORS.strike, fontWeight: 700 }}
        >
          F(ファール)
        </button>
        <button
          type="button"
          onClick={() => onSelect("-")}
          className="glass-card rounded-lg py-2 text-xs"
          style={{ color: COLORS.cream, fontWeight: 700 }}
        >
          -(オープン)
        </button>
        <button
          type="button"
          onClick={onClear}
          className="glass-card rounded-lg py-2 text-xs"
          style={{ color: COLORS.oak, fontWeight: 700 }}
        >
          クリア
        </button>
      </div>

      {splitEligible && (
        <button
          type="button"
          onClick={onSplitToggle}
          className="w-full rounded-lg py-2 text-xs flex items-center justify-center gap-2"
          style={{
            background: splitActive ? COLORS.gold : "rgba(40, 55, 95, 0.55)",
            border: `1px solid ${COLORS.gold}`,
            color: splitActive ? "white" : COLORS.cream,
            fontWeight: 700,
          }}
        >
          スプリット(⑧のように丸で囲む){splitActive ? ": ON" : ""}
        </button>
      )}
    </div>
  );
}

// ---------- access gate ----------
// Shown instead of the app until the person's device has been approved by
// the admin. "checking" while we ask the server, then one of the statuses.
function GateScreen({ mode, name, setName, onSubmit, requestNumber }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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
      style={{ minHeight: "100vh", background: COLORS.navyBg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');`}</style>
      <div style={{ maxWidth: 340, width: "100%", fontFamily: "'Noto Sans JP', sans-serif" }} className="text-center space-y-4">
        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 26, color: COLORS.cream }}>
          STRIKE LOG
        </div>

        {mode === "checking" && <div style={{ color: COLORS.oak }}>確認中...</div>}

        {(mode === "not_found" || mode === "error") && (
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
          </>
        )}

        {mode === "pending" && (
          <div className="space-y-2">
            <div style={{ color: COLORS.cream, fontSize: 14 }}>
              利用申請を受け付けました。管理者の承認をお待ちください。
            </div>
            {requestNumber && (
              <div style={{ color: COLORS.gold, fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16 }}>
                あなたの登録番号: {formatRequestNumber(requestNumber)}
              </div>
            )}
          </div>
        )}

        {mode === "rejected" && (
          <div style={{ color: "#E8836A", fontSize: 14 }}>この端末での利用は承認されませんでした。</div>
        )}
      </div>
    </div>
  );
}

// ---------- admin panel (approve access requests, review feedback) ----------
function AdminPanel() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [requests, setRequests] = useState([]);
  const [feedbackList, setFeedbackList] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmDeleteFeedbackId, setConfirmDeleteFeedbackId] = useState(null);
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
      <div style={{ minHeight: "100vh", background: COLORS.navyBg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
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
    <div style={{ minHeight: "100vh", background: COLORS.navyBg, padding: 16 }}>
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <ShieldCheck size={24} style={{ color: COLORS.gold }} />
          <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream }}>管理画面</div>
        </div>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="番号(例: 3)または名前で登録者を検索"
          className="w-full px-3 py-2 rounded border text-sm"
          style={{ borderColor: COLORS.oak, color: COLORS.ink, background: COLORS.cream }}
        />

        <div>
          <div className="text-sm mb-2" style={{ color: COLORS.oak, fontWeight: 700 }}>
            承認待ち ({pending.length})
          </div>
          <div className="space-y-2">
            {pending.length === 0 && <div className="text-xs" style={{ color: COLORS.oak }}>承認待ちの申請はありません</div>}
            {pending.map((r) => (
              <div key={r.id} className="rounded-xl p-3 border glass-card flex items-center justify-between" style={{ borderColor: COLORS.oak }}>
                <div>
                  <div style={{ color: COLORS.cream, fontWeight: 700 }}>
                    <span style={{ color: COLORS.gold }}>No.{formatRequestNumber(r.requestNumber)}</span> {r.name}
                  </div>
                  <div style={{ color: COLORS.oak, fontSize: 13 }}>{r.requestedAt}</div>
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
          <div className="text-sm mb-2" style={{ color: COLORS.oak, fontWeight: 700 }}>
            承認済み ({approved.length})
          </div>
          <div className="space-y-2">
            {approved.length === 0 && <div className="text-xs" style={{ color: COLORS.oak }}>承認済みの申請はありません</div>}
            {approved.map((r) => (
              <div key={r.id} className="rounded-xl p-3 border glass-card flex items-center justify-between" style={{ borderColor: COLORS.oak }}>
                <div>
                  <div style={{ color: COLORS.cream, fontWeight: 700 }}>
                    <span style={{ color: COLORS.gold }}>No.{formatRequestNumber(r.requestNumber)}</span> {r.name}
                  </div>
                  <div style={{ color: COLORS.oak, fontSize: 13 }}>承認済み ・ {r.updatedAt}</div>
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
          <div className="text-sm mb-2" style={{ color: COLORS.oak, fontWeight: 700 }}>
            却下 ({rejected.length})
          </div>
          <div className="space-y-2">
            {rejected.length === 0 && <div className="text-xs" style={{ color: COLORS.oak }}>却下した申請はありません</div>}
            {rejected.map((r) => (
              <div key={r.id} className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                <div className="flex items-center justify-between">
                  <div>
                    <div style={{ color: COLORS.cream, fontWeight: 700 }}>
                      <span style={{ color: COLORS.gold }}>No.{formatRequestNumber(r.requestNumber)}</span> {r.name}
                    </div>
                    <div style={{ color: COLORS.oak, fontSize: 13 }}>却下 ・ {r.updatedAt}</div>
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
                      <Trash2 size={14} style={{ color: COLORS.oak }} />
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

        <div>
          <div className="text-sm mb-2" style={{ color: COLORS.oak, fontWeight: 700 }}>
            改善要望 ・ 未対応 ({unhandledFeedback.length})
          </div>
          <div className="space-y-2">
            {unhandledFeedback.length === 0 && <div className="text-xs" style={{ color: COLORS.oak }}>未対応の要望はありません</div>}
            {unhandledFeedback.map((f) => (
              <div key={f.id} className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                <div style={{ color: COLORS.cream, whiteSpace: "pre-wrap" }}>{f.message}</div>
                <div className="flex items-center justify-between mt-2">
                  <div style={{ color: COLORS.oak, fontSize: 13 }}>
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
                      <Trash2 size={14} style={{ color: COLORS.oak }} />
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
          <div className="text-sm mb-2" style={{ color: COLORS.oak, fontWeight: 700 }}>
            改善要望 ・ 対応済み ({handledFeedback.length})
          </div>
          <div className="space-y-2">
            {handledFeedback.length === 0 && <div className="text-xs" style={{ color: COLORS.oak }}>対応済みの要望はありません</div>}
            {handledFeedback.map((f) => (
              <div key={f.id} className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak, opacity: 0.7 }}>
                <div style={{ color: COLORS.cream, whiteSpace: "pre-wrap" }}>{f.message}</div>
                <div className="flex items-center justify-between mt-2">
                  <div style={{ color: COLORS.oak, fontSize: 13 }}>
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
                      <Trash2 size={14} style={{ color: COLORS.oak }} />
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
・スコアシートの写真
・記録されたスコア・統計データ
・改善要望として送信された内容

2. 利用目的
・本サービスの提供(スコアの自動読み取りなど)のため
・利用申請の承認・本人確認のため
・お問い合わせ・改善要望への対応のため

3. AIサービスの利用について
スコア画像の解析には、Anthropic社のClaude APIを利用しています。解析のためにアップロードされた画像は、解析処理の目的でAnthropic社のサーバーに送信されます。

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

制定日:2026年8月17日`,
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
    <div style={{ minHeight: "100vh", background: COLORS.navyBg, padding: 24 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');`}</style>
      <div className="max-w-xl mx-auto" style={{ fontFamily: "'Noto Sans JP', sans-serif" }}>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.gold, marginBottom: 4 }}>
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
  const [myRequestNumber, setMyRequestNumber] = useState(null);
  const [requestName, setRequestName] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
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
  const [myBalls, setMyBalls] = useState([]); // [{ id, label, weight, thumbless }]
  const [dominantHand, setDominantHand] = useState("right"); // "right" | "left"
  const [goalAverage, setGoalAverage] = useState("");
  const [goalScore, setGoalScore] = useState("");
  const [homeCenter, setHomeCenter] = useState("");
  const [nickname, setNickname] = useState("");
  const [newBallType, setNewBallType] = useState("own"); // "own" | "house"
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
  const [selectedShoeId, setSelectedShoeId] = useState(null);
  const [myShoes, setMyShoes] = useState([]); // [{ id, type, label }]
  const [newShoeName, setNewShoeName] = useState("");
  const [periodMode, setPeriodMode] = useState("week"); // "day" | "week" | "month" | "custom"
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
  const [editShoeType, setEditShoeType] = useState("rental");
  const [editSelectedShoeId, setEditSelectedShoeId] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY);
        if (res && res.value) setGames(JSON.parse(res.value));
      } catch (e) {
        // key not existing yet is normal on first run
      } finally {
        setLoadingGames(false);
      }
    })();
    (async () => {
      try {
        const res = await storage.get(PLAYER_NAME_KEY);
        if (res && res.value) setPlayerName(res.value);
      } catch (e) {
        // no saved name yet, that's fine
      }
    })();
    (async () => {
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
    })();
    (async () => {
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
    })();
    (async () => {
      try {
        const res = await storage.get(MY_BALLS_KEY);
        if (res && res.value) setMyBalls(JSON.parse(res.value));
      } catch (e) {
        // no registered balls yet, that's fine
      }
    })();
    (async () => {
      try {
        const res = await storage.get(SHOE_CONFIG_KEY);
        if (res && res.value) {
          const cfg = JSON.parse(res.value);
          if (cfg.shoeType) setShoeType(cfg.shoeType);
        }
      } catch (e) {
        // no saved shoe config yet, that's fine
      }
    })();
    (async () => {
      try {
        const res = await storage.get(MY_SHOES_KEY);
        if (res && res.value) setMyShoes(JSON.parse(res.value));
      } catch (e) {
        // no registered shoes yet, that's fine
      }
    })();
  }, []);

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

  useEffect(() => {
    if (isAdminRoute || !deviceId) return;
    (async () => {
      try {
        const res = await fetch(`/api/access/status?deviceId=${encodeURIComponent(deviceId)}`);
        const data = await res.json();
        setAccessStatus(data.status || "not_found");
        if (data.requestNumber) setMyRequestNumber(data.requestNumber);
      } catch (e) {
        setAccessStatus("error");
      }
    })();
  }, [isAdminRoute, deviceId]);

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "回答の取得に失敗しました");
      const textBlock = (data.content || []).find((b) => b.type === "text");
      const reply = textBlock?.text?.trim() || "うまく答えられませんでした。もう一度試してください。";
      setChatMessages([...nextMessages, { role: "assistant", content: reply }]);
    } catch (e) {
      setChatError(e.message || "エラーが発生しました。もう一度お試しください。");
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
    setNewBallCore("");
    setNewBallCoverstock("");
    setNewBallMotion("");
    setNewBallLaneCondition("");
  };

  const deleteMyBall = (id) => {
    persistMyBalls(myBalls.filter((b) => b.id !== id));
    if (selectedBallId === id) setSelectedBallId(null);
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

  const handleFile = async (file) => {
    if (!file) return;
    setAnalyzeError("");
    setPendingResult(null);
    setImagePreview(null);
    setImageMeta(null);
    setActiveCell(null);
    setSplitPending(false);
    try {
      const rawUrl = await readFileAsDataUrl(file);
      setImagePreview(rawUrl);
    } catch (e) {
      // non-fatal: preview is best-effort, processing below still runs
    }
    try {
      const { base64, mediaType } = await preprocessImage(file);
      setImageMeta({ base64, mediaType });
      setImagePreview(`data:${mediaType};base64,${base64}`);
    } catch (e) {
      setAnalyzeError(e.message);
    }
  };

  const runAnalysis = async () => {
    if (!imageMeta) return;
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      const result = await analyzeScoreImage(imageMeta.base64, imageMeta.mediaType, playerName.trim());
      if (result.player_matched === false) {
        setPendingResult(result);
      } else {
        const rawGames = Array.isArray(result.games) ? result.games : [];
        const normalizedGames = rawGames.map((game) => {
          const framesWithSplitRolls = (game.frames || []).map((f) => {
            const splitRolls = [];
            if (typeof f.split_roll_index === "number") splitRolls[f.split_roll_index] = true;
            return { ...f, splitRolls };
          });
          const norm = normalizeGame(framesWithSplitRolls);
          const ocrTotal = Number(game.total_score);
          const hasOcrTotal = Number.isFinite(ocrTotal);
          const mismatch =
            norm.total !== null && hasOcrTotal && norm.total !== ocrTotal
              ? { computed: norm.total, ocrRead: ocrTotal }
              : null;
          return {
            gameLabel: game.game_label || null,
            detectedDate: game.detected_date || null,
            frames: norm.frames,
            total_score: norm.total !== null ? norm.total : hasOcrTotal ? ocrTotal : null,
            ocrTotal: hasOcrTotal ? ocrTotal : null,
            totalMismatch: mismatch,
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
      }
    } catch (e) {
      setAnalyzeError(e.message || "解析中にエラーが発生しました");
    } finally {
      setAnalyzing(false);
    }
  };

  const saveGame = async () => {
    if (!pendingResult || !pendingResult.games?.length) return;
    const selectedBall = myBalls.find((b) => b.id === selectedBallId);
    const ball = {
      type: ballType,
      weight: selectedBall ? selectedBall.weight : null,
      thumbless: selectedBall ? selectedBall.thumbless : false,
      label: selectedBall ? selectedBall.label : null,
    };
    let ball2 = null;
    if (useSecondBall) {
      const selectedBall2 = myBalls.find((b) => b.id === selectedBallId2);
      ball2 = {
        type: ballType2,
        weight: selectedBall2 ? selectedBall2.weight : null,
        thumbless: selectedBall2 ? selectedBall2.thumbless : false,
        label: selectedBall2 ? selectedBall2.label : null,
      };
    }
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
      shoe,
      createdAt: Date.now() + idx,
    }));
    const next = [...games, ...newGames].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.gameNumber || 1) - (b.gameNumber || 1)
    );
    await persistGames(next);
    await saveBallConfig({ ballType, ballWeight, ballThumbless });
    await saveShoeConfig({ shoeType });
    setShoeTouched(false);
    setUseSecondBall(false);
    setBallType2("house");
    setBallWeight2("");
    setBallThumbless2(false);
    setSelectedBallId2(null);
    setPendingResult(null);
    setImagePreview(null);
    setImageMeta(null);
    setActiveCell(null);
    setSplitPending(false);
    setGameNumberTouched(false);
    setTab("history");
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
        const mismatch =
          norm.total !== null && game.ocrTotal !== null && norm.total !== game.ocrTotal
            ? { computed: norm.total, ocrRead: game.ocrTotal }
            : null;
        return {
          ...game,
          frames: norm.frames,
          total_score: norm.total !== null ? norm.total : game.total_score,
          totalMismatch: mismatch,
        };
      });
      return { ...prev, games };
    });
  };

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
    setActiveCell(null);
    setSplitPending(false);
  };

  const handlePickerClear = () => {
    if (!activeCell) return;
    updateRollValue(activeCell.gameIdx, activeCell.frameIdx, activeCell.rollIdx, "", false);
  };

  const closePicker = () => {
    setActiveCell(null);
    setSplitPending(false);
  };

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
    setEditSelectedBallId(g.ball?.label ? myBalls.find((b) => b.label === g.ball.label)?.id || null : null);
    setEditUseSecondBall(!!g.ball2);
    setEditBallType2(g.ball2?.type || "house");
    setEditBallWeight2(g.ball2?.weight ? String(g.ball2.weight) : "");
    setEditBallThumbless2(!!g.ball2?.thumbless);
    setEditSelectedBallId2(g.ball2?.label ? myBalls.find((b) => b.label === g.ball2.label)?.id || null : null);
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
    setEditActiveCell(null);
    setEditSplitPending(false);
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
    };
    let ball2 = null;
    if (editUseSecondBall) {
      const selectedBall2 = myBalls.find((b) => b.id === editSelectedBallId2);
      ball2 = {
        type: editBallType2,
        weight: selectedBall2 ? selectedBall2.weight : null,
        thumbless: selectedBall2 ? selectedBall2.thumbless : false,
        label: selectedBall2 ? selectedBall2.label : null,
      };
    }
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
              shoe,
            }
          : g
      )
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
      : { start: customStart, end: customEnd };
  const periodGames = games.filter((g) => g.date >= periodRange.start && g.date <= periodRange.end);
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

  if (accessStatus !== "approved") {
    return (
      <GateScreen
        mode={accessStatus}
        name={requestName}
        setName={setRequestName}
        onSubmit={requestAccess}
        requestNumber={myRequestNumber}
      />
    );
  }

  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: `radial-gradient(ellipse 120% 40% at 50% 0%, rgba(201,162,39,0.16) 0%, rgba(201,162,39,0) 60%), ${COLORS.navyBg}`,
        fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif",
      }}
    >
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
      <header className="px-5 pt-6 pb-4" style={{ background: COLORS.ink }}>
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
              <div className="text-xs mt-0.5" style={{ color: COLORS.oak }}>スコア分析 &amp; 記録</div>
            </div>
          </div>
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
      </header>

      <main className="max-w-md mx-auto px-4 pb-24 pt-5">
        {tab === "scan" && (
          <div className="space-y-4">
            <div className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
              <label className="text-xs flex items-center justify-between mb-1" style={{ color: COLORS.oak }}>
                <span>スコア画面に表示されている自分の名前</span>
                {nameSaved && <span style={{ color: COLORS.gold }}>保存しました</span>}
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
                <div className="text-xs" style={{ color: COLORS.oak }}>電光掲示板や紙のスコアシートでOK</div>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />

            {imagePreview && (
              <div className="rounded-xl overflow-hidden border" style={{ borderColor: COLORS.oak }}>
                <img src={imagePreview} alt="スコア写真プレビュー" className="w-full object-cover max-h-72" />
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
                  {analyzing ? "解析中..." : "解析する"}
                </button>
                <button
                  onClick={() => {
                    setImagePreview(null);
                    setImageMeta(null);
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
              <div className="text-sm rounded-lg p-3" style={{ background: "#FBEAE5", color: COLORS.danger }}>
                {analyzeError}
              </div>
            )}

            {pendingResult && pendingResult.player_matched === false && (
              <div className="rounded-xl p-4 border space-y-2" style={{ borderColor: COLORS.danger, background: "#FBEAE5" }}>
                <div className="text-sm font-bold" style={{ color: COLORS.danger }}>
                  「{playerName || "(名前未入力)"}」に一致する列が見つかりませんでした
                </div>
                {pendingResult.other_players_detected?.length > 0 && (
                  <div className="text-xs" style={{ color: COLORS.cream }}>
                    画面内で検出された名前: {pendingResult.other_players_detected.join(" / ")}
                  </div>
                )}
                {pendingResult.confidence_notes && (
                  <div className="text-xs" style={{ color: COLORS.cream }}>{pendingResult.confidence_notes}</div>
                )}
                <div className="text-xs" style={{ color: COLORS.cream }}>
                  名前の表記を上の欄で修正するか、写真を撮り直して再度解析してください。
                </div>
                <button
                  onClick={() => setPendingResult(null)}
                  className="text-sm rounded-lg px-3 py-2 border mt-1"
                  style={{ borderColor: COLORS.danger, color: COLORS.danger }}
                >
                  やり直す
                </button>
              </div>
            )}

            {pendingResult && pendingResult.player_matched !== false && (
              <div className="space-y-3">
                <div style={{ color: COLORS.cream, fontSize: 16, fontWeight: 700 }}>
                  マスをタップして、正しいスコアに修正できます。
                </div>

                {(pendingResult.games || []).map((game, gameIdx) => (
                  <div key={gameIdx} className="glass-card rounded-xl p-3">
                    {pendingResult.games.length > 1 && (
                      <div className="mb-2 text-xs" style={{ color: COLORS.oak }}>
                        {game.gameLabel || `${gameIdx + 1}ゲーム目`}
                      </div>
                    )}
                    <ScoreSheet
                      frames={game.frames}
                      editable
                      activeCell={activeCell?.gameIdx === gameIdx ? activeCell : null}
                      onCellTap={(frameIdx, rollIdx) => handleCellTap(gameIdx, frameIdx, rollIdx)}
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs" style={{ color: COLORS.oak }}>このゲームの合計</span>
                      <span
                        style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 18, color: COLORS.strike }}
                      >
                        {game.total_score ?? "-"}
                      </span>
                    </div>
                    {game.totalMismatch && (
                      <div
                        className="mt-2 rounded p-2 text-xs"
                        style={{ background: "#FBEAE5", color: COLORS.danger, fontWeight: 700 }}
                      >
                        ⚠ 合計が写真のTOTAL表示と一致しません。マスを写真と見比べて修正してください。
                      </div>
                    )}
                  </div>
                ))}

                {activeCell && (
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
                )}

                <div className="text-xs" style={{ color: COLORS.oak }}>
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
                    <div className="mt-1 text-xs" style={{ color: COLORS.oak }}>
                      {pendingResult.games.length}ゲーム分を、{gameNumber}ゲーム目から連番で保存します
                    </div>
                  )}
                </div>

                <div className="glass-card rounded-xl p-3 space-y-2">
                  <div className="text-sm flex items-center gap-2" style={{ color: COLORS.cream }}>
                    <CircleDot size={16} /> 使用ボール
                  </div>

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
                        style={{
                          background: ballType === opt.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                          color: COLORS.cream,
                          border: `1px solid ${COLORS.oak}`,
                          fontWeight: 700,
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {myBalls.filter((b) => (b.type || "own") === ballType).length === 0 ? (
                    <div className="text-xs" style={{ color: COLORS.oak }}>
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
                            {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""})
                          </option>
                        ))}
                    </select>
                  )}
                </div>

                {!useSecondBall ? (
                  <button
                    type="button"
                    onClick={() => setUseSecondBall(true)}
                    className="w-full rounded-lg py-2 text-xs"
                    style={{ border: `1px dashed ${COLORS.oak}`, color: COLORS.oak }}
                  >
                    + 2つ目のボールを記録する
                  </button>
                ) : (
                  <div className="glass-card rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="text-sm flex items-center gap-2" style={{ color: COLORS.cream }}>
                        <CircleDot size={16} /> 使用ボール(2つ目)
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setUseSecondBall(false);
                          setBallType2("house");
                          setBallWeight2("");
                          setBallThumbless2(false);
                          setSelectedBallId2(null);
                        }}
                        aria-label="2つ目のボールを削除"
                      >
                        <X size={16} style={{ color: COLORS.oak }} />
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
                          style={{
                            background: ballType2 === opt.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                            color: COLORS.cream,
                            border: `1px solid ${COLORS.oak}`,
                            fontWeight: 700,
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {myBalls.filter((b) => (b.type || "own") === ballType2).length === 0 ? (
                      <div className="text-xs" style={{ color: COLORS.oak }}>
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
                              {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""})
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                )}

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
                        style={{
                          background: shoeType === opt.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                          color: COLORS.cream,
                          border: `1px solid ${COLORS.oak}`,
                          fontWeight: 700,
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {shoeType === "rental" ? null : myShoes.length === 0 ? (
                    <div className="text-xs" style={{ color: COLORS.oak }}>
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
                  style={{ background: COLORS.ink, color: COLORS.cream, fontWeight: 700 }}
                >
                  <Check size={18} /> 記録を保存
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setPendingResult(null);
                    setImagePreview(null);
                    setImageMeta(null);
                    setAnalyzeError("");
                    setActiveCell(null);
                    setSplitPending(false);
                  }}
                  className="w-full rounded-lg py-4 text-base"
                  style={{ border: `2px solid ${COLORS.oak}`, color: COLORS.cream, fontWeight: 700 }}
                >
                  撮り直す
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="space-y-3">
            {loadingGames && <div className="text-sm text-center py-10" style={{ color: COLORS.oak }}>読み込み中...</div>}
            {!loadingGames && games.length === 0 && (
              <div className="text-sm text-center py-16" style={{ color: COLORS.oak }}>
                まだ記録がありません。「スコア記録」タブから撮影してみましょう。
              </div>
            )}
            {[...games].reverse().map((g) =>
              editingGameId === g.id ? (
                <div key={g.id} className="rounded-xl p-3 border glass-card space-y-3" style={{ borderColor: COLORS.gold }}>
                  <div className="flex items-center justify-between">
                    <div style={{ color: COLORS.gold, fontWeight: 700, fontSize: 15 }}>記録を編集中</div>
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
                        style={{ background: COLORS.ink, color: COLORS.cream, fontWeight: 700 }}
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
                    <span className="text-xs" style={{ color: COLORS.oak }}>ゲーム目</span>
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

                  <div className="rounded-xl p-3 border space-y-2" style={{ borderColor: COLORS.oak, background: COLORS.cream }}>
                    <div className="text-xs" style={{ color: COLORS.oak }}>ボール</div>
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
                          style={{
                            background: editBallType === opt.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                            color: COLORS.cream,
                            border: `1px solid ${COLORS.oak}`,
                            fontWeight: 700,
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {myBalls.filter((b) => (b.type || "own") === editBallType).length === 0 ? (
                      <div className="text-xs" style={{ color: COLORS.oak }}>
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
                              {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""})
                            </option>
                          ))}
                      </select>
                    )}
                  </div>

                  {!editUseSecondBall ? (
                    <button
                      type="button"
                      onClick={() => setEditUseSecondBall(true)}
                      className="w-full rounded-lg py-2 text-xs"
                      style={{ border: `1px dashed ${COLORS.oak}`, color: COLORS.oak }}
                    >
                      + 2つ目のボールを追加
                    </button>
                  ) : (
                    <div className="rounded-xl p-3 border space-y-2" style={{ borderColor: COLORS.oak, background: COLORS.cream }}>
                      <div className="flex items-center justify-between">
                        <div className="text-xs" style={{ color: COLORS.oak }}>ボール(2つ目)</div>
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
                            style={{
                              background: editBallType2 === opt.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                              color: COLORS.cream,
                              border: `1px solid ${COLORS.oak}`,
                              fontWeight: 700,
                            }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      {myBalls.filter((b) => (b.type || "own") === editBallType2).length === 0 ? (
                        <div className="text-xs" style={{ color: COLORS.oak }}>
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
                                {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""})
                              </option>
                            ))}
                        </select>
                      )}
                    </div>
                  )}

                  <div className="rounded-xl p-3 border space-y-2" style={{ borderColor: COLORS.oak, background: COLORS.cream }}>
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
                          style={{
                            background: editShoeType === opt.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                            color: COLORS.cream,
                            border: `1px solid ${COLORS.oak}`,
                            fontWeight: 700,
                          }}
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
                  <div style={{ color: COLORS.oak, fontSize: 14 }}>
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
                      <Pencil size={16} style={{ color: COLORS.oak }} />
                    </button>
                    <button onClick={() => setConfirmDeleteId(g.id)} aria-label="削除">
                      <X size={16} style={{ color: COLORS.oak }} />
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
                  <div className="mb-2 flex items-center gap-1" style={{ color: COLORS.oak, fontSize: 13 }}>
                    <CircleDot size={11} />
                    {g.ball.label ? g.ball.label : g.ball.type === "own" ? "マイボール" : "ハウスボール"}
                    {g.ball.weight ? ` ${g.ball.weight}lb` : ""}
                    {g.ball.thumbless ? " ・ サムレス" : ""}
                  </div>
                )}
                {g.ball2 && (g.ball2.weight || g.ball2.type) && (
                  <div className="mb-2 flex items-center gap-1" style={{ color: COLORS.oak, fontSize: 13 }}>
                    <CircleDot size={11} />
                    {g.ball2.label ? g.ball2.label : g.ball2.type === "own" ? "マイボール" : "ハウスボール"}
                    {g.ball2.weight ? ` ${g.ball2.weight}lb` : ""}
                    {g.ball2.thumbless ? " ・ サムレス" : ""}
                    <span style={{ color: COLORS.gold }}>(2つ目)</span>
                  </div>
                )}
                {g.shoe && g.shoe.type && (
                  <div className="mb-2 flex items-center gap-1" style={{ color: COLORS.oak, fontSize: 13 }}>
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
              <div className="text-sm text-center py-16" style={{ color: COLORS.oak }}>
                データがまだありません。記録を保存すると統計が表示されます。
              </div>
            ) : (
              <>
                <div className="flex gap-1.5">
                  {[
                    { key: "day", label: "日" },
                    { key: "week", label: "週" },
                    { key: "month", label: "月" },
                    { key: "custom", label: "期間指定" },
                  ].map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setPeriodMode(p.key)}
                      className="flex-1 rounded-lg py-2 text-sm"
                      style={{
                        background: periodMode === p.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                        color: COLORS.cream,
                        border: `1px solid ${COLORS.oak}`,
                        fontWeight: 700,
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
                      <div className="text-center text-xs" style={{ color: COLORS.oak }}>
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
                      <div className="text-center text-xs" style={{ color: COLORS.oak }}>
                        {formatMD(periodRange.start)} 〜 {formatMD(periodRange.end)}
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
                      <span style={{ color: COLORS.oak }}>〜</span>
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
                  <div className="text-sm text-center py-10" style={{ color: COLORS.oak }}>
                    この期間の記録はまだありません
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.oak }}>ゲーム数</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream }}>{periodGames.length}</div>
                      </div>
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.oak }}>アベレージ</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.cream }}>{avg}</div>
                      </div>
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs flex items-center justify-center gap-1" style={{ color: COLORS.oak }}>
                          <Trophy size={12} /> ハイゲーム
                        </div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.strike }}>{highGame}</div>
                      </div>
                      <div className="rounded-xl p-3 border glass-card text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.oak }}>ローゲーム</div>
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
                                <span style={{ color: COLORS.gold, fontWeight: 700 }}> ・ 達成!</span>
                              ) : (
                                <span> ・ あと{Number(goalAverage) - avg}</span>
                              )}
                            </div>
                          )}
                          {goalScore && (
                            <div>
                              目標スコア {goalScore}
                              {highGame >= Number(goalScore) ? (
                                <span style={{ color: COLORS.gold, fontWeight: 700 }}> ・ 達成!</span>
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
                            <span style={{ color: COLORS.oak, fontSize: 13 }}>回</span>
                            <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16, color: COLORS.strike, minWidth: 42, textAlign: "right" }}>
                              {row.rate}%
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>

                    <details className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
                      <summary className="px-3 py-2 cursor-pointer text-sm" style={{ color: COLORS.oak }}>
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
                            <div className="text-xs" style={{ color: COLORS.oak }}>{row.formula}</div>
                          </div>
                        ))}
                      </div>
                    </details>

                    <div className="rounded-xl p-3 border glass-card" style={{ borderColor: COLORS.oak }}>
                      <div className="text-xs mb-2 flex items-center gap-1" style={{ color: COLORS.oak }}>
                        <TrendingUp size={14} />
                        {periodMode === "day" ? "本日のゲームごとのスコア" : "日ごとの平均スコア推移"}
                      </div>
                      <ResponsiveContainer width="100%" height={240}>
                        <LineChart data={chartData} margin={{ top: 20, right: 10, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#E5DCC8" />
                          <XAxis dataKey="label" tick={{ fontSize: 13, fill: COLORS.oak }} />
                          <YAxis domain={[0, 300]} ticks={[0, 50, 100, 150, 200, 250, 300]} tick={{ fontSize: 13, fill: COLORS.oak }} />
                          <Tooltip contentStyle={{ fontSize: 14, borderColor: COLORS.oak }} />
                          <Line
                            type="monotone"
                            dataKey="total"
                            stroke={COLORS.strike}
                            strokeWidth={2.5}
                            dot={{ r: 3, fill: COLORS.strike }}
                            label={{ position: "top", fontSize: 13, fontWeight: 700, fill: COLORS.ink }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>

                    {periodMode === "day" && periodGames.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs flex items-center gap-1" style={{ color: COLORS.oak }}>
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
                                  style={{ background: COLORS.cream }}
                                >
                                  <span className="text-sm" style={{ color: COLORS.cream, fontWeight: 700 }}>
                                    {g.gameNumber ? `第${g.gameNumber}ゲーム` : "ゲーム"}
                                  </span>
                                  <span
                                    style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 18, color: COLORS.strike }}
                                  >
                                    {g.total}
                                  </span>
                                </div>
                                <div className="px-3 pt-2 pb-3" style={{ borderBottom: `1px solid #EFE4CC` }}>
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
                                    style={{ borderTop: `1px solid #EFE4CC` }}
                                  >
                                    <span style={{ color: COLORS.cream, fontSize: 14 }}>{row.label}</span>
                                    <span className="flex items-baseline gap-2">
                                      <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 15, color: COLORS.cream }}>
                                        {row.count}
                                      </span>
                                      <span style={{ color: COLORS.oak, fontSize: 12 }}>回</span>
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
                  </>
                )}
              </>
            )}
          </div>
        )}

        {tab === "profile" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm" style={{ color: COLORS.oak }}>基本情報</div>
              {profileSaved && <span style={{ color: COLORS.gold, fontSize: 13 }}>保存しました</span>}
            </div>

            <div className="rounded-xl p-3 border glass-card space-y-3" style={{ borderColor: COLORS.oak }}>
              {myRequestNumber && (
                <div style={{ color: COLORS.cream, fontSize: 15, fontWeight: 700 }}>
                  ID:{formatRequestNumber(myRequestNumber)}
                </div>
              )}
              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.oak }}>ニックネーム</div>
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
                <div className="text-xs mb-1" style={{ color: COLORS.oak }}>利き手</div>
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
                      style={{
                        background: dominantHand === opt.key ? COLORS.ink : "rgba(40, 55, 95, 0.55)",
                        color: COLORS.cream,
                        border: `1px solid ${COLORS.oak}`,
                        fontWeight: 700,
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs mb-1 flex items-center gap-1" style={{ color: COLORS.oak }}>
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
                <div className="text-xs mb-1 flex items-center gap-1" style={{ color: COLORS.oak }}>
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
                <div className="text-xs mb-1" style={{ color: COLORS.oak }}>ホームセンター(よく行くボウリング場)</div>
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

            <div className="text-sm" style={{ color: COLORS.oak }}>登録済みのボール</div>

            <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
              {myBalls.length === 0 ? (
                <div className="p-3 text-xs text-center" style={{ color: COLORS.oak }}>
                  まだ登録されていません
                </div>
              ) : (
                myBalls.map((b, i) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between px-3 py-2"
                    style={{ borderTop: i === 0 ? "none" : `1px solid #EFE4CC` }}
                  >
                    <div>
                      <div className="text-sm" style={{ color: COLORS.cream, fontWeight: 700 }}>
                        {b.label}
                        <span style={{ color: COLORS.oak, fontWeight: 400, fontSize: 13 }}>
                          {" "}
                          ({b.type === "house" ? "ハウスボール" : "マイボール"})
                        </span>
                      </div>
                      <div className="text-xs" style={{ color: COLORS.oak }}>
                        {b.weight}lb{b.thumbless ? " ・ サムレス" : ""}
                      </div>
                      {(b.core || b.coverstock || b.motion || b.laneCondition) && (
                        <div className="text-xs" style={{ color: COLORS.gold }}>
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
                    </div>
                    <button onClick={() => deleteMyBall(b.id)} aria-label="削除">
                      <Trash2 size={16} style={{ color: COLORS.oak }} />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
              <div className="text-xs" style={{ color: COLORS.oak }}>新しいボールを登録</div>

              <select
                value={newBallType}
                onChange={(e) => setNewBallType(e.target.value)}
                className="w-full px-3 py-2 rounded border text-sm"
                style={{ borderColor: COLORS.oak, color: COLORS.ink }}
              >
                <option value="own">マイボール</option>
                <option value="house">ハウスボール</option>
              </select>

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
                <span className="text-xs" style={{ color: COLORS.oak }}>ポンド</span>
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
                    <div className="text-xs mb-1" style={{ color: COLORS.oak }}>コアタイプ</div>
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
                    <div className="text-xs mb-1" style={{ color: COLORS.oak }}>カバーストック</div>
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
                    <div className="text-xs mb-1" style={{ color: COLORS.oak }}>球質(回転タイプ)</div>
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
                    <div className="text-xs mb-1" style={{ color: COLORS.oak }}>適したレーンコンディション</div>
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
                <div className="text-xs mb-1" style={{ color: COLORS.oak }}>登録名</div>
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
                style={{ background: COLORS.ink, color: COLORS.cream, fontWeight: 700, opacity: newBallWeight ? 1 : 0.5 }}
              >
                追加する
              </button>
            </div>

            <div className="text-sm" style={{ color: COLORS.oak }}>登録済みのマイシューズ</div>

            <div className="rounded-xl border glass-card overflow-hidden" style={{ borderColor: COLORS.oak }}>
              {myShoes.length === 0 ? (
                <div className="p-3 text-xs text-center" style={{ color: COLORS.oak }}>
                  まだ登録されていません
                </div>
              ) : (
                myShoes.map((s, i) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between px-3 py-2"
                    style={{ borderTop: i === 0 ? "none" : `1px solid #EFE4CC` }}
                  >
                    <div className="text-sm" style={{ color: COLORS.cream, fontWeight: 700 }}>{s.label}</div>
                    <button onClick={() => deleteMyShoe(s.id)} aria-label="削除">
                      <Trash2 size={16} style={{ color: COLORS.oak }} />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="rounded-xl p-3 border glass-card space-y-2" style={{ borderColor: COLORS.oak }}>
              <div className="text-xs" style={{ color: COLORS.oak }}>新しいマイシューズを登録</div>

              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.oak }}>登録名</div>
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
                style={{ background: COLORS.ink, color: COLORS.cream, fontWeight: 700, opacity: newShoeName.trim() ? 1 : 0.5 }}
              >
                追加する
              </button>
            </div>

            <div className="text-sm" style={{ color: COLORS.oak }}>ご意見・要望</div>
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

            <div className="flex items-center justify-center gap-4 pt-2" style={{ fontSize: 13, color: COLORS.oak }}>
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
        style={{ background: COLORS.ink, borderColor: COLORS.oak }}
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
                style={{ color: active ? COLORS.strike : COLORS.oak }}
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
          className="fixed inset-0 flex flex-col"
          style={{ background: COLORS.navyBg, zIndex: 50 }}
        >
          <div
            className="flex items-center justify-between px-4 py-4"
            style={{ background: COLORS.ink }}
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
              <div className="text-xs text-center py-6" style={{ color: COLORS.oak }}>
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
                  style={{ color: COLORS.oak }}
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

          <div className="p-3 flex items-center gap-2" style={{ borderTop: `1px solid ${COLORS.oak}`, background: COLORS.navyBg }}>
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
              className="flex-1 px-3 py-2 rounded-lg border text-sm"
              style={{ borderColor: COLORS.oak, color: COLORS.ink }}
            />
            <button
              type="button"
              onClick={sendChatMessage}
              disabled={chatSending || !chatInput.trim()}
              className="rounded-lg px-3 py-2 flex items-center justify-center"
              style={{ background: COLORS.strike, color: COLORS.ink, opacity: chatInput.trim() ? 1 : 0.5 }}
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
