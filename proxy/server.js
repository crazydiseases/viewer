// Small CORS / header proxy for the EPG viewer's "Watch" feature.
//
// Why this exists: browsers can't fetch most IPTV stream URLs or playlist
// endpoints directly from a page on a different origin (github.io) because
// the IPTV panel doesn't send CORS headers, and some panels also expect a
// specific User-Agent/Referer that a <video>/hls.js request can't set.
// This service fetches on the server side (no CORS/headers problem there)
// and re-serves the response to the browser with CORS allowed.
//
// Routes:
//   GET /healthz                        -> liveness check, no auth
//   GET /raw?url=...&key=...            -> plain passthrough (for fetching
//                                          an M3U playlist's text so the
//                                          browser can parse channel entries)
//   GET /stream?url=...&key=...         -> HLS-aware passthrough: rewrites
//                                          .m3u8 manifests so every segment/
//                                          sub-playlist URL inside them also
//                                          routes back through this proxy
//
// Every route (other than /healthz) requires a `key` query param matching
// the PROXY_KEY environment variable, so this doesn't become an open relay
// for anyone who finds the Railway URL.

const express = require("express");

const app = express();
app.disable("x-powered-by");

const PORT = process.env.PORT || 8080;
const PROXY_KEY = process.env.PROXY_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const USER_AGENT =
  process.env.PROXY_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REFERER = process.env.PROXY_REFERER || "";
const FETCH_TIMEOUT_MS = 25000;

function setCors(res) {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Range, Content-Type");
  res.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
}

app.use((req, res, next) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/healthz", (req, res) => res.status(200).send("ok"));

function checkKey(req, res) {
  if (!PROXY_KEY) {
    res.status(500).send("Server misconfigured: PROXY_KEY is not set.");
    return false;
  }
  if (req.query.key !== PROXY_KEY) {
    res.status(403).send("Forbidden: missing or incorrect key.");
    return false;
  }
  return true;
}

function parseTargetUrl(raw, res) {
  if (!raw) {
    res.status(400).send("Missing url parameter.");
    return null;
  }
  let target;
  try {
    target = new URL(raw);
  } catch {
    res.status(400).send("Invalid url parameter.");
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    res.status(400).send("Only http/https URLs are allowed.");
    return null;
  }
  const host = target.hostname.toLowerCase();
  const isPrivate =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (isPrivate) {
    res.status(400).send("Refusing to fetch a private/internal address.");
    return null;
  }
  return target;
}

async function fetchUpstream(target, req) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "*/*",
  };
  if (REFERER) headers["Referer"] = REFERER;
  if (req.headers["range"]) headers["Range"] = req.headers["range"];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(target.toString(), {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    return upstream;
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikePlaylist(target, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("vnd.apple.mpegurl")) return true;
  return /\.m3u8(\?|$)/i.test(target.pathname + target.search);
}

function buildProxyStreamUrl(req, absoluteUrl) {
  const base = `${req.protocol}://${req.get("host")}`;
  const qs = new URLSearchParams({ url: absoluteUrl, key: req.query.key || "" });
  return `${base}/stream?${qs.toString()}`;
}

// Rewrite a .m3u8 manifest so every URI it references (segments, variant
// playlists, encryption keys, alternate media) is resolved to an absolute
// URL and routed back through /stream, so the player never talks to the
// upstream host directly.
function rewritePlaylist(text, target, req) {
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    if (line.startsWith("#")) {
      // Rewrite URI="..." attributes used by tags like EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        try {
          const abs = new URL(uri, target).toString();
          return `URI="${buildProxyStreamUrl(req, abs)}"`;
        } catch {
          return m;
        }
      });
    }
    const trimmed = line.trim();
    if (!trimmed) return line;
    try {
      const abs = new URL(trimmed, target).toString();
      return buildProxyStreamUrl(req, abs);
    } catch {
      return line;
    }
  });
  return out.join("\n");
}

app.get("/raw", async (req, res) => {
  if (!checkKey(req, res)) return;
  const target = parseTargetUrl(req.query.url, res);
  if (!target) return;
  try {
    const upstream = await fetchUpstream(target, req);
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).send("Upstream fetch failed: " + (err && err.message ? err.message : String(err)));
  }
});

app.get("/stream", async (req, res) => {
  if (!checkKey(req, res)) return;
  const target = parseTargetUrl(req.query.url, res);
  if (!target) return;

  try {
    const upstream = await fetchUpstream(target, req);
    const contentType = upstream.headers.get("content-type");

    if (looksLikePlaylist(target, contentType)) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, target, req);
      res.status(upstream.status);
      res.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.set("Cache-Control", "no-store");
      res.send(rewritten);
      return;
    }

    // Binary passthrough: segments (.ts/.m4s/.mp4/.aac/...), with range support.
    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    req.on("close", () => {
      try { reader.cancel(); } catch {}
    });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send("Upstream fetch failed: " + (err && err.message ? err.message : String(err)));
    } else {
      res.end();
    }
  }
});

app.get("/", (req, res) => {
  res.status(200).send("EPG stream proxy is running. See /healthz, /raw, /stream.");
});

app.listen(PORT, () => {
  console.log(`epg-stream-proxy listening on :${PORT}`);
  if (!PROXY_KEY) {
    console.warn("WARNING: PROXY_KEY is not set — /raw and /stream will refuse all requests until it is.");
  }
});
