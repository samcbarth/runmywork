import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import webpush from 'npm:web-push@3.6.7';

// Fan-out Web Push sender. Anything that wants to notify the user's phone POSTs
// { title, body, projectId?, tag? } here; this signs each push with VAPID and
// delivers it to every stored subscription, pruning ones that are gone.
//
// Setup:
//   supabase secrets set VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...  VAPID_SUBJECT=mailto:you@example.com
//   supabase functions deploy send-push
//
// Called with the public anon key (like trigger-agent) — no credentials needed
// on the caller. Reads subscriptions with the service role key (auto-injected).

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@runmywork.local';

function sbHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return new Response(JSON.stringify({ ok: false, reason: 'VAPID keys not set' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const body = await req.json().catch(() => ({}));
  const payload = JSON.stringify({
    title: String(body.title || 'RunMyWork'),
    body:  String(body.body  || ''),
    projectId: body.projectId ?? null,
    tag: body.tag ?? 'rmw'
  });

  // Pull every subscription.
  const subRes = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, { headers: sbHeaders() });
  if (!subRes.ok) {
    return new Response(JSON.stringify({ ok: false, reason: `subs GET ${subRes.status}` }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
  const subs = await subRes.json();

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(subs.map(async (s: any) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
    } catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint);   // gone — prune
    }
  }));

  // Prune dead subscriptions so we don't keep retrying them.
  if (dead.length) {
    const list = dead.map(e => `"${e.replace(/"/g, '\\"')}"`).join(',');
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=in.(${encodeURIComponent(list)})`, {
      method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' }
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, sent, pruned: dead.length, total: subs.length }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...CORS }
  });
});
