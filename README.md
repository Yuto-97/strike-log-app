# STRIKE LOG トライアル(スタンドアロン版)

Claude.aiのアーティファクトから独立させた、ボウリングスコア記録アプリです。
スマホのブラウザ(Safari/Chrome)で直接動くように作られています。

## 何が変わったか(Claudeアーティファクト版との違い)

| 項目 | アーティファクト版 | このスタンドアロン版 |
|---|---|---|
| スコア画像のAI解析 | Claude.aiが中継 | 自分のAPIキーで、自前の中継サーバー(`/api/analyze`)を経由 |
| データ保存 | `window.storage`(Pro以上・PC限定) | ブラウザの`localStorage`(誰でも・スマホ含め動作) |
| 利用に必要なもの | Claudeアカウント(Pro以上) | 何もいらない(リンクを開くだけ) |

---

## 1. 事前に準備するもの

- **Node.js**(v18以上): https://nodejs.org からインストール
- **AnthropicのAiアカウント & APIキー**: https://console.anthropic.com/settings/keys で発行(要クレジットカード登録。使った分だけ課金されます)
- **GitHubアカウント**(Vercelにデプロイするため)
- **Vercelアカウント**(無料): https://vercel.com

## 2. ローカルで動作確認する

```bash
cd strike-log-app
npm install
cp .env.example .env.local
# .env.local を開いて ANTHROPIC_API_KEY= の後に自分のAPIキーを貼り付ける

npm run dev
```

ブラウザで `http://localhost:5173` を開いて動作確認できます。
(ローカル環境では `/api/analyze` は動きません。ローカルでAPI部分も試したい場合は `vercel dev` を使ってください — 下記参照)

```bash
npm install -g vercel
vercel dev
```

## 3. GitHubにアップロードする

```bash
cd strike-log-app
git init
git add .
git commit -m "first commit"
```

GitHubで新しいリポジトリを作成し、案内される`git remote add`〜`git push`のコマンドを実行してください。

## 4. Vercelにデプロイする

1. https://vercel.com にログイン
2. 「Add New...」→「Project」
3. 先ほど作ったGitHubリポジトリを選んで「Import」
4. **Environment Variables**の欄に以下を追加:
   - Key: `ANTHROPIC_API_KEY`
   - Value: 自分のAPIキー
5. 「Deploy」をクリック

数十秒でデプロイが完了し、`https://あなたのプロジェクト名.vercel.app` のようなURLが発行されます。

## 5. スマホで使う

1. 発行されたURLを、iPhoneならSafari、AndroidならChromeで開く
2. 動作確認(スコア画像をアップロード→解析)
3. 問題なければ、共有ボタン→「ホーム画面に追加」でアイコン化

## 6. 友人にも使ってもらう

発行されたURLをそのまま共有すれば、誰でも(Claudeアカウント不要で)使えます。
ただし**データ保存は`localStorage`なので、各人のスマホ/ブラウザごとに別々に記録されます**(あなたの記録と友人の記録が混ざることはありません)。

## 今後の拡張案

- **複数端末でデータを同期したい場合**: `localStorage`をFirebase Firestoreなどに置き換える
- **ログイン機能を追加したい場合**: Firebase AuthやClerkなどを組み合わせる
- **オフライン対応を強化したい場合**: Service Workerを追加してPWA化をさらに進める

## 費用の目安

- Vercel: 個人利用なら無料枠で十分
- Anthropic API: 画像1枚の解析で数円程度。友人数人が時々使う程度なら月100〜300円程度の見込み(利用量次第で変動します)

## トラブルシューティング

- **「ANTHROPIC_API_KEY is not configured」と出る**: Vercelの環境変数設定を確認し、再デプロイしてください
- **画像解析が失敗する**: `api/analyze.js`が受け取ったエラー内容がブラウザ側に表示されるので、そのメッセージを確認してください
