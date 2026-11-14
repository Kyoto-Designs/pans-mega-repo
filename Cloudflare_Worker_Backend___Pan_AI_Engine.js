/**
 * Pan's Mega Repo — Pan AI Cloudflare Worker Backend
 * Bindings required in wrangler.jsonc:
 * - DB (D1 Database)
 * - KV (KV Namespace for rate-limiting, settings, and fingerprint cache)
 * - R2 (Optional R2 Bucket for large IPA staging)
 * Secrets (set via `wrangler secret put`):
 * - ADMIN_API_TOKEN
 * - GITHUB_TOKEN
 * - GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    const allowedOrigin = env.ALLOWED_ORIGIN || origin;

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    try {
      // Rate limiting via KV (60 requests / minute per IP)
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (env.KV) {
        const rlKey = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
        const count = Number((await env.KV.get(rlKey)) || 0);
        if (count > 60) {
          return json({ error: "Rate limit exceeded. Try again in 60 seconds." }, 429);
        }
        ctx.waitUntil(env.KV.put(rlKey, String(count + 1), { expirationTtl: 120 }));
      }

      // Public Health Endpoint
      if (url.pathname === "/api/health" && request.method === "GET") {
        const aiCfg = await getAiConfig(env);
        return json({
          ok: true,
          version: "2.0.0-pan-ai",
          d1: Boolean(env.DB),
          kv: Boolean(env.KV),
          r2: Boolean(env.R2),
          provider: aiCfg.provider,
          model: aiCfg.model,
        });
      }

      // Authenticate all mutating / AI endpoints
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!env.ADMIN_API_TOKEN || token !== env.ADMIN_API_TOKEN) {
        return json({ error: "Unauthorized: Invalid or missing Admin Bearer Token." }, 401);
      }

      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return json({ error: "Invalid JSON payload" }, 400);
      }

      // 1. Save AI Provider Settings securely in KV (never returned back in plaintext)
      if (url.pathname === "/api/settings/ai") {
        if (!env.KV) return json({ error: "KV namespace binding missing" }, 500);
        const existing = JSON.parse((await env.KV.get("pan_ai_config")) || "{}");
        const updated = {
          enabled: body.enabled !== false,
          provider: body.provider || existing.provider || "gemini",
          model: body.model || existing.model || "gemini-2.5-flash",
          customEndpoint: body.customEndpoint || "",
          temperature: Math.min(1, Math.max(0, Number(body.temperature ?? 0.2))),
          maxTokens: Math.min(16384, Math.max(128, Number(body.maxTokens ?? 2048))),
          apiKey: body.apiKey ? body.apiKey : existing.apiKey || "",
        };
        await env.KV.put("pan_ai_config", JSON.stringify(updated));
        await logActivity(env, "Settings", `Updated AI provider to ${updated.provider} (${updated.model})`);
        return json({ ok: true, provider: updated.provider, model: updated.model });
      }

      // 2. Validate IPA Metadata & Record in D1
      if (url.pathname === "/api/ipa/validate" || url.pathname === "/api/ai/analyze-ipa") {
        const { app } = body;
        if (!app || !app.bundleIdentifier || !app.sha256) {
          return json({ error: "Missing required fields: app.bundleIdentifier and app.sha256" }, 400);
        }
        const warnings = [];
        if (!app.downloadURL || !/^https:\/\/.+/.test(app.downloadURL)) {
          warnings.push("downloadURL must be a valid HTTPS direct link.");
        }
        if (!app.iconURL) warnings.push("iconURL is missing.");

        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO applications (id, name, bundle_identifier, original_bundle_identifier, version, sha256, size_bytes, download_url, icon_url, metadata_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
             ON CONFLICT(sha256) DO UPDATE SET
               name=excluded.name,
               version=excluded.version,
               download_url=excluded.download_url,
               icon_url=excluded.icon_url,
               metadata_json=excluded.metadata_json,
               updated_at=datetime('now')`
          )
            .bind(
              app.id || crypto.randomUUID(),
              app.name || "Unknown",
              app.bundleIdentifier,
              app.originalBundleIdentifier || app.bundleIdentifier,
              app.version || "1.0",
              app.sha256,
              Number(app.size) || 0,
              app.downloadURL || "",
              app.iconURL || "",
              JSON.stringify(app)
            )
            .run();
        }
        return json({ ok: true, valid: warnings.length === 0, warnings });
      }

      // 3. AI Description Generator (Hallucination-guarded)
      if (url.pathname === "/api/ai/generate-description") {
        const { app, language = "en", mode = "research" } = body;
        if (!app?.name) return json({ error: "app.name is required" }, 400);

        const systemPrompt = `You are Pan AI, an iOS App Store metadata specialist.
Generate accurate, professional AltStore repository metadata in language "${language}".
CRITICAL RULES:
- Never invent or hallucinate features not grounded in known public facts about the app.
- If the app is obscure or modified, describe only verified functionality and mark unverified details clearly.
- Respond ONLY with valid JSON matching: {"subtitle":"string (max 45 chars)","developerName":"string","category":"string","description":"string (2-3 concise paragraphs)"}.`;

        const userPrompt =
          mode === "polish"
            ? `Improve clarity and grammar of this existing description without changing its factual meaning:\nApp: ${app.name} (${app.bundleIdentifier})\nExisting: ${app.existingDescription || ""}`
            : `Research and generate AltStore catalog metadata for:\nApp Name: ${app.name}\nBundle ID: ${app.bundleIdentifier}\nVersion: ${app.version || "1.0"}\nDeveloper Hint: ${app.developerName || "Unknown"}`;

        const raw = await runPanAI(env, systemPrompt, userPrompt);
        const parsed = extractJsonObject(raw);
        await logActivity(env, "Description Generator", `Generated ${language} metadata for ${app.name}`);
        return json({ ok: true, ...parsed });
      }

      // 4. AI Bundle ID Conflict Resolver
      if (url.pathname === "/api/ai/resolve-conflict") {
        const { conflictApps } = body;
        if (!Array.isArray(conflictApps) || conflictApps.length < 2) {
          return json({ error: "Provide at least 2 conflicting app entries" }, 400);
        }
        const systemPrompt = `You are Pan AI's iOS Bundle ID Conflict Engine.
Analyze conflicting IPA entries sharing a bundleIdentifier.
Remember: changing bundleIdentifier in AltStore JSON alone does NOT alter the Mach-O / Info.plist inside the IPA.
Respond ONLY with JSON: {"sameApplication":boolean,"recommendation":"merge_versions|repackage_ipa|manual_review","explanation":"string","suggestedAltStoreIdentifier":"string"}.`;

        const raw = await runPanAI(env, systemPrompt, JSON.stringify(conflictApps));
        return json({ ok: true, ...extractJsonObject(raw) });
      }

      // 5. AI Visual Icon Match Verification
      if (url.pathname === "/api/ai/match-icon") {
        const { appName, candidates } = body;
        return json({
          ok: true,
          appName,
          bestMatch: Array.isArray(candidates) && candidates.length ? candidates[0] : null,
        });
      }

      // 6. AI Studio Interactive Research & Audit
      if (url.pathname === "/api/ai/research-app") {
        const { prompt, sourceSummary } = body;
        if (!prompt) return json({ error: "prompt is required" }, 400);
        const systemPrompt = `You are Pan AI, the autonomous assistant for Pan's Mega Repo (an AltStore Classic repository). Be concise, technical, accurate, and never fabricate facts.`;
        const reply = await runPanAI(
          env,
          systemPrompt,
          `Repository Context: ${JSON.stringify(sourceSummary || {})}\n\nUser Request: ${prompt}`
        );
        return json({ ok: true, reply });
      }

      // 7. AltStore Classic Source Schema Validation
      if (url.pathname === "/api/source/validate") {
        const { source } = body;
        const errors = validateAltStoreJSON(source);
        return json({ ok: true, valid: errors.length === 0, errors });
      }

      // 8. Safe Atomic GitHub Commit with Automatic D1 Backup
      if (url.pathname === "/api/source/sync") {
        const { repo, branch = "main", path = "apps.json", message, source } = body;
        if (!env.GITHUB_TOKEN) {
          return json({ error: "GITHUB_TOKEN secret is not configured in Cloudflare Worker." }, 500);
        }
        if (!repo || !repo.includes("/")) {
          return json({ error: "Invalid repository slug (expected owner/repo)." }, 400);
        }
        const validationErrors = validateAltStoreJSON(source);
        if (validationErrors.length > 0) {
          return json({ error: "Source validation failed", details: validationErrors }, 422);
        }

        const ghHeaders = {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Pans-Mega-Repo-Worker",
          "Content-Type": "application/json",
        };

        const fileUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
        let currentSha = undefined;

        // Fetch existing file SHA to avoid blind overwrites & create backup
        const existingRes = await fetch(`${fileUrl}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders });
        if (existingRes.ok) {
          const existingData = await existingRes.json();
          currentSha = existingData.sha;
          if (env.DB && existingData.content) {
            await env.DB.prepare(
              `INSERT INTO source_backups (id, reason, content_base64, created_at) VALUES (?1, ?2, ?3, datetime('now'))`
            )
              .bind(crypto.randomUUID(), `Pre-commit backup (${currentSha})`, existingData.content)
              .run();
          }
        }

        const formattedJson = JSON.stringify(source, null, 2);
        const encodedContent = btoa(unescape(encodeURIComponent(formattedJson)));

        const putRes = await fetch(fileUrl, {
          method: "PUT",
          headers: ghHeaders,
          body: JSON.stringify({
            message: message || "chore(source): update apps.json via Pan AI",
            content: encodedContent,
            branch,
            sha: currentSha,
          }),
        });

        const putData = await putRes.json();
        if (!putRes.ok) {
          return json({ error: putData.message || `GitHub commit failed (${putRes.status})` }, putRes.status);
        }

        await logActivity(env, "GitHub Sync", `Committed ${path} to ${repo}@${branch} (${putData.commit?.sha})`);
        return json({ ok: true, commitSha: putData.commit?.sha, htmlUrl: putData.content?.html_url });
      }

      return json({ error: `Unknown endpoint: ${url.pathname}` }, 404);
    } catch (err) {
      return json({ error: err.message || "Internal Worker Error" }, 500);
    }
  },

  // Scheduled Background Maintenance (Cron Trigger)
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const { results } = await env.DB.prepare(`SELECT id, name, download_url, icon_url FROM applications`).all();
    for (const row of results || []) {
      if (row.download_url) {
        try {
          const head = await fetch(row.download_url, { method: "HEAD" });
          if (!head.ok) {
            await logActivity(env, "Maintenance", `Broken downloadURL (${head.status}) for ${row.name}`, "warn");
          }
        } catch {
          await logActivity(env, "Maintenance", `Unreachable downloadURL for ${row.name}`, "warn");
        }
      }
    }
  },
};

// --- HELPER FUNCTIONS ---
async function getAiConfig(env) {
  let kvCfg = {};
  if (env.KV) {
    kvCfg = JSON.parse((await env.KV.get("pan_ai_config")) || "{}");
  }
  const provider = kvCfg.provider || env.DEFAULT_AI_PROVIDER || "gemini";
  const keyMap = {
    gemini: kvCfg.apiKey || env.GEMINI_API_KEY,
    openai: kvCfg.apiKey || env.OPENAI_API_KEY,
    anthropic: kvCfg.apiKey || env.ANTHROPIC_API_KEY,
    openrouter: kvCfg.apiKey || env.OPENROUTER_API_KEY,
    custom: kvCfg.apiKey || env.CUSTOM_AI_API_KEY,
  };
  return {
    enabled: kvCfg.enabled !== false,
    provider,
    model: kvCfg.model || "gemini-2.5-flash",
    apiKey: keyMap[provider] || "",
    customEndpoint: kvCfg.customEndpoint || "",
    temperature: kvCfg.temperature ?? 0.2,
    maxTokens: kvCfg.maxTokens ?? 2048,
  };
}

async function runPanAI(env, systemPrompt, userPrompt) {
  const cfg = await getAiConfig(env);
  if (!cfg.enabled) throw new Error("Pan AI is disabled in Settings.");
  if (!cfg.apiKey) throw new Error(`API key for provider "${cfg.provider}" is not configured.`);

  if (cfg.provider === "gemini") {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxTokens },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  if (cfg.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        system: systemPrompt,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Anthropic API error ${res.status}`);
    return data.content?.[0]?.text || "";
  }

  // OpenAI, OpenRouter, or Custom OpenAI-compatible endpoint
  const endpoint =
    cfg.provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : cfg.provider === "custom" && cfg.customEndpoint
      ? cfg.customEndpoint
      : "https://api.openai.com/v1/chat/completions";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `AI Provider error ${res.status}`);
  return data.choices?.[0]?.message?.content || "";
}

function extractJsonObject(text) {
  const clean = text.replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) return { description: clean };
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return { description: clean };
  }
}

function validateAltStoreJSON(source) {
  const errors = [];
  if (!source || typeof source !== "object") return ["Source must be a JSON object."];
  if (!source.name) errors.push("Missing source.name");
  if (!source.identifier) errors.push("Missing source.identifier");
  if (!Array.isArray(source.apps)) errors.push("source.apps must be an array");
  (source.apps || []).forEach((app, i) => {
    if (!app.name) errors.push(`apps[${i}] missing name`);
    if (!app.bundleIdentifier) errors.push(`apps[${i}] missing bundleIdentifier`);
    if (!Array.isArray(app.versions) || !app.versions.length) {
      errors.push(`apps[${i}] (${app.name}) must have at least one version`);
    } else if (!app.versions[0].downloadURL) {
      errors.push(`apps[${i}] (${app.name}) missing versions[0].downloadURL`);
    }
  });
  return errors;
}

async function logActivity(env, category, message, level = "info") {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO activity_logs (id, category, message, level, created_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))`
  )
    .bind(crypto.randomUUID(), category, message, level)
    .run()
    .catch(() => {});
}