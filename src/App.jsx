import React, { useState, useEffect, useRef, useCallback } from "react";
import { Camera, History, BarChart3, Loader2, Check, X, Pencil, Trophy, TrendingUp, Calendar, CircleDot, Hash, User, Target, Trash2, Video, Play, Pause, Square } from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// ---------- palette ----------
// ink:      #201811  (deep walnut, headers/text)
// oak:      #A9713F  (lane wood, structural accents)
// cream:    #F6EFE2  (pin ivory, background)
// strike:   #D5482B  (pin-stripe red, primary accent / strikes)
// gold:     #D9A441  (foul-line gold, secondary accent / spares)

const COLORS = {
  ink: "#201811",
  oak: "#A9713F",
  cream: "#F6EFE2",
  strike: "#D5482B",
  gold: "#D9A441",
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
          // partway through the request.
          // Compressed as small as reasonably possible while the text stays
          // legible, as a stopgap while investigating the mobile Safari issue.
          outUrl = canvas.toDataURL("image/jpeg", 0.85);
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
  return JSON.parse(cleaned.slice(start, end + 1));
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

電光掲示板でよくある表示の特徴(該当する場合のみ考慮):
- 表の一番上に「1 2 3 4 5 6 7 8 9 10」のようなフレーム番号のヘッダー行がある場合、それを基準にして各列がどのフレームかを機械的に特定すること。ヘッダーがずれて見えても、フレーム数は必ず10個であることを前提に列を数え直して位置合わせする。フレームの取り違えは起きないよう、この基準を最優先で使う
- ストライクは文字の「X」ではなく、緑や黒の三角形・矢印のようなアイコン、または蝶ネクタイ(ネクタイ)のような形のアイコンで表示されることがある。これらの記号を見つけたらストライク(pins内部的には"X")として扱う。スペアも「/」ではなく記号やハイフンの組み合わせで表示される場合がある
- 各フレームのセルが上下2段になっていることが多い。上段は投球結果の記号、下段はそのフレーム終了時点の累計スコア(数字)
- 上段の記号アイコンが小さく判読しにくい場合は、下段の累計スコアの数字を最優先で正確に読み取ること。累計スコアの数字は判読しやすく、フレーム間の差分からストライク/スペア/オープンフレームをかなり正確に推定できる
- プレイヤー名の直後に区分ラベルらしき1文字の英字(例:「A」)が付いていることがある。これは名前そのものではない可能性があるため、名前照合の際は末尾の1文字英字を無視して比較する
- 「HDCP」はハンディキャップの略で、スコアそのものではない。「レーン合計」や複数ゲームの累計列も同様にゲームのスコアではない。読み取るべき合計スコアは、10フレーム分のスコア推移の直後にある「TOTAL」列の値のみで、HDCP・レーン合計・累計・順位などの列は無視する
- 写真が斜め・手ブレ・多少ぼやけている・画面の一部が反射で見えにくい場合でも、諦めずに文字の形状、周囲の数字との整合性、フレームの位置関係から可能な限り推測すること。多少画質が粗くても、数字の並び(1桁刻みで増える累計スコアなど)から妥当な値を推定できることが多い
- それでも判読が困難な箇所は、無理に確定せず confidence_notes に具体的に記載する(例:「5フレーム目のマークが不鮮明」)

読み取りは以下の手順で慎重に行ってください:
1. まず画面の種類(電光掲示板のデジタル表示か、紙のスコアシートか)と、対象プレイヤーの列/行の位置を確認する
2. フレーム1から10まで、1フレームずつ順番に投球結果を読み取る。数字の間違えやすい組み合わせ(例: 6と8、1と7、Xと数字)は特に注意して見る
3. 各フレームを読み終えたら、そのフレームの累計スコアが「前のフレームの累計 + このフレームで倒したピン数」と矛盾していないか自分で検算する。矛盾があれば、数字の読み取りを見直して修正する
4. 全フレームを読み終えたら、10フレーム目の累計スコアと、画面に表示されている「TOTAL」列の数字を突き合わせる。一致しない場合は、どこかのフレームの投球結果(特にストライク/スペアの見落とし)を読み間違えている可能性が高いので、frame_by_frame_readingを最初から見直し、一致するまで修正すること。TOTAL表示は画像上で最も読み取りやすい数字であることが多いため、最終的な正解の基準として扱う
5. 最後に、読み取った内容を次のJSON形式のみで出力する。前置き・説明・マークダウンの記号は一切含めない

{
  "screen_type": "digital" または "paper",
  "player_matched": true,
  "matched_name_on_screen": "画面上に表示されていた実際の表記",
  "other_players_detected": ["画面にいた他の人の名前など"],
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

ルール:
- rolls の値は "0"〜"10" の数字文字列、ストライクは "X"、スペアの2投目は "/"
- frames は必ず10フレーム分(読み取れる範囲まで)
- 10フレーム目は最大3投
- score は各フレーム終了時点の累計スコア(手順3で検算した値)。10フレーム目まで画像に表示されている場合は、必ず10個分のscoreを埋めること。最終フレームの累計が画面上の「TOTAL」の値と一致するか必ず確認する
- split_roll_index は、そのフレームの中で数字が丸で囲まれている(スプリットを示す)投球が何投目か(0始まりのインデックス)を表す。スプリットは1投目とは限らず、10フレーム目のボーナス球(2投目・3投目)に付くこともあるので、実際に丸が付いている投球の位置を必ず確認すること。丸が付いた投球がなければ null
- frame_by_frame_reading は手順2〜3の思考過程を1フレームずつ短い日本語で記載する(この項目を必ず frames より先に埋めること)
- 指定された名前に一致する列が画面内に見つからない場合は player_matched を false にし、frames は空配列、confidence_notes に「該当する名前が見つかりませんでした」等を記載
- 名前の指定がない場合は player_matched を true とし、画面内の(唯一の、または最初の)スコアを読み取る
- 数字がかすれている・反射で見えにくいなど読み取りに自信がない箇所は confidence_notes に短く日本語で記載(なければ空文字)
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
  const content = val === "0" ? "-" : val;
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
      <div className="text-center tracking-widest py-0.5" style={{ color: COLORS.oak, fontFamily: "'Oswald', sans-serif", fontSize: 10 }}>
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
      className="rounded-lg py-2 text-sm"
      style={{ background: "white", border: `1px solid ${COLORS.oak}`, color: COLORS.ink, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
    >
      {label}
    </button>
  );
  return (
    <div className="rounded-xl p-3 border space-y-2" style={{ borderColor: COLORS.oak, background: COLORS.cream }}>
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
          className="rounded-lg py-2 flex items-center justify-center text-sm"
          style={{ background: "white", border: `1px solid ${COLORS.strike}`, color: COLORS.strike, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
        >
          X
        </button>
      </div>

      <div className="grid grid-cols-5 gap-1.5">
        <button
          type="button"
          onClick={() => onSelect("/")}
          className="rounded-lg py-2 flex items-center justify-center text-sm"
          style={{ background: "white", border: `1px solid ${COLORS.gold}`, color: COLORS.gold, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}
        >
          /
        </button>
        <button
          type="button"
          onClick={() => onSelect("G")}
          className="rounded-lg py-2 text-xs"
          style={{ background: "white", border: `1px solid ${COLORS.oak}`, color: COLORS.ink, fontWeight: 700 }}
        >
          G(ガーター)
        </button>
        <button
          type="button"
          onClick={() => onSelect("F")}
          className="rounded-lg py-2 text-xs"
          style={{ background: "white", border: `1px solid ${COLORS.strike}`, color: COLORS.strike, fontWeight: 700 }}
        >
          F(ファール)
        </button>
        <button
          type="button"
          onClick={() => onSelect("-")}
          className="rounded-lg py-2 text-xs"
          style={{ background: "white", border: `1px solid ${COLORS.oak}`, color: COLORS.ink, fontWeight: 700 }}
        >
          -(オープン)
        </button>
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg py-2 text-xs"
          style={{ background: "white", border: `1px solid ${COLORS.oak}`, color: COLORS.oak, fontWeight: 700 }}
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
            background: splitActive ? COLORS.gold : "white",
            border: `1px solid ${COLORS.gold}`,
            color: splitActive ? "white" : COLORS.ink,
            fontWeight: 700,
          }}
        >
          スプリット(⑧のように丸で囲む){splitActive ? ": ON" : ""}
        </button>
      )}
    </div>
  );
}

// ---------- main app ----------
export default function StrikeLog() {
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
  const [gameDate, setGameDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [gameNumber, setGameNumber] = useState(1);
  const [gameNumberTouched, setGameNumberTouched] = useState(false);
  const [playerName, setPlayerName] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [ballType, setBallType] = useState("house"); // "house" | "own"
  const [ballWeight, setBallWeight] = useState("");
  const [ballThumbless, setBallThumbless] = useState(false);
  const [selectedBallId, setSelectedBallId] = useState(null);
  const [myBalls, setMyBalls] = useState([]); // [{ id, label, weight, thumbless }]
  const [dominantHand, setDominantHand] = useState("right"); // "right" | "left"
  const [goalAverage, setGoalAverage] = useState("");
  const [goalScore, setGoalScore] = useState("");
  const [homeCenter, setHomeCenter] = useState("");
  const [nickname, setNickname] = useState("");
  const [newBallType, setNewBallType] = useState("own"); // "own" | "house"
  const [newBallWeight, setNewBallWeight] = useState("");
  const [newBallThumbless, setNewBallThumbless] = useState(false);
  const [newBallCore, setNewBallCore] = useState(""); // "symmetric" | "asymmetric"
  const [newBallCoverstock, setNewBallCoverstock] = useState(""); // "reactive" | "urethane" | "plastic" | "particle"
  const [newBallMotion, setNewBallMotion] = useState(""); // "straight" | "mild_curve" | "hook" | "backup"
  const [newBallLaneCondition, setNewBallLaneCondition] = useState(""); // "dry" | "medium" | "oily"
  const [profileSaved, setProfileSaved] = useState(false);
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
  const fileInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const videoRef = useRef(null);
  const [formVideoUrl, setFormVideoUrl] = useState(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);

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
  }, []);

  // Suggests the next game number for the selected date (existing games for
  // that date + 1), unless the person has manually edited the field for this
  // session — manual edits are never silently overwritten.
  useEffect(() => {
    if (gameNumberTouched) return;
    const sameDay = games.filter((g) => g.date === gameDate).length;
    setGameNumber(sameDay + 1);
  }, [gameDate, games, gameNumberTouched]);

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
    const ball = {
      id: uid(),
      type: newBallType,
      label: `${typeLabel} ${newBallWeight}lb${newBallThumbless ? "・サムレス" : ""}`,
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
        const framesWithSplitRolls = (result.frames || []).map((f) => {
          const splitRolls = [];
          if (typeof f.split_roll_index === "number") splitRolls[f.split_roll_index] = true;
          return { ...f, splitRolls };
        });
        const norm = normalizeGame(framesWithSplitRolls);
        const ocrTotal = Number(result.total_score);
        const hasOcrTotal = Number.isFinite(ocrTotal);
        const mismatch =
          norm.total !== null && hasOcrTotal && norm.total !== ocrTotal
            ? { computed: norm.total, ocrRead: ocrTotal }
            : null;
        setPendingResult({
          ...result,
          frames: norm.frames,
          total_score: norm.total !== null ? norm.total : hasOcrTotal ? ocrTotal : null,
          ocrTotal: hasOcrTotal ? ocrTotal : null,
          totalMismatch: mismatch,
        });
      }
    } catch (e) {
      setAnalyzeError(e.message || "解析中にエラーが発生しました");
    } finally {
      setAnalyzing(false);
    }
  };

  const saveGame = async () => {
    if (!pendingResult) return;
    const selectedBall = myBalls.find((b) => b.id === selectedBallId);
    const ball =
      ballType === "house"
        ? { type: "house", weight: ballWeight ? Number(ballWeight) : null, thumbless: ballThumbless, label: null }
        : {
            type: "own",
            weight: selectedBall ? selectedBall.weight : null,
            thumbless: selectedBall ? selectedBall.thumbless : false,
            label: selectedBall ? selectedBall.label : null,
          };
    const newGame = {
      id: uid(),
      date: gameDate,
      gameNumber: Number(gameNumber) || 1,
      frames: pendingResult.frames || [],
      total: pendingResult.total_score ?? 0,
      ball,
      createdAt: Date.now(),
    };
    const next = [...games, newGame].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.gameNumber || 1) - (b.gameNumber || 1)
    );
    await persistGames(next);
    await saveBallConfig({ ballType, ballWeight, ballThumbless });
    setPendingResult(null);
    setImagePreview(null);
    setImageMeta(null);
    setActiveCell(null);
    setSplitPending(false);
    setGameNumberTouched(false);
    setTab("history");
  };

  // Editing a roll re-runs official scoring across the whole game, since a
  // single strike/spare change can shift every later cumulative score —
  // exactly like fixing a mistake on a paper scoresheet. isSplit marks that
  // specific roll's pin count as a circled split (any roll can be a split,
  // not just the frame's opening ball — e.g. a 10th-frame bonus ball).
  const updateRollValue = (frameIdx, rollIdx, value, isSplit) => {
    setPendingResult((prev) => {
      const rawFrames = prev.frames.map((f, i) => {
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
        norm.total !== null && prev.ocrTotal !== null && norm.total !== prev.ocrTotal
          ? { computed: norm.total, ocrRead: prev.ocrTotal }
          : null;
      return {
        ...prev,
        frames: norm.frames,
        total_score: norm.total !== null ? norm.total : prev.total_score,
        totalMismatch: mismatch,
      };
    });
  };

  // Opens the picker for a given cell, pre-loading the split toggle to match
  // whatever that specific roll's current state already is.
  const handleCellTap = (frameIdx, rollIdx) => {
    setActiveCell({ frameIdx, rollIdx });
    setSplitPending(!!pendingResult?.frames?.[frameIdx]?.splitRolls?.[rollIdx]);
  };

  const handlePickerSelect = (value) => {
    if (!activeCell) return;
    const { frameIdx, rollIdx } = activeCell;
    // A strike can't also be a split (a strike leaves no pins standing), so
    // the split toggle only applies to non-strike selections.
    const isSplit = value !== "X" && splitPending;
    updateRollValue(frameIdx, rollIdx, value, isSplit);
    setActiveCell(null);
    setSplitPending(false);
  };

  const handlePickerClear = () => {
    if (!activeCell) return;
    updateRollValue(activeCell.frameIdx, activeCell.rollIdx, "", false);
  };

  const closePicker = () => {
    setActiveCell(null);
    setSplitPending(false);
  };

  // ---------- form analysis: video playback ----------
  const handleVideoFile = (file) => {
    if (!file) return;
    if (formVideoUrl) URL.revokeObjectURL(formVideoUrl);
    const url = URL.createObjectURL(file);
    setFormVideoUrl(url);
    setIsPlaying(false);
    setPlaybackRate(1);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const stopVideo = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    setIsPlaying(false);
  };

  const changeRate = (rate) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  const clearVideo = () => {
    if (formVideoUrl) URL.revokeObjectURL(formVideoUrl);
    setFormVideoUrl(null);
    setIsPlaying(false);
    setPlaybackRate(1);
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
  const chartIsBar = periodMode === "day";

  return (
    <div className="min-h-screen w-full" style={{ background: COLORS.cream, fontFamily: "'Noto Sans JP', 'Hiragino Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');
      `}</style>

      {/* header */}
      <header className="px-5 pt-6 pb-4" style={{ background: COLORS.ink }}>
        <div className="flex items-center justify-between max-w-md mx-auto">
          <div>
            <div className="text-2xl tracking-wide" style={{ color: COLORS.cream, fontFamily: "'Oswald', sans-serif", fontWeight: 700 }}>
              STRIKE LOG <span style={{ fontSize: 14, color: COLORS.oak }}>トライアル</span>
            </div>
            <div className="text-xs mt-0.5" style={{ color: COLORS.oak }}>スコア記録 &amp; フォーム分析</div>
          </div>
          <img
            src="/icons/icon-192.png"
            alt="STRIKE LOG"
            className="w-10 h-10 rounded-full"
            style={{ objectFit: "cover" }}
          />
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pb-24 pt-5">
        {tab === "scan" && (
          <div className="space-y-4">
            <div className="rounded-xl p-3 border bg-white" style={{ borderColor: COLORS.oak }}>
              <label className="text-xs flex items-center justify-between mb-1" style={{ color: COLORS.oak }}>
                <span>スコア画面に表示されている、自分の名前</span>
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
                className="w-full flex flex-col items-center justify-center gap-3 rounded-xl py-14 border-2 border-dashed"
                style={{ borderColor: COLORS.oak, background: "white" }}
              >
                <Camera size={40} style={{ color: COLORS.strike }} />
                <div style={{ color: COLORS.ink, fontWeight: 700 }}>スコア画面を撮影 / アップロード</div>
                <div className="text-xs" style={{ color: COLORS.oak }}>電光掲示板や紙のスコアシートでOK</div>
                <div className="text-xs text-center px-4" style={{ color: COLORS.gold }}>
                  できるだけ正面から、明るく鮮明に撮ると解析の精度が上がります
                </div>
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
                  style={{ background: COLORS.strike, color: "white", fontWeight: 700 }}
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
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                >
                  撮り直す
                </button>
              </div>
            )}

            {analyzeError && (
              <div className="text-sm rounded-lg p-3" style={{ background: "#FBEAE5", color: COLORS.strike }}>
                {analyzeError}
              </div>
            )}

            {pendingResult && pendingResult.player_matched === false && (
              <div className="rounded-xl p-4 border space-y-2" style={{ borderColor: COLORS.strike, background: "#FBEAE5" }}>
                <div className="text-sm font-bold" style={{ color: COLORS.strike }}>
                  「{playerName || "(名前未入力)"}」に一致する列が見つかりませんでした
                </div>
                {pendingResult.other_players_detected?.length > 0 && (
                  <div className="text-xs" style={{ color: COLORS.ink }}>
                    画面内で検出された名前: {pendingResult.other_players_detected.join(" / ")}
                  </div>
                )}
                {pendingResult.confidence_notes && (
                  <div className="text-xs" style={{ color: COLORS.ink }}>{pendingResult.confidence_notes}</div>
                )}
                <div className="text-xs" style={{ color: COLORS.ink }}>
                  名前の表記を上の欄で修正するか、写真を撮り直して再度解析してください。
                </div>
                <button
                  onClick={() => setPendingResult(null)}
                  className="text-sm rounded-lg px-3 py-2 border mt-1"
                  style={{ borderColor: COLORS.strike, color: COLORS.strike }}
                >
                  やり直す
                </button>
              </div>
            )}

            {pendingResult && pendingResult.player_matched !== false && (
              <div className="space-y-3">
                <div className="mb-2" style={{ color: COLORS.oak, fontSize: 11 }}>
                  マスをタップすると、数字やストライク・スペア・ガーター・スプリットを選んで修正できます
                </div>
                <div className="rounded-xl p-3 border" style={{ borderColor: COLORS.oak, background: "white" }}>
                  <div className="flex items-center justify-between mb-2 text-xs" style={{ color: COLORS.oak }}>
                    <span className="flex items-center gap-2">
                      <Pencil size={14} />
                      読み取り結果(マスをタップして修正できます)
                    </span>
                    {pendingResult.matched_name_on_screen && (
                      <span style={{ color: COLORS.gold, fontWeight: 700 }}>
                        {pendingResult.matched_name_on_screen} さんの列
                      </span>
                    )}
                  </div>
                  <ScoreSheet
                    frames={pendingResult.frames}
                    editable
                    activeCell={activeCell}
                    onCellTap={handleCellTap}
                  />
                  {pendingResult.totalMismatch && (
                    <div
                      className="mt-2 rounded p-2 text-xs"
                      style={{ background: "#FBEAE5", color: COLORS.strike, fontWeight: 700 }}
                    >
                      ⚠ 投球結果からの計算値({pendingResult.totalMismatch.computed})と、画面のTOTAL表示から読み取った値(
                      {pendingResult.totalMismatch.ocrRead})が一致しません。どこかのフレームの読み取りがズレている可能性があります。上のマスを写真と見比べて修正してください。
                    </div>
                  )}
                  {pendingResult.other_players_detected?.length > 0 && (
                    <div className="mt-2" style={{ color: COLORS.oak, fontSize: 11 }}>
                      他に検出された参加者: {pendingResult.other_players_detected.join(" / ")}(記録対象外)
                    </div>
                  )}
                  {pendingResult.confidence_notes && (
                    <div className="mt-2 text-xs" style={{ color: COLORS.gold }}>
                      ⚠ {pendingResult.confidence_notes}
                    </div>
                  )}
                  {pendingResult.frame_by_frame_reading?.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer" style={{ color: COLORS.oak, fontSize: 11 }}>
                        フレームごとの読み取り根拠を見る(写真と見比べて確認できます)
                      </summary>
                      <ul className="mt-1 space-y-0.5" style={{ color: COLORS.ink, fontSize: 11 }}>
                        {pendingResult.frame_by_frame_reading.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>

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

                <div className="rounded-xl p-3 border flex items-center justify-between" style={{ borderColor: COLORS.oak, background: "white" }}>
                  <span className="text-sm" style={{ color: COLORS.ink }}>合計スコア(自動計算)</span>
                  <span
                    style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, color: COLORS.strike }}
                  >
                    {pendingResult.total_score ?? "-"}
                  </span>
                </div>

                <div className="rounded-xl p-3 border flex items-center justify-between" style={{ borderColor: COLORS.oak, background: "white" }}>
                  <span className="text-sm flex items-center gap-2" style={{ color: COLORS.ink }}>
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

                <div className="rounded-xl p-3 border flex items-center justify-between" style={{ borderColor: COLORS.oak, background: "white" }}>
                  <span className="text-sm flex items-center gap-2" style={{ color: COLORS.ink }}>
                    <Hash size={16} /> 何ゲーム目
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setGameNumberTouched(true);
                        setGameNumber((n) => Math.max(1, Number(n) - 1));
                      }}
                      className="w-7 h-7 rounded border flex items-center justify-center"
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
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
                      style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="rounded-xl p-3 border space-y-2" style={{ borderColor: COLORS.oak, background: "white" }}>
                  <div className="text-sm flex items-center gap-2" style={{ color: COLORS.ink }}>
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
                          background: ballType === opt.key ? COLORS.ink : "white",
                          color: ballType === opt.key ? COLORS.cream : COLORS.ink,
                          border: `1px solid ${COLORS.oak}`,
                          fontWeight: 700,
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {ballType === "house" ? (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={ballWeight}
                          onChange={(e) => setBallWeight(e.target.value)}
                          placeholder="重さ"
                          className="w-16 px-2 py-1 rounded border text-sm"
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                        />
                        <span className="text-xs" style={{ color: COLORS.oak }}>ポンド</span>
                      </div>

                      <label className="flex items-center gap-2 text-xs" style={{ color: COLORS.ink }}>
                        <input
                          type="checkbox"
                          checked={ballThumbless}
                          onChange={(e) => setBallThumbless(e.target.checked)}
                        />
                        サムレス
                      </label>
                    </>
                  ) : myBalls.filter((b) => (b.type || "own") === "own").length === 0 ? (
                    <div className="text-xs" style={{ color: COLORS.oak }}>
                      登録済みのマイボールがありません。「プロフィール」タブで登録してください
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
                        .filter((b) => (b.type || "own") === "own")
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.label}({b.weight}lb{b.thumbless ? "・サムレス" : ""})
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
            {[...games].reverse().map((g) => (
              <div key={g.id} className="rounded-xl p-3 border bg-white" style={{ borderColor: COLORS.oak }}>
                <div className="flex items-center justify-between mb-2">
                  <div style={{ color: COLORS.oak, fontSize: 12 }}>
                    {g.date}
                    <span className="ml-2" style={{ color: COLORS.ink, fontWeight: 700 }}>
                      {g.gameNumber ? `${g.gameNumber}ゲーム目` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 20, color: COLORS.strike }}>
                      {g.total}
                    </div>
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
                    <span className="text-xs" style={{ color: COLORS.strike, fontWeight: 700 }}>
                      本当に削除しますか?
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-xs rounded px-2 py-1 border"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteGame(g.id)}
                        className="text-xs rounded px-2 py-1"
                        style={{ background: COLORS.strike, color: "white", fontWeight: 700 }}
                      >
                        削除する
                      </button>
                    </div>
                  </div>
                )}
                {g.ball && (g.ball.weight || g.ball.type) && (
                  <div className="mb-2 flex items-center gap-1" style={{ color: COLORS.oak, fontSize: 11 }}>
                    <CircleDot size={11} />
                    {g.ball.label ? g.ball.label : g.ball.type === "own" ? "マイボール" : "ハウスボール"}
                    {g.ball.weight ? ` ${g.ball.weight}lb` : ""}
                    {g.ball.thumbless ? " ・ サムレス" : ""}
                  </div>
                )}
                <ScoreSheet frames={g.frames} />
              </div>
            ))}
            {storageError && <div className="text-xs text-center" style={{ color: COLORS.strike }}>{storageError}</div>}
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
                        background: periodMode === p.key ? COLORS.ink : "white",
                        color: periodMode === p.key ? COLORS.cream : COLORS.ink,
                        border: `1px solid ${COLORS.oak}`,
                        fontWeight: 700,
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="rounded-xl p-3 border bg-white" style={{ borderColor: COLORS.oak }}>
                  {periodMode === "day" && (
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setDayAnchor((d) => shiftDate(d, -1))}
                        className="w-8 h-8 rounded border flex items-center justify-center"
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
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
                        style={{ borderColor: COLORS.oak, color: COLORS.ink }}
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
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
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
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
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
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
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
                          style={{ borderColor: COLORS.oak, color: COLORS.ink }}
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
                      <div className="rounded-xl p-3 border bg-white text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.oak }}>ゲーム数</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.ink }}>{periodGames.length}</div>
                      </div>
                      <div className="rounded-xl p-3 border bg-white text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.oak }}>アベレージ</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.ink }}>{avg}</div>
                      </div>
                      <div className="rounded-xl p-3 border bg-white text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs flex items-center justify-center gap-1" style={{ color: COLORS.oak }}>
                          <Trophy size={12} /> ハイゲーム
                        </div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.strike }}>{highGame}</div>
                      </div>
                      <div className="rounded-xl p-3 border bg-white text-center" style={{ borderColor: COLORS.oak }}>
                        <div className="text-xs" style={{ color: COLORS.oak }}>ローゲーム</div>
                        <div style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.ink }}>{lowGame}</div>
                      </div>
                    </div>

                    {(goalAverage || goalScore) && (
                      <div className="rounded-xl p-3 border bg-white flex items-center gap-4" style={{ borderColor: COLORS.oak }}>
                        <Target size={16} style={{ color: COLORS.gold }} />
                        <div className="flex-1 text-xs" style={{ color: COLORS.ink }}>
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

                    <div className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: COLORS.oak }}>
                      {[
                        { label: "ストライク", count: strikeCount, rate: strikeRate },
                        { label: "スペア", count: spareCount, rate: spareRate },
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
                          <span className="text-sm" style={{ color: COLORS.ink }}>{row.label}</span>
                          <span className="flex items-baseline gap-2">
                            <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16, color: COLORS.ink }}>
                              {row.count}
                            </span>
                            <span style={{ color: COLORS.oak, fontSize: 11 }}>回</span>
                            <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 16, color: COLORS.strike, minWidth: 42, textAlign: "right" }}>
                              {row.rate}%
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>

                    <details className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: COLORS.oak }}>
                      <summary className="px-3 py-2 cursor-pointer text-sm" style={{ color: COLORS.oak }}>
                        その他(計算式について)
                      </summary>
                      <div className="px-3 pb-3 space-y-2" style={{ borderTop: `1px solid #EFE4CC`, paddingTop: 8 }}>
                        {[
                          {
                            label: "ストライク率",
                            formula: "ストライク数 ÷ 投球フレーム数(1投目)",
                            note: "「投球フレーム数」は普通1ゲームで10(10フレーム目のボーナス球は含みません)",
                          },
                          {
                            label: "スペア率",
                            formula: "スペア数 ÷ スペアチャンス数(1投目がストライクでなかったフレーム)",
                            note: "ストライクを取れなかったフレームのうち、何%を2投目で立て直せたか",
                          },
                          {
                            label: "スプリット率",
                            formula: "スプリット数 ÷ 投球フレーム数",
                            note: "10フレーム中、何回スプリット(ピンが離れて残る形)が出たか",
                          },
                          {
                            label: "スプリットカバー率",
                            formula: "スプリットカバー数 ÷ 1投目がスプリットになったフレーム数",
                            note: "スプリットになった中で、何%をスペアで返せたか",
                          },
                          {
                            label: "ガター率",
                            formula: "ガター数 ÷ 投球した全ボール数",
                            note: "全投球のうち、何%が溝に落ちたか",
                          },
                          {
                            label: "ファール率",
                            formula: "ファール数 ÷ 投球した全ボール数",
                            note: "全投球のうち、何%がファールライン超えだったか",
                          },
                        ].map((row) => (
                          <div key={row.label}>
                            <div className="text-xs" style={{ color: COLORS.ink, fontWeight: 700 }}>{row.label}</div>
                            <div className="text-xs" style={{ color: COLORS.oak }}>{row.formula}</div>
                            <div className="text-xs" style={{ color: COLORS.gold }}>{row.note}</div>
                          </div>
                        ))}
                      </div>
                    </details>

                    <div className="rounded-xl p-3 border bg-white" style={{ borderColor: COLORS.oak }}>
                      <div className="text-xs mb-2 flex items-center gap-1" style={{ color: COLORS.oak }}>
                        <TrendingUp size={14} />
                        {periodMode === "day" ? "本日のゲームごとのスコア" : "日ごとの平均スコア推移"}
                      </div>
                      <ResponsiveContainer width="100%" height={220}>
                        {chartIsBar ? (
                          <BarChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E5DCC8" />
                            <XAxis dataKey="label" tick={{ fontSize: 11, fill: COLORS.oak }} />
                            <YAxis tick={{ fontSize: 11, fill: COLORS.oak }} />
                            <Tooltip contentStyle={{ fontSize: 12, borderColor: COLORS.oak }} />
                            <Bar dataKey="total" fill={COLORS.strike} radius={[4, 4, 0, 0]} />
                          </BarChart>
                        ) : (
                          <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E5DCC8" />
                            <XAxis dataKey="label" tick={{ fontSize: 11, fill: COLORS.oak }} />
                            <YAxis tick={{ fontSize: 11, fill: COLORS.oak }} />
                            <Tooltip contentStyle={{ fontSize: 12, borderColor: COLORS.oak }} />
                            <Line type="monotone" dataKey="total" stroke={COLORS.strike} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.strike }} />
                          </LineChart>
                        )}
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
                              <div key={g.id} className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: COLORS.oak }}>
                                <div
                                  className="flex items-center justify-between px-3 py-2"
                                  style={{ background: COLORS.cream }}
                                >
                                  <span className="text-sm" style={{ color: COLORS.ink, fontWeight: 700 }}>
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
                                    <span style={{ color: COLORS.ink, fontSize: 12 }}>{row.label}</span>
                                    <span className="flex items-baseline gap-2">
                                      <span style={{ fontFamily: "'Oswald', sans-serif", fontWeight: 700, fontSize: 13, color: COLORS.ink }}>
                                        {row.count}
                                      </span>
                                      <span style={{ color: COLORS.oak, fontSize: 10 }}>回</span>
                                      <span
                                        style={{
                                          fontFamily: "'Oswald', sans-serif",
                                          fontWeight: 700,
                                          fontSize: 13,
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
              {profileSaved && <span style={{ color: COLORS.gold, fontSize: 11 }}>保存しました</span>}
            </div>

            <div className="rounded-xl p-3 border bg-white space-y-3" style={{ borderColor: COLORS.oak }}>
              <div>
                <div className="text-xs mb-1" style={{ color: COLORS.oak }}>ニックネーム</div>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  onBlur={(e) => saveProfile({ nickname: e.target.value })}
                  placeholder="例: ユウト"
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
                        background: dominantHand === opt.key ? COLORS.ink : "white",
                        color: dominantHand === opt.key ? COLORS.cream : COLORS.ink,
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
                  value={goalAverage}
                  onChange={(e) => setGoalAverage(e.target.value)}
                  onBlur={(e) => saveProfile({ goalAverage: e.target.value })}
                  placeholder="例: 150"
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
                  value={goalScore}
                  onChange={(e) => setGoalScore(e.target.value)}
                  onBlur={(e) => saveProfile({ goalScore: e.target.value })}
                  placeholder="例: 200"
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
                  placeholder="例: ラウンドワン◯◯店"
                  className="w-full px-3 py-2 rounded border text-sm"
                  style={{ borderColor: COLORS.oak, color: COLORS.ink }}
                />
              </div>
            </div>

            <div className="text-sm" style={{ color: COLORS.oak }}>登録済みのボール</div>

            <div className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: COLORS.oak }}>
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
                      <div className="text-sm" style={{ color: COLORS.ink, fontWeight: 700 }}>
                        {b.label}
                        <span style={{ color: COLORS.oak, fontWeight: 400, fontSize: 11 }}>
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

            <div className="rounded-xl p-3 border bg-white space-y-2" style={{ borderColor: COLORS.oak }}>
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
                <label className="flex items-center gap-1 text-xs" style={{ color: COLORS.ink }}>
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
          </div>
        )}

        {tab === "form" && (
          <div className="space-y-4">
            {!formVideoUrl && (
              <button
                onClick={() => videoInputRef.current?.click()}
                className="w-full flex flex-col items-center justify-center gap-3 rounded-xl py-14 border-2 border-dashed"
                style={{ borderColor: COLORS.oak, background: "white" }}
              >
                <Video size={40} style={{ color: COLORS.strike }} />
                <div style={{ color: COLORS.ink, fontWeight: 700 }}>投球フォームの動画を撮影 / アップロード</div>
                <div className="text-xs" style={{ color: COLORS.oak }}>スロー再生・一時停止で確認できます</div>
              </button>
            )}
            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => handleVideoFile(e.target.files?.[0])}
            />

            {formVideoUrl && (
              <>
                <div className="rounded-xl overflow-hidden border" style={{ borderColor: COLORS.oak, background: "black" }}>
                  <video
                    ref={videoRef}
                    src={formVideoUrl}
                    playsInline
                    controls
                    className="w-full"
                    style={{ maxHeight: 400 }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                </div>

                <div className="rounded-xl p-3 border bg-white space-y-3" style={{ borderColor: COLORS.oak }}>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={togglePlay}
                      className="flex-1 rounded-lg py-2 flex items-center justify-center gap-2"
                      style={{ background: COLORS.ink, color: COLORS.cream, fontWeight: 700 }}
                    >
                      {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                      {isPlaying ? "一時停止" : "再生"}
                    </button>
                    <button
                      type="button"
                      onClick={stopVideo}
                      className="flex-1 rounded-lg py-2 flex items-center justify-center gap-2"
                      style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.ink, fontWeight: 700 }}
                    >
                      <Square size={16} />
                      ストップ
                    </button>
                  </div>

                  <div>
                    <div className="text-xs mb-1" style={{ color: COLORS.oak }}>再生速度</div>
                    <div className="flex gap-1.5">
                      {[1, 0.75, 0.5, 0.25, 0.1].map((rate) => (
                        <button
                          key={rate}
                          type="button"
                          onClick={() => changeRate(rate)}
                          className="flex-1 rounded-lg py-2 text-xs"
                          style={{
                            background: playbackRate === rate ? COLORS.strike : "white",
                            color: playbackRate === rate ? "white" : COLORS.ink,
                            border: `1px solid ${COLORS.oak}`,
                            fontWeight: 700,
                          }}
                        >
                          {rate === 1 ? "通常" : `${rate}倍`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={clearVideo}
                  className="w-full rounded-lg py-2 text-sm"
                  style={{ border: `1px solid ${COLORS.oak}`, color: COLORS.oak }}
                >
                  別の動画に変える
                </button>
              </>
            )}
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
            { key: "scan", label: "スコア記録", icon: Camera },
            { key: "history", label: "履歴", icon: History },
            { key: "stats", label: "統計", icon: BarChart3 },
            { key: "form", label: "フォーム分析", icon: Video },
            { key: "profile", label: "プロフィール", icon: User },
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
                <span style={{ fontSize: 10 }}>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
