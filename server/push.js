import webpush from "web-push";
import { kvGet, kvSet, pushSubscriptionsFor, removePushSubscription } from "./db.js";

let publicKey = null;
let ready = false;

// Uses VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY if set. Otherwise makes a key pair
// once and keeps it in the database so existing subscriptions keep working.
export async function initPush() {
  let keys = null;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  } else {
    const saved = await kvGet("vapid");
    if (saved) {
      keys = JSON.parse(saved);
    } else {
      keys = webpush.generateVAPIDKeys();
      await kvSet("vapid", JSON.stringify(keys));
    }
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@lukescookies.app",
    keys.publicKey,
    keys.privateKey
  );
  publicKey = keys.publicKey;
  ready = true;
}

export function pushPublicKey() {
  return publicKey;
}

export async function sendPush(userId, payload) {
  if (!ready) return;
  const subs = await pushSubscriptionsFor(userId);
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, { TTL: 60 * 60 * 24, urgency: "high" });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await removePushSubscription(sub.endpoint);
        } else {
          console.warn("Push failed:", err.statusCode || err.message);
        }
      }
    })
  );
  return { devices: subs.length, sent };
}
