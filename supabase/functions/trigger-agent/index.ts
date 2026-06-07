import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Triggers a GitHub Actions workflow_dispatch so the agent runs in the cloud.
// Called by the app on open — no PAT on the device; the token lives here as a
// Supabase secret (Dashboard → Edge Functions → trigger-agent → Secrets).
//
// Setup:
//   supabase functions deploy trigger-agent
//   supabase secrets set GITHUB_TOKEN=github_pat_...   # needs actions:write scope
//
// The app calls this with the anon key — no credentials on device.

const REPO     = 'samcbarth/runmywork';
const WORKFLOW = 'agent.yml';
const CORS     = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const token = Deno.env.get('GITHUB_TOKEN');
  if (!token) {
    return new Response(JSON.stringify({ ok: false, reason: 'GITHUB_TOKEN secret not set' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }

  // App may target a specific project (and force the "needs it" filter off) by
  // POSTing { project_id, mode }. These map to the workflow_dispatch inputs in
  // agent.yml so the run actually works that project instead of auto-picking none.
  const reqBody = await req.json().catch(() => ({}));
  const inputs: Record<string, string> = {};
  if (reqBody.project_id)  inputs.project_id  = String(reqBody.project_id);
  if (reqBody.mode)        inputs.mode        = String(reqBody.mode);
  if (reqBody.target_repo) inputs.target_repo = String(reqBody.target_repo);

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization:           `Bearer ${token}`,
        Accept:                  'application/vnd.github+json',
        'X-GitHub-Api-Version':  '2022-11-28',
        'Content-Type':          'application/json'
      },
      body: JSON.stringify({ ref: 'main', inputs })
    }
  );

  // GitHub returns 204 No Content on success
  const ok = res.status === 204;
  return new Response(JSON.stringify({ ok, status: res.status }), {
    status: ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
});
