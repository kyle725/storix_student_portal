/**
 * Storix Cloudflare Worker
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles the three student-portal endpoints:
 *   GET  /api/ping      — health check
 *   GET  /api/items     — list borrowable inventory (reads from D1)
 *   POST /api/request   — submit a loan request (writes to D1)
 *
 * Bindings required in wrangler.toml:
 *   DB   → Cloudflare D1 database
 *
 * Environment variables (set in wrangler.toml [vars] or dashboard secrets):
 *   PORTAL_ORIGIN  → e.g. "https://storix-portal.pages.dev"
 *                    Use "*" only during local testing.
 *   SYNC_SECRET    → a shared secret used by sync.py to authenticate pushes
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── CORS ─────────────────────────────────────────────────────────────────────

function corsHeaders(env, extraHeaders = {}) {
  return {
    "Access-Control-Allow-Origin":  env.PORTAL_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Sync-Secret",
    ...extraHeaders,
  };
}

function jsonResponse(body, status = 200, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

function optionsResponse(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}


// ── ITEM STATUS HELPER (mirrors app.py logic) ─────────────────────────────────

function itemStatus(available, total, lowAlert, condition) {
  if (["Under Maintenance", "Damaged", "Lost"].includes(condition)) return condition;
  if (available === 0) return "Out of Stock";
  if (available <= 3 && available < total) return "Low Stock";
  return "Available";
}


// ── ROUTE HANDLERS ────────────────────────────────────────────────────────────

/** GET /api/ping */
async function handlePing(env) {
  return jsonResponse({ ok: true, status: "online" }, 200, env);
}


