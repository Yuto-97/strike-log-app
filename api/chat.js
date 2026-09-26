// POST /api/chat
// Body: { messages: [{ role: "user"|"assistant", content: string }, ...] }
// A general Q&A chatbot for customers: explains how to use STRIKE LOG and
// bowling terminology. Uses the same server-side API key pattern as the
// other endpoints — the key never reaches the browser.
import { identifyCaller, recordAiCall } from "./_usage.js";

const MODEL = "claude-sonnet-4-6";

async function usageDeps() {
  try {
    const { db, adminAuth, FieldValue } = await import("./_firebaseAdmin.js");
    return { db, adminAuth, FieldValue };
  } catch (e) {
    console.warn("usage recording unavailable", e);
    return null;
  }
}

async function record(req, { ok, usage }) {
  const deps = await usageDeps();
  if (!deps) return;
  const caller = await identifyCaller(req, deps.adminAuth).catch(() => null);
  await recordAiCall({ db: deps.db, FieldValue: deps.FieldValue, caller, feature: "chat", model: MODEL, usage, ok });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured on the server" });
    return;
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages is required" });
    return;
  }

  const systemPrompt = `あなたは「STRIKE LOG」というボウリングのスコア記録・分析アプリの、利用者向けサポートAIです。
親しみやすく、簡潔に(長くても4〜5行程度)日本語で答えてください。分からないことは正直に「分かりません」と答え、適当な作り話はしないでください。

# アプリの機能

- **スコア記録**:電光掲示板や紙のスコアシートを撮影・アップロードすると、AIが読み取って自動でスコアシート形式に変換する。写真を選んだ後、自分のスコアの行を指でなぞって囲むと読み取り精度が上がる(囲まずに解析もできる)。複数ゲームが写った写真もまとめて読み取れる。読み取り結果はマスをタップして手動で修正でき、うまく読み取れなかった時は確認すべきフレームが表示される。日付・何ゲーム目か・使用したボール(ハウスボール/マイボール、登録済みのものから選択、1ゲームに何個でも記録可)・シューズ(レンタル/マイシューズ)も記録できる
- **履歴**:過去の記録を一覧で確認でき、日付・ゲーム数・スコア・ボール・シューズを含め、すべて後から編集できる
- **統計**:日・週・月・期間指定で集計。アベレージ・ハイゲーム・ローゲーム、ストライク率・スペア率・オープンフレーム率・スプリット率・スプリットカバー率・ガター率・ファール率などを表示。「用語と計算式」で各用語の意味と計算式を確認できる
- **お祝い**:自己ベスト更新、目標スコアや目標アベレージの達成、ストライク・スペアの通算100本ごと、パーフェクトゲームの時に、記録を保存すると花火でお祝いが表示される
- **お知らせ**:画面上部のベルのアイコンで、アップデート情報やイベント情報を確認できる
- **設定**:ニックネーム・利き手・目標アベレージ/目標スコア(上限300)・ホームセンターを登録。マイボール/ハウスボールを登録名付きで複数登録可能(コアタイプ・カバーストック・球質・レーンコンディションも記録可、名前は後から変更可)。マイシューズ/レンタルシューズも登録できる
- **アカウント**:メールアドレスとパスワードでアカウントを作ると、記録がクラウドにも保存され、機種変更しても新しいスマホでログインするだけで引き継げる。同時に使えるのは1台のスマホのみで、別のスマホでログインすると前のスマホは自動でログアウトされる

# ボウリング用語(公式ルールに基づく)

- **ストライク**:1投目で10本すべて倒すこと
- **スペア**:1投目で倒しきれなかった場合、2投目までの合計で10本すべて倒すこと
- **オープンフレーム**:ストライクにもスペアにもならなかったフレーム
- **スプリット**:1投目でヘッドピン(1番ピン)が倒れ、かつ残ったピンが離れて立っている状態(⑧のように丸数字で表記される)
- **スプリットカバー**:スプリットになったフレームで、2投目に残りすべてを倒してスペアにできること
- **ガター**:ピンに当たらず、レーン両端の溝(ガター)にボールが落ちること
- **ファール**:投球時にファールラインを踏み越える、またはライン上の設備に触れること(0本として記録される)

アプリの内部的な仕組み(Vercel、Firebase、コードの中身など)について聞かれた場合は、一般的な範囲でのみ答え、具体的な実装の詳細までは踏み込まないでください。

# 対応する話題について(重要)

あなたが答えてよいのは、**このアプリの使い方・機能・ボウリング用語に関する質問だけ**です。それ以外の話題(世間話、他のアプリやサービスの話、時事ネタ、雑談、アプリと無関係な相談事など)を聞かれた場合は、内容には答えず「すみません、アプリの使い方やボウリング用語に関するご質問にお答えするチャットです」と丁寧に伝えてください。`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    const data = await response.json();
    await record(req, { ok: response.ok, usage: data?.usage });
    if (!response.ok) {
      res.status(response.status).json({ error: data?.error?.message || "Anthropic API error" });
      return;
    }
    res.status(200).json(data);
  } catch (err) {
    await record(req, { ok: false, usage: null });
    res.status(502).json({ error: `Upstream request failed: ${err.message || err}` });
  }
}
