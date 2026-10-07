// 文字の大きさ(標準 / 大きめ / 特大)。
// 画面全体をまとめて拡大する(スマホの「画面表示の拡大」と同じ考え方)ので、
// 文字・ボタン・数字・アイコンがそろって大きくなり、レイアウトも崩れない。
// 端末ごとの設定として localStorage に保存する。
export const TEXT_SIZE_KEY = "text-size";

export const TEXT_SIZES = [
  { key: "normal", label: "標準", zoom: 1 },
  { key: "large", label: "大きめ", zoom: 1.15 },
  { key: "xlarge", label: "特大", zoom: 1.3 },
];

export function readTextSize() {
  try {
    const v = localStorage.getItem(TEXT_SIZE_KEY);
    return TEXT_SIZES.some((s) => s.key === v) ? v : null; // null = まだ選んでいない
  } catch (e) {
    return null;
  }
}

export function applyTextSize(key) {
  const size = TEXT_SIZES.find((s) => s.key === key) || TEXT_SIZES[0];
  const root = document.getElementById("root");
  if (root) root.style.zoom = size.zoom === 1 ? "" : String(size.zoom);
  // 画面の高さ(vh)を使っている所は、拡大した分だけ割り戻す(index.css)
  document.documentElement.style.setProperty("--app-zoom", String(size.zoom));
  // 大きめ以上では、薄くしている補足の文字を濃くして読みやすくする
  document.documentElement.classList.toggle("large-text", size.zoom > 1);
}

export function saveTextSize(key) {
  try {
    localStorage.setItem(TEXT_SIZE_KEY, key);
  } catch (e) {
    // 保存できなくても、表示の切り替えはできる
  }
  applyTextSize(key);
}
