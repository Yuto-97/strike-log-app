// 文字の大きさ(標準 / 大きめ / 特大)。
// 画面全体をまとめて拡大する(スマホの「画面表示の拡大」と同じ考え方)ので、
// 文字・ボタン・数字・アイコンがそろって大きくなり、レイアウトも崩れない。
// 端末ごとの設定として localStorage に保存する。
//
// 拡大のしかた:
//   スマホ・タブレット … 画面の設定(meta viewport)で、ページ全体を拡大して表示する。
//                        iPhone の Safari は CSS の zoom だと枠だけ大きくなり文字が
//                        変わらないため、この方法にしている。
//   パソコン           … meta viewport が効かないので、CSS の zoom で拡大する。
export const TEXT_SIZE_KEY = "text-size";

export const TEXT_SIZES = [
  { key: "normal", label: "標準", zoom: 1 },
  { key: "large", label: "大きめ", zoom: 1.15 },
  { key: "xlarge", label: "特大", zoom: 1.3 },
];

const BASE_VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";

export function readTextSize() {
  try {
    const v = localStorage.getItem(TEXT_SIZE_KEY);
    return TEXT_SIZES.some((s) => s.key === v) ? v : null; // null = まだ選んでいない
  } catch (e) {
    return null;
  }
}

// 指で操作する端末(スマホ・タブレット)か
function isTouchDevice() {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch (e) {
    return false;
  }
}

// CSS の zoom で拡大しているか(パソコンで標準以外の時)
export function usesCssZoom(key) {
  const size = TEXT_SIZES.find((s) => s.key === key) || TEXT_SIZES[0];
  return size.zoom !== 1 && !isTouchDevice();
}

export function applyTextSize(key) {
  const size = TEXT_SIZES.find((s) => s.key === key) || TEXT_SIZES[0];
  const z = size.zoom;
  const root = document.getElementById("root");
  const meta = document.querySelector('meta[name="viewport"]');

  if (isTouchDevice()) {
    // 表示の幅を 1/z にして z 倍で表示 → 画面の幅にぴったり収まったまま全体が z 倍になる
    if (root) root.style.zoom = "";
    document.documentElement.style.setProperty("--app-zoom", "1");
    if (meta) {
      if (z === 1) {
        meta.setAttribute("content", BASE_VIEWPORT);
      } else {
        const deviceWidth = Math.min(window.screen.width || 390, window.screen.height || 844);
        const w = Math.round(deviceWidth / z);
        meta.setAttribute("content", `width=${w}, initial-scale=${z}, minimum-scale=${z}, maximum-scale=${z}, viewport-fit=cover`);
      }
    }
  } else {
    if (meta) meta.setAttribute("content", BASE_VIEWPORT);
    if (root) root.style.zoom = z === 1 ? "" : String(z);
    // 画面の高さ(vh)を使っている所は、拡大した分だけ割り戻す(index.css)
    document.documentElement.style.setProperty("--app-zoom", String(z));
  }
  // 大きめ以上では、薄くしている補足の文字を濃くして読みやすくする
  document.documentElement.classList.toggle("large-text", z > 1);
}

export function saveTextSize(key) {
  try {
    localStorage.setItem(TEXT_SIZE_KEY, key);
  } catch (e) {
    // 保存できなくても、表示の切り替えはできる
  }
  applyTextSize(key);
}
