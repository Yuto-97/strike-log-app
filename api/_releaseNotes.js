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
//   body      … 1000文字まで(改行可)
//   endDate   … 省略可。この日を過ぎるとベルから消える
export const RELEASE_NOTES = [
  {
    id: "rn-2026-10-02-ranking",
    date: "2026-10-02",
    title: "月間ランキング機能を追加しました",
    body: [
      "利用者みんなで成績を競える「月間ランキング」を追加しました。画面下の「ランキング」タブから見られます。",
      "",
      "・アベレージ/ハイゲームの2種類で、毎月の順位を表示します(アベレージは月3ゲーム以上が対象)",
      "・年代・性別・ボール(ハウス/マイボール)で絞り込めます",
      "・先月の結果も確認できます",
      "",
      "【参加方法】",
      "参加は任意です。アカウントを作成したうえで、設定の「月間ランキングに参加する」をオンにし、ランキング表示名を入力してください。ランキングには表示名と成績のみが表示され、メールアドレス・ID・写真が他の人に見られることはありません。参加は設定からいつでも取りやめられます。",
      "",
      "※ランキングの成績は、スコア表の写真から読み取った最終スコアで集計します。",
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
