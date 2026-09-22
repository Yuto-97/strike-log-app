// Verifies who is calling an account API. The browser sends the Firebase
// ID token it got at login; we check it with Firebase itself, so a request
// can never claim to be a different user just by sending their uid.
export async function verifyCaller(req, adminAuth) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(m[1]);
    return { uid: decoded.uid, email: decoded.email || null };
  } catch (e) {
    return null;
  }
}
