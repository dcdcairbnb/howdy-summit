// Group location sharing for bachelorette parties and friend trips.
// All actions in one endpoint to stay under the Vercel Hobby 12-function limit.
// Storage: Vercel KV (Upstash Redis) with TTL-based auto-expiry.
//
// Actions (POST body { action, ... }):
//   create   { durationHours: 8|12|24, leaderName?: string }
//             -> { code, expiresAt }
//   update   { code, memberId, name, lat, lng }
//             -> { ok, members }
//   get      { code }
//             -> { members, expiresAt, ended }
//   leave    { code, memberId }
//             -> { ok, members }
//   end      { code, memberId }   (only the leader can end)
//             -> { ok }

import { Redis } from '@upstash/redis';

// Upstash created env vars with KV_ prefix when we connected via Vercel.
// Pass them explicitly so the SDK finds them.
const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const ALLOWED_DURATIONS = [8, 12, 24];
const STALE_AFTER_MS = 60 * 1000; // member pin disappears if not updated in 60s

// Code length went 4 -> 6.
//
// The alphabet has 32 characters, so 4 gave about a million combinations. The
// `get` action returns every member's name and live latitude and longitude for
// any valid code, with no membership check, which is by design because that is
// how someone joins from a text message. But a million is a small number for a
// script, and there was no rate limiting, so codes could be enumerated until
// one hit and a stranger's live position came back.
//
// Six characters is roughly a billion, and combined with the limiter below it
// makes enumeration impractical. Existing 4-character codes keep working
// because lookup never checks length, and they all expire within 24 hours.
const CODE_LEN = 6;

function randomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,1,0 to avoid confusion
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += letters[Math.floor(Math.random() * letters.length)];
  return c;
}

// In-memory limiter, per warm function instance. Not a distributed lock, and
// Vercel may run several instances, so treat it as a speed bump rather than a
// wall. It still turns enumeration from minutes into an implausible amount of
// time, and it costs no extra Redis round trips.
//
// Misses are tracked separately from ordinary traffic: a real group polls a
// code it already has and gets hits, whereas a scanner produces almost nothing
// but 404s. Tripping on misses catches scanning without ever penalising a
// legitimate group that happens to poll often.
const ipHits = new Map();
const ipMisses = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MIN = 120;   // a 5s poll from a big group stays well under
const MAX_MISSES_PER_MIN = 10;      // fat-fingering a code a few times is fine

