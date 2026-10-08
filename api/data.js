// /api/data — cloud copy of an account holder's records, so they follow the
// person to a new phone.
//
//   GET  → { games: [...], kv: { "my-balls": "...", ... } }
//   POST { upserts: [game], deletes: [gameId], kv: { key: value|null } }
//
// Headers: Authorization: Bearer <Firebase ID token>, X-Device-Id: <device>
//
// Access rules, checked on every request:
//   - the caller is identified only from the verified ID token
//   - the account must be approved by the admin
//   - the request must come from the account's current active device —
//     otherwise 409, and the app signs that device out (one account, one
//     device at a time)
//
// Storage layout: userData/{uid} holds the small settings (balls, shoes,
// profile...) and userData/{uid}/games/{gameId} holds one document per game.
// One doc per game keeps us far from Firestore's 1MB-per-document limit no
// matter how many games someone records, and lets each save write only what
// changed. Each game is stored as a JSON string, which sidesteps Firestore's
// restrictions on nested arrays and undefined values.
import { db, adminAuth, FieldValue } from "./_firebaseAdmin.js";
import { verifyCaller } from "./_accountAuth.js";

export const SYNCED_KV_KEYS = ["my-balls", "my-shoes", "profile", "player-name", "ball-config", "shoe-config"];
const MAX_GAMES_PER_REQUEST = 300;
const MAX_GAME_BYTES = 30000;
const MAX_KV_BYTES = 200000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_LIMIT = 400; // Firestore allows 500 writes per batch

// ---------- 月間ランキング ----------
// Only the final score read from the photo (photoTotal) counts — editing the
// frames by hand can't change it. Games without a photo-read score, and
// repeat uploads of the same photo (same photoKey), are left out.
export const RANKING_MIN_GAMES_FOR_AVERAGE = 3;
export const RANKING_TOP = 30;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function rankingSummary(gamesList) {
  const seen = new Set();
  const scores = [];
  for (const g of [...gamesList].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.createdAt || 0) - (b.createdAt || 0))) {
    // Must be an actual number: an empty value would otherwise turn into 0.
    if (!g || typeof g.photoTotal !== "number") continue;
    const s = g.photoTotal;
    if (!Number.isFinite(s) || s < 0 || s > 300) continue;
    if (g.photoKey) {
      if (seen.has(g.photoKey)) continue;
      seen.add(g.photoKey);
    }
    scores.push(s);
  }
  if (!scores.length) return null;
  return {
    games: scores.length,
    avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
    high: Math.max(...scores),
  };
}

// The month's summary for all games, plus separately for games whose 1st
// ball was a ハウスボール or a マイボール (for the ball filter).
export function rankingSummaryByBall(gamesList) {
  const all = rankingSummary(gamesList);
  if (!all) return null;
  const typeOf = (g) => (g && g.ball && g.ball.type === "house" ? "house" : g && g.ball && g.ball.type === "own" ? "own" : null);
  return {
    ...all,
    byBall: {
      house: rankingSummary(gamesList.filter((g) => typeOf(g) === "house")),
      own: rankingSummary(gamesList.filter((g) => typeOf(g) === "own")),
    },
  };
}

export const RANKING_AGE_GROUPS = ["10s", "20s", "30s", "40s", "50s", "60s", "70s+"];
export const RANKING_GENDERS = ["male", "female"];
const cleanAge = (v) => (RANKING_AGE_GROUPS.includes(v) ? v : null);
const cleanGender = (v) => (RANKING_GENDERS.includes(v) ? v : null);

// Competition ranking (1, 2, 2, 4…). Returns the top N plus the caller's own
// row if they're further down. Rows never include anyone's id.
export function buildRanking(rows, valueOf, myUid) {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a) || (b.games || 0) - (a.games || 0));
  let lastValue = null;
  let lastRank = 0;
  const ranked = sorted.map((r, i) => {
    const v = valueOf(r);
    const rank = v === lastValue ? lastRank : i + 1;
    lastValue = v;
    lastRank = rank;
    return { rank, nickname: r.nickname, value: v, games: r.games, isMe: r.uid === myUid };
  });
  const top = ranked.slice(0, RANKING_TOP);
  const me = ranked.find((r) => r.isMe);
  return { top, me: me && !top.includes(me) ? me : null, total: ranked.length };
}