/** GET /api/items */
async function handleItems(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, category, location, available, total_qty, condition
     FROM items
     ORDER BY name`
  ).all();

  const items = results.map(r => ({
    id:        r.id,
    name:      r.name,
    category:  r.category,
    location:  r.location,
    available: r.available,
    total:     r.total_qty,
    status:    itemStatus(r.available, r.total_qty, 5, r.condition),
    borrowable: r.available > 0 &&
                !["Under Maintenance", "Damaged", "Lost"].includes(r.condition),
  }));

  return jsonResponse({ ok: true, items }, 200, env);
}


/** POST /api/request */
async function handleRequest(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ ok: false, errors: ["Invalid JSON body."] }, 400, env);
  }

  const student_name    = (data.student_name    || "").trim();
  const student_id      = (data.student_id      || "").trim();
  const student_email   = (data.student_email   || "").trim();
  const student_contact = (data.student_contact || "").trim();
  const item_id         = parseInt(data.item_id, 10) || 0;
  const quantity        = Math.max(1, parseInt(data.quantity, 10) || 1);
  const due_date        = (data.due_date || "").trim() || null;
  const purpose         = (data.purpose  || "").trim();

  // ── Validation ──
  const errors = [];
  if (!student_name)  errors.push("Full name is required.");
  if (!student_id)    errors.push("Student ID is required.");
  if (!student_email) errors.push("Email address is required.");
  if (!purpose)       errors.push("Purpose is required.");
  if (!item_id)       errors.push("Please select an item.");
  if (errors.length)  return jsonResponse({ ok: false, errors }, 400, env);

  // ── Check item exists and has stock ──
  const item = await env.DB.prepare(
    "SELECT id, name, available, condition FROM items WHERE id = ?"
  ).bind(item_id).first();

  if (!item) {
    return jsonResponse({ ok: false, errors: ["Item not found."] }, 404, env);
  }
  if (["Under Maintenance", "Damaged", "Lost"].includes(item.condition)) {
    return jsonResponse(
      { ok: false, errors: ["This item is not currently available for loan."] },
      409, env
    );
  }
  if (item.available < quantity) {
    return jsonResponse(
      { ok: false, errors: [`Only ${item.available} unit(s) available.`] },
      409, env
    );
  }

  // ── Insert pending request ──
  await env.DB.prepare(`
    INSERT INTO pending_requests
      (type, item_id, student_name, student_id, student_email,
       student_contact, quantity, purpose, due_date, status, created_at)
    VALUES ('loan', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
  `).bind(
    item_id, student_name, student_id, student_email,
    student_contact, quantity, purpose, due_date
  ).run();

  return jsonResponse({
    ok:      true,
    message: "Request submitted. An admin will review and approve it shortly.",
    item:    item.name,
    quantity,
  }, 200, env);
}


/**
 * POST /api/sync/push-items
 * Called by sync.py running on the admin PC.
 * Replaces the entire items snapshot in D1 with fresh data from storix.db.
 * Protected by X-Sync-Secret header.
 */
async function handleSyncPushItems(request, env) {
  // Auth check
  const secret = request.headers.get("X-Sync-Secret") || "";
  if (!env.SYNC_SECRET || secret !== env.SYNC_SECRET) {
    return jsonResponse({ ok: false, error: "Unauthorized." }, 401, env);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON." }, 400, env);
  }

  const items = payload.items;
  if (!Array.isArray(items)) {
    return jsonResponse({ ok: false, error: "Expected { items: [...] }" }, 400, env);
  }

  // Upsert all items in a single batch
  const stmts = items.map(item =>
    env.DB.prepare(`
      INSERT INTO items (id, name, sku, category, total_qty, available,
                         low_alert, notes, location, assigned_to, condition)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name        = excluded.name,
        sku         = excluded.sku,
        category    = excluded.category,
        total_qty   = excluded.total_qty,
        available   = excluded.available,
        low_alert   = excluded.low_alert,
        notes       = excluded.notes,
        location    = excluded.location,
        assigned_to = excluded.assigned_to,
        condition   = excluded.condition
    `).bind(
      item.id, item.name, item.sku || null, item.category,
      item.total_qty, item.available, item.low_alert || 5,
      item.notes || null, item.location || "Sim Man Room",
      item.assigned_to || null, item.condition || "Good"
    )
  );

  await env.DB.batch(stmts);

  return jsonResponse({ ok: true, synced: items.length }, 200, env);
}


/**
 * GET /api/sync/pull-requests
 * Called by sync.py to download new pending requests for import into storix.db.
 * Returns only requests not yet pulled (pulled_at IS NULL).
 * Protected by X-Sync-Secret header.
 */
async function handleSyncPullRequests(request, env) {
  const secret = request.headers.get("X-Sync-Secret") || "";
  if (!env.SYNC_SECRET || secret !== env.SYNC_SECRET) {
    return jsonResponse({ ok: false, error: "Unauthorized." }, 401, env);
  }

  const { results } = await env.DB.prepare(`
    SELECT id, type, item_id, student_name, student_id, student_email,
           student_contact, quantity, purpose, due_date, condition,
           notes, status, created_at
    FROM pending_requests
    WHERE pulled_at IS NULL
    ORDER BY created_at ASC
  `).all();

  // Mark them as pulled so they aren't returned again
  if (results.length > 0) {
    const ids = results.map(r => r.id);
    // D1 doesn't support parameterized IN lists natively — use batch
    const markStmts = ids.map(id =>
      env.DB.prepare(
        "UPDATE pending_requests SET pulled_at = datetime('now') WHERE id = ?"
      ).bind(id)
    );
    await env.DB.batch(markStmts);
  }

  return jsonResponse({ ok: true, requests: results }, 200, env);
}


// ── MAIN FETCH HANDLER ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // Preflight
    if (method === "OPTIONS") return optionsResponse(env);

    // ── Route table ──
    if (path === "/api/ping" && method === "GET") {
      return handlePing(env);
    }

    if (path === "/api/items" && method === "GET") {
      return handleItems(env);
    }

    if (path === "/api/request" && method === "POST") {
      return handleRequest(request, env);
    }

    if (path === "/api/sync/push-items" && method === "POST") {
      return handleSyncPushItems(request, env);
    }

    if (path === "/api/sync/pull-requests" && method === "GET") {
      return handleSyncPullRequests(request, env);
    }

    // 404 fallback
    return jsonResponse({ ok: false, error: "Not found." }, 404, env);
  },
};