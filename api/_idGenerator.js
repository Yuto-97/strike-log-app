// Shared helper for generating a registrant ID: a random 7-character string
// using digits 1-9 only (never 0), checked against Firestore for uniqueness.
import { db } from "./_firebaseAdmin.js";

const ID_DIGITS = "123456789";

function randomId() {
  let id = "";
  for (let i = 0; i < 7; i++) {
    id += ID_DIGITS[Math.floor(Math.random() * ID_DIGITS.length)];
  }
  return id;
}

export async function generateUniqueId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomId();
    const clash = await db.collection("accessRequests").where("requestNumber", "==", candidate).limit(1).get();
    if (clash.empty) return candidate;
  }
  // Extremely unlikely to ever hit this, but fall back to a longer id rather than fail.
  return randomId() + randomId();
}