// ---------- SERIES BATTLE(3ゲーム合計で競うイベント) ----------
// 対象の3名が参加ボタンを押し、3人で決めた日の3ゲームを履歴から選んで提出する。
// 「回」= 提出の日付。1人1回につき1件(同じ日に出し直すと入れ替わる)。
//   回ごとの順位: 3ゲーム合計が高い順。同点ならハイとローの差が小さい方が上
//   通算の順位:   参加した回の3ゲーム合計の平均が高い順。同点なら差の平均が小さい方が上
// 参加者は duelParticipants/{eventId}/people/{uid}、提出は duelEntries/{eventId}/entries/{id}。
// 参加者だけが読み書きできる。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayJst(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 良い順に並べるための比較(負なら a が上位)
export function duelOrder(a, b) {
  return (
    b.total - a.total ||
    a.spread - b.spread ||
    String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
}

// 1人1回につき1件にそろえる(同じ日に複数あれば、後から出した方を使う)
export function latestPerRound(entries) {
  const m = new Map();
  for (const e of entries) {
    const k = `${e.uid}|${e.date}`;
    const cur = m.get(k);
    if (!cur || String(e.createdAt || "") > String(cur.createdAt || "")) m.set(k, e);
  }
  return [...m.values()];
}

// 同じ値なら同じ順位(1,1,3…)。未提出は最後に rank: null
function assignRanks(rows, has, cmp, same) {
  const scored = rows.filter(has).sort(cmp);
  let rank = 0;
  let last = null;
  scored.forEach((r, i) => {
    if (!last || !same(r, last)) rank = i + 1;
    last = r;
    r.rank = rank;
  });
  return [...scored, ...rows.filter((r) => !has(r)).map((r) => ({ ...r, rank: null }))];
}

// その回の順位。participants: [{ uid, name }], entries: その日の提出(1人1件)
export function buildRoundBoard(participants, entries) {
  const byUid = new Map(entries.map((e) => [e.uid, e]));
  const rows = participants.map((p) => ({ uid: p.uid, name: p.name, entry: byUid.get(p.uid) || null }));
  return assignRanks(
    rows,
    (r) => !!r.entry,
    (a, b) => duelOrder(a.entry, b.entry),
    (a, b) => a.entry.total === b.entry.total && a.entry.spread === b.entry.spread
  );
}

// 率の分母(フレーム数・スペアのチャンス数・投球数)は、この仕組みを入れる前の提出には
// 保存されていないので、その場合は3ゲーム分の数字から見積もる。
export function withDenominators(e) {
  const frames = Number(e.frames) || 30;
  const spareChances = Number(e.spareChances) || Math.max(Number(e.spares) || 0, frames - (Number(e.strikes) || 0));
  const balls = Number(e.balls) || frames + spareChances;
  return { ...e, frames, spareChances, balls };
}

// 成績の項目は合算(率は合計どうしで割る)
const STAT_KEYS = ["strikes", "spares", "opens", "splits", "splitCovers", "splitChances", "gutters", "frames", "spareChances", "balls"];
export function sumEntries(rawList) {
  const list = rawList.map(withDenominators);
  const out = { rounds: list.length, games: list.length * 3 };
  for (const k of STAT_KEYS) out[k] = list.reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const totals = list.map((e) => e.total);
  out.avgTotal = list.length ? Math.round((totals.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : 0;
  out.avgSpread = list.length ? list.reduce((a, e) => a + e.spread, 0) / list.length : 0;
  out.bestTotal = list.length ? Math.max(...totals) : 0;
  out.avg = list.length ? Math.round((totals.reduce((a, b) => a + b, 0) / (list.length * 3)) * 10) / 10 : 0;
  return out;
}

// 通算の順位(参加した回の平均)
export function buildOverallBoard(participants, entries) {
  const rows = participants.map((p) => {
    const mine = entries.filter((e) => e.uid === p.uid);
    return { uid: p.uid, name: p.name, sum: mine.length ? sumEntries(mine) : null };
  });
  return assignRanks(
    rows,
    (r) => !!r.sum,
    (a, b) => b.sum.avgTotal - a.sum.avgTotal || a.sum.avgSpread - b.sum.avgSpread,
    (a, b) => a.sum.avgTotal === b.sum.avgTotal && a.sum.avgSpread === b.sum.avgSpread
  );
}

const cleanCount = (v, max = 400) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : 0;
};

// 開催情報(今回は固定)。期間を変えるときはここを直す。
const DUEL = { id: "duel-2026-11", name: "SERIES BATTLE", title: "11/22社内大会 前哨戦", startDate: "2026-10-03", endDate: "2026-11-21" };

const duelPeople = (db) => db.collection("duelParticipants").doc(DUEL.id).collection("people");

// 参加できるのは下村優斗・たく・堀川弘人の3名だけ(承認などの操作は不要)。
// 名前は自由に変えられるので、変わらない登録番号(管理画面の「No.」)で判定する。
// 登録番号は、承認済みの端末でアカウントを作るとそのまま引き継がれる。
const DUEL_MEMBER_NUMBERS = [
  "1488689", // 下村優斗
  "1524796", // たく
  "3495316", // 堀川弘人
];
export function isDuelMember(account) {
  return DUEL_MEMBER_NUMBERS.includes(String((account && account.requestNumber) || ""));
}

// 対象の人が参加ボタンを押すと「参加者」になる。参加者でなければ null。
async function loadDuelMember(db, caller, account) {
  if (!isDuelMember(account)) return null;
  const d = await duelPeople(db).doc(caller.uid).get();
  return d.exists ? d.data() : null;
}

async function duelView(db, caller, member, account) {
  const today = todayJst();
  const base = { name: DUEL.name, title: DUEL.title, startDate: DUEL.startDate, endDate: DUEL.endDate, today };
  if (!member) return { participant: false, canJoin: isDuelMember(account), ...base };
  const [peopleSnap, entriesSnap] = await Promise.all([
    duelPeople(db).get(),
    db.collection("duelEntries").doc(DUEL.id).collection("entries").get(),
  ]);
  const people = peopleSnap.docs.map((d, i) => ({ uid: d.id, name: String(d.data().name || "") || `参加者${i + 1}`, joinedAt: d.data().joinedAt || "" }));
  const entries = latestPerRound(entriesSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
  const overall = buildOverallBoard(people, entries).map((r) => ({ name: r.name, rank: r.rank, isMe: r.uid === caller.uid, sum: r.sum }));
  const dates = [...new Set(entries.map((e) => e.date))].sort().reverse(); // 新しい回が先
  const rounds = dates.map((date) => ({
    date,
    board: buildRoundBoard(
      people,
      entries.filter((e) => e.date === date)
    ).map((r) => ({ name: r.name, rank: r.rank, isMe: r.uid === caller.uid, entry: r.entry ? publicEntry(r.entry) : null })),
  }));
  const mine = entries
    .filter((e) => e.uid === caller.uid)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((e) => ({ ...publicEntry(e), id: e.id, gameIds: e.gameIds || [] }));
  return { participant: true, ...base, overall, rounds, mine };
}

function publicEntry(e) {
  return {
    date: e.date,
    scores: e.scores,
    total: e.total,
    avg: e.avg,
    spread: e.spread,
    strikes: e.strikes,
    spares: e.spares,
    opens: e.opens,
    splits: e.splits,
    splitCovers: e.splitCovers,
    splitChances: e.splitChances,
    gutters: e.gutters,
    frames: withDenominators(e).frames,
    spareChances: withDenominators(e).spareChances,
    balls: withDenominators(e).balls,
    createdAt: e.createdAt,
  };
}

export function createHandler({ db, adminAuth, FieldValue }) {
  return async function handler(req, res) {
    const caller = await verifyCaller(req, adminAuth);
    if (!caller) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const deviceId = req.headers["x-device-id"];

    let account;
    try {
      const acc = await db.collection("accessRequests").doc(caller.uid).get();
      account = acc.exists ? acc.data() : null;
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
      return;
    }
    if (!account || account.status !== "approved") {
      res.status(403).json({ error: "not_approved" });
      return;
    }
    if (!deviceId || account.activeDeviceId !== deviceId) {
      res.status(409).json({ error: "inactive_device" });
      return;
    }

    const userRef = db.collection("userData").doc(caller.uid);

    // 3ゲーム対決: 参加者の順位表と自分の提出一覧(参加していない人には開催情報だけ)
    if (req.method === "GET" && req.query && req.query.duel) {
      try {
        const member = await loadDuelMember(db, caller, account);
        res.status(200).json(await duelView(db, caller, member, account));
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
      }
      return;
    }

    if (req.method === "GET" && req.query && req.query.ranking) {
      const month = String(req.query.ranking);
      if (!MONTH_RE.test(month)) {
        res.status(400).json({ error: "invalid month" });
        return;
      }
      try {
        const [entriesSnap, partsSnap] = await Promise.all([
          db.collection("rankingMonths").doc(month).collection("entries").get(),
          db.collection("rankingParticipants").get(),
        ]);
        // Filters: 年代 / 性別 / ボール (ハウス・マイ). People who didn't set an
        // age group or gender only appear when that filter is 「すべて」.
        const age = cleanAge(String(req.query.age || ""));
        const gender = cleanGender(String(req.query.gender || ""));
        const ball = ["house", "own"].includes(String(req.query.ball || "")) ? String(req.query.ball) : null;
        const pick = (e) => (ball ? (e.byBall && e.byBall[ball]) || null : e);

        const parts = new Map(partsSnap.docs.map((d) => [d.id, d.data()]));
        const entries = entriesSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        const visible = entries
          .filter((e) => {
            const p = parts.get(e.uid);
            if (!p || !p.optIn || p.excluded || !p.nickname) return false;
            if (age && p.ageGroup !== age) return false;
            if (gender && p.gender !== gender) return false;
            return !!pick(e);
          })
          .map((e) => ({ ...pick(e), uid: e.uid, nickname: parts.get(e.uid).nickname }));
        const mineRaw = entries.find((e) => e.uid === caller.uid) || null;
        const mine = mineRaw ? pick(mineRaw) : null;
        const myPart = parts.get(caller.uid) || {};
        res.status(200).json({
          month,
          filters: { age, gender, ball },
          minGames: RANKING_MIN_GAMES_FOR_AVERAGE,
          average: buildRanking(visible.filter((e) => e.games >= RANKING_MIN_GAMES_FOR_AVERAGE), (e) => e.avg, caller.uid),
          high: buildRanking(visible, (e) => e.high, caller.uid),
          me: {
            optIn: !!myPart.optIn,
            excluded: !!myPart.excluded,
            games: mine ? mine.games : 0,
            avg: mine ? mine.avg : null,
            high: mine ? mine.high : null,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
      }
      return;
    }

    if (req.method === "GET") {
      try {
        const [doc, snap] = await Promise.all([userRef.get(), userRef.collection("games").get()]);
        const games = [];
        for (const d of snap.docs) {
          try {
            games.push(JSON.parse(d.data().json));
          } catch (e) {
            // skip a corrupted record rather than failing the whole load
          }
        }
        const kv = doc.exists ? doc.data().kv || {} : {};
        res.status(200).json({ games, kv });
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
      }
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "GET or POST only" });
      return;
    }

    // 3ゲーム対決: 参加 / 提出 / 取り消し
    if (req.method === "POST" && ["duelJoin", "duelSubmit", "duelDelete"].includes((req.body || {}).action)) {
      try {
        const body = req.body;
        const today = todayJst();
        if (today > DUEL.endDate) {
          res.status(400).json({ error: "ended" });
          return;
        }

        if (body.action === "duelJoin") {
          if (!isDuelMember(account)) {
            res.status(403).json({ error: "not_allowed" });
            return;
          }
          const typed = String(body.name || "").trim().slice(0, 20);
          const reg = String(account.name || "");
          const name = typed || (reg && !reg.includes("@") ? reg.slice(0, 20) : "");
          await duelPeople(db).doc(caller.uid).set({ name, joinedAt: new Date().toISOString() }, { merge: true });
          res.status(200).json({ ok: true });
          return;
        }

        const member = await loadDuelMember(db, caller, account);
        if (!member) {
          res.status(403).json({ error: "not_participant" });
          return;
        }
        const duel = DUEL;
        const entries = db.collection("duelEntries").doc(duel.id).collection("entries");
        if (today < duel.startDate && body.action === "duelSubmit") {
          res.status(400).json({ error: "not_started" });
          return;
        }

        if (body.action === "duelDelete") {
          const id = String(body.id || "");
          if (!ID_PATTERN.test(id)) {
            res.status(400).json({ error: "invalid_id" });
            return;
          }
          const d = await entries.doc(id).get();
          if (!d.exists || d.data().uid !== caller.uid) {
            res.status(404).json({ error: "not_found" });
            return;
          }
          await entries.doc(id).delete();
          res.status(200).json({ ok: true });
          return;
        }

        // 提出: 選んだ3ゲーム(どの3ゲームにするかは参加者どうしで決める)。点数はクラウドに保存済みの記録から読む(手修正後の点数)
        const ids = Array.isArray(body.gameIds) ? body.gameIds.map(String) : [];
        if (ids.length !== 3 || new Set(ids).size !== 3 || !ids.every((x) => ID_PATTERN.test(x))) {
          res.status(400).json({ error: "need_three_games" });
          return;
        }
        const docs = await Promise.all(ids.map((id) => userRef.collection("games").doc(id).get()));
        if (docs.some((d) => !d.exists)) {
          res.status(409).json({ error: "not_synced" });
          return;
        }
        const games = docs.map((d) => {
          try {
            return JSON.parse(d.data().json);
          } catch (e) {
            return null;
          }
        });
        if (games.some((g) => !g || !Number.isFinite(g.total) || g.total < 0 || g.total > 300 || !DATE_RE.test(String(g.date)))) {
          res.status(400).json({ error: "bad_game" });
          return;
        }
        // 日付は3ゲームのうち最後の日(別々の日のゲームでもよい)
        const date = games.map((g) => g.date).sort().pop();
        if (games.some((g) => (duel.startDate && g.date < duel.startDate) || (duel.endDate && g.date > duel.endDate))) {
          res.status(400).json({ error: "out_of_period" });
          return;
        }
        const key = [...ids].sort().join("|");
        const ordered = [...games].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (Number(a.gameNumber) || 0) - (Number(b.gameNumber) || 0));
        const scores = ordered.map((g) => g.total);
        const total = scores.reduce((a, b) => a + b, 0);
        const st = body.stats && typeof body.stats === "object" ? body.stats : {};
        const entry = {
          uid: caller.uid,
          key,
          date,
          gameIds: ids,
          scores,
          total,
          avg: Math.round((total / 3) * 10) / 10,
          spread: Math.max(...scores) - Math.min(...scores),
          strikes: cleanCount(st.strikes),
          spares: cleanCount(st.spares),
          opens: cleanCount(st.opens),
          splits: cleanCount(st.splits),
          splitCovers: cleanCount(st.splitCovers),
          splitChances: cleanCount(st.splitChances),
          gutters: cleanCount(st.gutters),
          frames: cleanCount(st.frames) || 30,
          spareChances: cleanCount(st.spareChances),
          balls: cleanCount(st.balls),
          createdAt: new Date().toISOString(),
        };
        // 同じ回(同じ日)に出し直したら、前の提出と入れ替える
        const sameDay = await entries.where("uid", "==", caller.uid).where("date", "==", date).get();
        const ref = await entries.add(entry);
        await Promise.all(sameDay.docs.map((d) => d.ref.delete()));
        res.status(200).json({ ok: true, id: ref.id, total });
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
      }
      return;
    }

    const body = req.body || {};
    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];
    const kvIn = body.kv && typeof body.kv === "object" ? body.kv : {};

    if (upserts.length + deletes.length > MAX_GAMES_PER_REQUEST) {
      res.status(413).json({ error: "too_many_games" });
      return;
    }

    const ops = [];
    const months = new Set(); // months whose ranking summary must be recalculated
    for (const g of upserts) {
      if (!g || typeof g.id !== "string" || !ID_PATTERN.test(g.id)) {
        res.status(400).json({ error: "invalid_game_id" });
        return;
      }
      const json = JSON.stringify(g);
      if (json.length > MAX_GAME_BYTES) {
        res.status(413).json({ error: "game_too_large" });
        return;
      }
      if (typeof g.date === "string" && /^\d{4}-\d{2}/.test(g.date)) months.add(g.date.slice(0, 7));
      ops.push((batch) =>
        batch.set(userRef.collection("games").doc(g.id), {
          json,
          date: typeof g.date === "string" ? g.date : null, // lets a month's games be looked up
          updatedAt: new Date().toISOString(),
        })
      );
    }
    for (const id of deletes) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) {
        res.status(400).json({ error: "invalid_game_id" });
        return;
      }
      ops.push((batch) => batch.delete(userRef.collection("games").doc(id)));
    }
    // a deleted game's month also needs recalculating
    for (const id of deletes) {
      try {
        const d = await userRef.collection("games").doc(id).get();
        if (d.exists) {
          const date = d.data().date || (JSON.parse(d.data().json || "{}").date ?? null);
          if (typeof date === "string") months.add(date.slice(0, 7));
        }
      } catch (e) {
        // unreadable record: nothing to recalculate
      }
    }

    const kvUpdate = {};
    for (const [key, value] of Object.entries(kvIn)) {
      if (!SYNCED_KV_KEYS.includes(key)) continue;
      if (value === null) {
        kvUpdate[key] = FieldValue.delete();
      } else if (typeof value === "string" && value.length <= MAX_KV_BYTES) {
        kvUpdate[key] = value;
      }
    }
    if (typeof kvIn.profile === "string") {
      try {
        const prof = JSON.parse(kvIn.profile);
        // ランキング表示名 is separate from the app nickname.
        const nickname = String(prof.rankingName || "").trim().slice(0, 20);
        ops.push((batch) =>
          batch.set(
            db.collection("rankingParticipants").doc(caller.uid),
            {
              nickname,
              optIn: !!prof.rankingOptIn,
              ageGroup: cleanAge(prof.ageGroup),
              gender: cleanGender(prof.gender),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          )
        );
        // Joining (or changing settings) also refreshes this month's and last
        // month's totals, so ones saved before this version get the ball split.
        const now = new Date(Date.now() + 9 * 3600 * 1000); // Japan time
        const thisM = now.toISOString().slice(0, 7);
        const lastM = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
        months.add(thisM);
        months.add(lastM);
      } catch (e) {
        // malformed profile: ignore for ranking purposes
      }
    }
    if (Object.keys(kvUpdate).length) {
      ops.push((batch) => batch.set(userRef, { kv: kvUpdate, updatedAt: new Date().toISOString() }, { merge: true }));
    }

    try {
      for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
        const batch = db.batch();
        ops.slice(i, i + BATCH_LIMIT).forEach((op) => op(batch));
        await batch.commit();
      }
      for (const m of months) {
        if (!MONTH_RE.test(m)) continue;
        const snap = await userRef.collection("games").where("date", ">=", `${m}-01`).where("date", "<=", `${m}-31`).get();
        const list = [];
        for (const d of snap.docs) {
          try {
            list.push(JSON.parse(d.data().json));
          } catch (e) {
            // skip corrupted
          }
        }
        const sum = rankingSummaryByBall(list);
        const ref = db.collection("rankingMonths").doc(m).collection("entries").doc(caller.uid);
        if (sum) await ref.set({ ...sum, updatedAt: new Date().toISOString() });
        else await ref.delete();
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  };
}

export default createHandler({ db, adminAuth, FieldValue });