function bump(store, ip) {
  const now = Date.now();
  const rec = store.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    store.set(ip, { start: now, count: 1 });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// Keep the maps from growing without bound on a long-lived instance.
function sweep() {
  const now = Date.now();
  for (const store of [ipHits, ipMisses]) {
    if (store.size < 5000) continue;
    for (const [k, v] of store) if (now - v.start > WINDOW_MS) store.delete(k);
  }
}

function pruneStale(members) {
  const now = Date.now();
  return members.filter(m => m && (now - m.updatedAt) <= STALE_AFTER_MS * 5);
}

function publicMembers(members) {
  // Member IDs are random opaque tokens, not personally identifiable.
  // The leader needs them to transfer leadership to a specific member.
  return pruneStale(members).map(m => ({
    id: m.id,
    name: m.name || 'Friend',
    lat: m.lat,
    lng: m.lng,
    updatedAt: m.updatedAt,
    isLeader: !!m.isLeader
  }));
}

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!process.env.KV_REST_API_URL && !process.env.KV_URL) {
    return bad(res, 503, 'Group sharing temporarily unavailable. Backend not configured.');
  }
  const { action, code: rawCode } = req.body || {};
  const code = (rawCode || '').toUpperCase();

  sweep();
  const ip = clientIp(req);
  if (bump(ipHits, ip) > MAX_REQUESTS_PER_MIN) {
    return bad(res, 429, 'Too many requests. Slow down and try again in a minute.');
  }
  // A client that keeps asking for codes that do not exist is scanning, not
  // using the app. Cut it off before it finds a real one.
  const missRec = ipMisses.get(ip);
  if (missRec && Date.now() - missRec.start <= WINDOW_MS && missRec.count > MAX_MISSES_PER_MIN) {
    return bad(res, 429, 'Too many invalid codes. Try again in a minute.');
  }

  try {
    if (action === 'create') {
      const dur = Number(req.body.durationHours);
      if (!ALLOWED_DURATIONS.includes(dur)) {
        return bad(res, 400, 'Duration must be 8, 12, or 24 hours');
      }
      // Pick a code that isn't already taken
      let newCode = '';
      for (let i = 0; i < 10; i++) {
        const c = randomCode();
        const exists = await kv.get(`group:${c}`);
        if (!exists) { newCode = c; break; }
      }
      if (!newCode) return bad(res, 500, 'Could not generate a unique code, try again');

      const leaderId = req.body.memberId || `m_${Math.random().toString(36).slice(2, 10)}`;
      const leaderName = (req.body.leaderName || 'Group leader').slice(0, 40);
      const ttlSec = dur * 60 * 60;
      const now = Date.now();
      const data = {
        code: newCode,
        createdAt: now,
        expiresAt: now + ttlSec * 1000,
        durationHours: dur,
        leaderId,
        ended: false,
        members: [
          { id: leaderId, name: leaderName, lat: null, lng: null, updatedAt: now, isLeader: true }
        ]
      };
      await kv.set(`group:${newCode}`, data, { ex: ttlSec });
      return res.status(200).json({
        code: newCode,
        memberId: leaderId,
        expiresAt: data.expiresAt,
        durationHours: dur
      });
    }

    if (action === 'update') {
      const { memberId, name, lat, lng } = req.body || {};
      if (!code) return bad(res, 400, 'Missing code');
      if (!memberId) return bad(res, 400, 'memberId required');
      // lat/lng are optional. A new member registering without a position yet
      // (just tapped Join, hasn't accepted the OS location prompt) still gets
      // added to the roster so the leader sees them waiting. Once their device
      // shares location, a follow-up update fills in the coords.
      const hasCoords = typeof lat === 'number' && typeof lng === 'number';
      const group = await kv.get(`group:${code}`);
      if (!group) { bump(ipMisses, ip); return bad(res, 404, 'Group not found or expired'); }
      if (group.ended) return bad(res, 410, 'Group ended');

      const now = Date.now();
      const cleanName = (name || 'Friend').slice(0, 40);
      const idx = group.members.findIndex(m => m.id === memberId);
      if (idx >= 0) {
        const existing = group.members[idx];
        group.members[idx] = {
          ...existing,
          name: cleanName,
          // Preserve existing coords if this update has none, otherwise overwrite
          lat: hasCoords ? lat : existing.lat,
          lng: hasCoords ? lng : existing.lng,
          updatedAt: now
        };
      } else {
        // New member joining (or returning after being pruned for inactivity).
        // If their memberId matches group.leaderId, restore their leader role
        // - this happens when the leader killed their app for 5+ minutes and
        // re-opened it, so they should keep leading the group they created.
        const isReturningLeader = group.leaderId === memberId;
        group.members.push({
          id: memberId,
          name: cleanName,
          lat: hasCoords ? lat : null,
          lng: hasCoords ? lng : null,
          updatedAt: now,
          isLeader: isReturningLeader
        });
      }
      // Prune stale members on write
      group.members = pruneStale(group.members);
      const ttlSec = Math.max(60, Math.round((group.expiresAt - now) / 1000));
      await kv.set(`group:${code}`, group, { ex: ttlSec });
      return res.status(200).json({ ok: true, members: publicMembers(group.members), expiresAt: group.expiresAt });
    }

    if (action === 'get') {
      if (!code) return bad(res, 400, 'Missing code');
      const group = await kv.get(`group:${code}`);
      if (!group) { bump(ipMisses, ip); return res.status(404).json({ error: 'Group not found or expired', expired: true }); }
      // If the leader requested an end and the grace period has elapsed with
      // nobody claiming leadership, finalize the end now so the next poll
      // notifies everyone.
      if (group.endingAt && group.endingAt <= Date.now() && !group.ended) {
        group.ended = true;
        group.endingAt = null;
        await kv.set(`group:${code}`, group, { ex: 60 });
      }
      return res.status(200).json({
        members: publicMembers(group.members),
        expiresAt: group.expiresAt,
        ended: !!group.ended,
        endingAt: group.endingAt || null,
        durationHours: group.durationHours
      });
    }

    if (action === 'leave') {
      const { memberId } = req.body || {};
      if (!code || !memberId) return bad(res, 400, 'code and memberId required');
      const group = await kv.get(`group:${code}`);
      if (!group) return res.status(200).json({ ok: true, members: [] });
      group.members = group.members.filter(m => m.id !== memberId);
      const ttlSec = Math.max(60, Math.round((group.expiresAt - Date.now()) / 1000));
      await kv.set(`group:${code}`, group, { ex: ttlSec });
      return res.status(200).json({ ok: true, members: publicMembers(group.members) });
    }

    if (action === 'end') {
      const { memberId, immediate } = req.body || {};
      if (!code || !memberId) return bad(res, 400, 'code and memberId required');
      const group = await kv.get(`group:${code}`);
      if (!group) return res.status(200).json({ ok: true });
      if (group.leaderId !== memberId) return bad(res, 403, 'Only the group leader can end the party');
      if (immediate) {
        // Hard end: skip grace period (used when leader is the only member).
        group.ended = true;
        group.endingAt = null;
        await kv.set(`group:${code}`, group, { ex: 60 });
        return res.status(200).json({ ok: true, ended: true });
      }
      // Soft end: 5-minute grace period. Gives members enough time to notice
      // even if their phone is in a pocket. Anyone can claim leadership in
      // this window to keep the group going. After the window the next get
      // call finalizes the end.
      const graceMs = 5 * 60 * 1000;
      group.endingAt = Date.now() + graceMs;
      const ttlSec = Math.max(60, Math.round((group.expiresAt - Date.now()) / 1000));
      await kv.set(`group:${code}`, group, { ex: ttlSec });
      return res.status(200).json({ ok: true, endingAt: group.endingAt });
    }

    if (action === 'cancelEnd') {
      const { memberId } = req.body || {};
      if (!code || !memberId) return bad(res, 400, 'code and memberId required');
      const group = await kv.get(`group:${code}`);
      if (!group) { bump(ipMisses, ip); return bad(res, 404, 'Group not found or expired'); }
      if (group.leaderId !== memberId) return bad(res, 403, 'Only the leader can cancel');
      group.endingAt = null;
      const ttlSec = Math.max(60, Math.round((group.expiresAt - Date.now()) / 1000));
      await kv.set(`group:${code}`, group, { ex: ttlSec });
      return res.status(200).json({ ok: true });
    }

    if (action === 'claimLeader') {
      const { memberId } = req.body || {};
      if (!code || !memberId) return bad(res, 400, 'code and memberId required');
      const group = await kv.get(`group:${code}`);
      if (!group) { bump(ipMisses, ip); return bad(res, 404, 'Group not found or expired'); }
      if (group.ended) return bad(res, 410, 'Group already ended');
      if (!group.endingAt || group.endingAt <= Date.now()) {
        return bad(res, 409, 'No pending end to claim');
      }
      const claimer = group.members.find(m => m.id === memberId);
      if (!claimer) return bad(res, 404, 'Not a member of this group');
      // Transfer leadership and clear the pending end.
      group.members = group.members.map(m => ({ ...m, isLeader: m.id === memberId }));
      group.leaderId = memberId;
      group.endingAt = null;
      const ttlSec = Math.max(60, Math.round((group.expiresAt - Date.now()) / 1000));
      await kv.set(`group:${code}`, group, { ex: ttlSec });
      return res.status(200).json({ ok: true, members: publicMembers(group.members), newLeaderId: memberId });
    }

    if (action === 'transferLeader') {
      const { memberId, newLeaderId } = req.body || {};
      if (!code || !memberId || !newLeaderId) return bad(res, 400, 'code, memberId, and newLeaderId required');
      const group = await kv.get(`group:${code}`);
      if (!group) { bump(ipMisses, ip); return bad(res, 404, 'Group not found or expired'); }
      if (group.leaderId !== memberId) return bad(res, 403, 'Only the current leader can transfer leadership');
      const newLeader = group.members.find(m => m.id === newLeaderId);
      if (!newLeader) return bad(res, 404, 'New leader is not a member of this group');
      // Flip isLeader flags and update group.leaderId
      group.members = group.members.map(m => ({ ...m, isLeader: m.id === newLeaderId }));
      group.leaderId = newLeaderId;
      const ttlSec = Math.max(60, Math.round((group.expiresAt - Date.now()) / 1000));
      await kv.set(`group:${code}`, group, { ex: ttlSec });
      return res.status(200).json({ ok: true, members: publicMembers(group.members), newLeaderId });
    }

    return bad(res, 400, 'Unknown action');
  } catch (e) {
    console.error('[group] error', e);
    return res.status(500).json({ error: 'internal server error', detail: (e && e.message) || 'unknown' });
  }
}
