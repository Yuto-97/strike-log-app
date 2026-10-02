// 管理画面のAPIを使ってよいかの判定。
//
// 1. 管理者のアカウント(登録番号 1488689)でログインしていれば、パスワードなしでOK
//    (ブラウザが送るFirebaseのIDトークンをFirebase自身で確認するので、なりすましはできない)
// 2. 予備として、これまでの管理者パスワード(ADMIN_PASSWORD)でもOK
//
// 先頭が「_」のファイルなので、Vercelのサーバー機能数には数えられない。
import { verifyCaller } from "./_accountAuth.js";

export const ADMIN_REQUEST_NUMBERS = ["1488689"];

export async function isAdminRequest(req, { db, adminAuth, adminPassword = process.env.ADMIN_PASSWORD } = {}) {
  const body = req.body || {};
  const pw = req.method === "GET" ? (req.query || {}).password : body.password;
  if (adminPassword && pw && pw === adminPassword) return true;

  if (!db || !adminAuth) return false;
  const caller = await verifyCaller(req, adminAuth);
  if (!caller) return false;
  try {
    const snap = await db.collection("accessRequests").doc(caller.uid).get();
    if (!snap.exists) return false;
    const a = snap.data();
    return a.status === "approved" && ADMIN_REQUEST_NUMBERS.includes(String(a.requestNumber || ""));
  } catch (e) {
    return false;
  }
}
