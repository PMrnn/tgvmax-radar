// TGVmax Radar — watches API.
// Stores "watches" (a saved search + a browser push subscription) in KV so that
// a separate GitHub Actions job can periodically re-run the search and push a
// real Web Push notification when a new matching itinerary appears.
//
// Public routes (used by the browser app):
//   POST   /watches                  -> create a watch, returns {id}
//   GET    /watches?deviceId=X       -> list this device's own watches
//   DELETE /watches/:id?deviceId=X   -> delete a watch (only its own device)
//
// Admin routes (used by the GitHub Actions job only, gated by a shared secret):
//   GET    /admin/watches                 -> full list of every watch (all devices)
//   PATCH  /admin/watches/:id             -> merge-update a watch (e.g. notifiedKeys, lastCheckedAt)
//   DELETE /admin/watches/:id             -> hard delete (e.g. expired push subscription)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function isAdmin(request, env) {
  const secret = request.headers.get("X-Admin-Secret");
  return !!env.ADMIN_SECRET && secret === env.ADMIN_SECRET;
}

async function listAllWatches(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.WATCHES.list({ prefix: "watch:", cursor });
    for (const key of page.keys) {
      const raw = await env.WATCHES.get(key.name);
      if (raw) out.push(JSON.parse(raw));
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---- Public: create a watch ----
    if (pathname === "/watches" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "JSON invalide" }, 400); }
      if (!body.deviceId || !body.subscription || !body.criteria) {
        return json({ error: "deviceId, subscription et criteria sont requis" }, 400);
      }
      const id = crypto.randomUUID();
      const record = {
        id,
        deviceId: body.deviceId,
        label: body.label || "",
        subscription: body.subscription,
        criteria: body.criteria,
        notifiedKeys: [],
        createdAt: new Date().toISOString(),
        lastCheckedAt: null,
        lastError: null,
      };
      await env.WATCHES.put(`watch:${id}`, JSON.stringify(record));
      return json({ id });
    }

    // ---- Public: list a device's own watches ----
    if (pathname === "/watches" && request.method === "GET") {
      const deviceId = url.searchParams.get("deviceId");
      if (!deviceId) return json({ error: "deviceId requis" }, 400);
      const all = await listAllWatches(env);
      const mine = all
        .filter(w => w.deviceId === deviceId)
        .map(({ id, label, criteria, createdAt, lastCheckedAt, lastError }) =>
          ({ id, label, criteria, createdAt, lastCheckedAt, lastError }));
      return json({ watches: mine });
    }

    // ---- Public: delete own watch ----
    let m = pathname.match(/^\/watches\/([^/]+)$/);
    if (m && request.method === "DELETE") {
      const deviceId = url.searchParams.get("deviceId");
      const key = `watch:${m[1]}`;
      const raw = await env.WATCHES.get(key);
      if (!raw) return json({ error: "not found" }, 404);
      const record = JSON.parse(raw);
      if (record.deviceId !== deviceId) return json({ error: "forbidden" }, 403);
      await env.WATCHES.delete(key);
      return json({ ok: true });
    }

    // ---- Admin: full list (for the scheduled checker) ----
    if (pathname === "/admin/watches" && request.method === "GET") {
      if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const all = await listAllWatches(env);
      return json({ watches: all });
    }

    // ---- Admin: merge-update a watch ----
    m = pathname.match(/^\/admin\/watches\/([^/]+)$/);
    if (m && request.method === "PATCH") {
      if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const key = `watch:${m[1]}`;
      const raw = await env.WATCHES.get(key);
      if (!raw) return json({ error: "not found" }, 404);
      const record = JSON.parse(raw);
      let patch;
      try { patch = await request.json(); } catch (e) { return json({ error: "JSON invalide" }, 400); }
      Object.assign(record, patch);
      await env.WATCHES.put(key, JSON.stringify(record));
      return json({ ok: true });
    }

    // ---- Admin: hard delete (e.g. expired subscription) ----
    if (m && request.method === "DELETE") {
      if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      await env.WATCHES.delete(`watch:${m[1]}`);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
