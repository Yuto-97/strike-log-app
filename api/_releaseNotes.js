// アップデートのお知らせ(ベルに表示)。
//
// アプリの更新内容はここに書いて git push するだけでベルに反映される。
// (イベント広告など画像付きのお知らせは、これまでどおり管理画面から投稿)
// 先頭が「_」のファイルなので、Vercelのサーバー機能数には数えられない。
//
// 1件の書き方:
//   id        … 一意の英数字(「rn-」で始める。既読管理に使うので後から変えない)
//   date      … お知らせの日付(YYYY-MM-DD、日本時間)。この日からベルに表示される
//   title     … 60文字まで
//   body      … 1000文字まで。「## 見出し」「- 箇条書き」が使える(空行で区切る)
//   endDate   … 省略可。この日を過ぎるとベルから消える
export const RELEASE_NOTES = [
  {
    id: "rn-2026-10-02-ranking",
    date: "2026-10-02",
    title: "月間ランキングが始まりました",
    body: [
      "毎月のアベレージとハイゲームを、ほかの利用者と競えるようになりました。",
      "",
      "## 見かた",
      "- 画面下の「ランキング」タブを開く",
      "- 年代・性別・ボールで絞り込める",
      "- 先月の結果も見られる",
      "",
      "## 参加するには(自由参加)",
      "- アカウントを作成",
      "- 設定で「月間ランキングに参加する」をオン",
      "- ランキング表示名を入力",
      "",
      "## ご注意",
      "- アベレージは月3ゲーム以上で順位がつく",
      "- 写真から読み取った点数で集計",
      "- ほかの人に見えるのは表示名と成績だけ",
    ].join("\n"),
  },
];

// ベル用の形(Firestoreのお知らせと同じ形)に変換し、表示期間内のものだけ返す。
export function activeReleaseNotes(today) {
  return RELEASE_NOTES.filter((n) => n.date <= today && (!n.endDate || n.endDate >= today)).map((n) => ({
    id: n.id,
    type: "update",
    title: n.title,
    body: n.body,
    startDate: n.date,
    endDate: n.endDate || null,
    hasImage: false,
    imageVersion: null,
    // Sorts among the admin-posted ones by date; 09:00 JST so it lands on the right day.
    createdAt: `${n.date}T00:00:00.000Z`,
    updatedAt: `${n.date}T00:00:00.000Z`,
  }));
}
