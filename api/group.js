// Group location sharing for bachelorette parties and friend trips.
// All actions in one endpoint to stay under the Vercel Hobby 12-function limit.
// Storage: Vercel KV (Upstash Redis) with TTL-based auto-expiry.
//
// Actions (POST body { action, ... }):
//   create   { durationHours: 6|12|24, leaderName?: string }
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

const ALLOWED_DURATIONS = [6, 12, 24];
const STALE_AFTER_MS = 60 * 1000; // member pin disappears if not updated in 60s
const CODE_LEN = 4;

function randomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,1,0 to avoid confusion
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += letters[Math.floor(Math.random() * letters.length)];
  return c;
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

  try {
    if (action === 'create') {
      const dur = Number(req.body.durationHours);
      if (!ALLOWED_DURATIONS.includes(dur)) {
        return bad(res, 400, 'Duration must be 6, 12, or 24 hours');
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
      if (typeof lat !== 'number' || typeof lng !== 'number') return bad(res, 400, 'lat and lng required');
      if (!memberId) return bad(res, 400, 'memberId required');
      const group = await kv.get(`group:${code}`);
      if (!group) return bad(res, 404, 'Group not found or expired');
      if (group.ended) return bad(res, 410, 'Group ended');

      const now = Date.now();
      const cleanName = (name || 'Friend').slice(0, 40);
      const idx = group.members.findIndex(m => m.id === memberId);
      if (idx >= 0) {
        group.members[idx] = { ...group.members[idx], name: cleanName, lat, lng, updatedAt: now };
      } else {
        // New member joining via this update
        group.members.push({ id: memberId, name: cleanName, lat, lng, updatedAt: now, isLeader: false });
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
      if (!group) return res.status(404).json({ error: 'Group not found or expired', expired: true });
      return res.status(200).json({
        members: publicMembers(group.members),
        expiresAt: group.expiresAt,
        ended: !!group.ended,
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
      const { memberId } = req.body || {};
      if (!code || !memberId) return bad(res, 400, 'code and memberId required');
      const group = await kv.get(`group:${code}`);
      if (!group) return res.status(200).json({ ok: true });
      if (group.leaderId !== memberId) return bad(res, 403, 'Only the group leader can end the party');
      group.ended = true;
      // Keep around for 60 seconds so members see "ended" message
      await kv.set(`group:${code}`, group, { ex: 60 });
      return res.status(200).json({ ok: true });
    }

    if (action === 'transferLeader') {
      const { memberId, newLeaderId } = req.body || {};
      if (!code || !memberId || !newLeaderId) return bad(res, 400, 'code, memberId, and newLeaderId required');
      const group = await kv.get(`group:${code}`);
      if (!group) return bad(res, 404, 'Group not found or expired');
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
    console.error('group api error', e);
    return console.error("[group] error", e); res.status(500).json({ error: "internal server error" });
  }
}
