const http = require("http");
const fs = require("fs");
const https = require("https");
const { createAppAuth } = require("@octokit/auth-app");

const PORT = 8080;
const SAFETY_WINDOW_MS = 5 * 60 * 1000;

// ---- GitHub App ----
let githubAuth = null;
function getGitHubAuth() {
  if (!githubAuth) {
    const privateKey = fs.readFileSync(
      process.env.GITHUB_APP_PRIVATE_KEY_PATH,
      "utf8",
    );
    githubAuth = createAppAuth({
      appId: process.env.GITHUB_APP_ID,
      privateKey,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    });
  }
  return githubAuth;
}

let githubTokenCache = null;
async function mintGitHubToken() {
  if (
    githubTokenCache &&
    new Date(githubTokenCache.expiresAt) - Date.now() > SAFETY_WINDOW_MS
  ) {
    return githubTokenCache;
  }
  const auth = getGitHubAuth();
  const t = await auth({ type: "installation" });
  githubTokenCache = { token: t.token, expiresAt: t.expiresAt };
  return githubTokenCache;
}

// Cached for the broker's lifetime. If you rename the GitHub App,
// restart the broker to refresh.
let identityCache = null;
async function getGitHubIdentity() {
  if (identityCache) return identityCache;

  const auth = getGitHubAuth();
  const { token: appJwt } = await auth({ type: "app" });

  const appInfo = await ghGet("/app", `Bearer ${appJwt}`);
  const slug = appInfo.slug;

  const botUser = await ghGet(`/users/${slug}%5Bbot%5D`, `Bearer ${appJwt}`);

  identityCache = {
    name: `${slug}[bot]`,
    email: `${botUser.id}+${slug}[bot]@users.noreply.github.com`,
  };
  return identityCache;
}

// Note: broker makes direct outbound calls to api.github.com and
// api.cloudflare.com without going through the proxy — routing through the
// proxy would be circular since the proxy fetches credentials from the broker.
// Broker destinations are limited to those two hosts; verify in server.js.
function ghGet(path, authHeader) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host: "api.github.com",
          path,
          headers: {
            Authorization: authHeader,
            "User-Agent": "agent-broker",
            Accept: "application/vnd.github+json",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode >= 400)
                reject(new Error(`GitHub ${res.statusCode}: ${data}`));
              else resolve(parsed);
            } catch (e) {
              reject(e);
            }
          });
        },
      )
      .on("error", reject);
  });
}

// ---- Anthropic (static key) ----
function getAnthropicKey() {
  return fs.readFileSync(process.env.ANTHROPIC_API_KEY_PATH, "utf8").trim();
}

// ---- Cloudflare (mint scoped tokens) ----
const cloudflareTokenCache = new Map();

async function mintCloudflareToken(profile) {
  const cached = cloudflareTokenCache.get(profile);
  if (cached && new Date(cached.expiresAt) - Date.now() > SAFETY_WINDOW_MS) {
    return cached;
  }

  // Profile definitions. Permission group IDs come from:
  //   GET https://api.cloudflare.com/client/v4/user/tokens/permission_groups
  const profiles = {
    "workers-deploy": {
      permission_groups: [{ id: "e086da7e2179491d91ee5f35b3ca210a" }], // Workers Scripts:Edit
      resources: { "com.cloudflare.api.account.*": "*" },
    },
    // Add more profiles here. Example:
    // 'dns-edit': {
    //   permission_groups: [{ id: '<DNS_WRITE_ID>' }],
    //   resources: { 'com.cloudflare.api.account.zone.<ZONE_ID>': '*' },
    // },
  };

  const profileDef = profiles[profile];
  if (!profileDef) throw new Error(`Unknown Cloudflare profile: ${profile}`);

  const minterToken = fs
    .readFileSync(process.env.CLOUDFLARE_MINTER_TOKEN_PATH, "utf8")
    .trim();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const body = JSON.stringify({
    name: `agent-${profile}-${stamp}`,
    policies: [
      {
        effect: "allow",
        resources: profileDef.resources,
        permission_groups: profileDef.permission_groups,
      },
    ],
    expires_on: expiresAt,
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.cloudflare.com/client/v4/user/tokens",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minterToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (!result.success)
    throw new Error(`Cloudflare API error: ${JSON.stringify(result.errors)}`);

  // Expired tokens accumulate as inactive entries in Cloudflare dashboard.
  // They are inert (no security risk) but can be pruned manually:
  //   dashboard → Profile → API Tokens → delete agent-* entries with past dates
  const entry = { token: result.result.value, expiresAt };
  cloudflareTokenCache.set(profile, entry);
  return entry;
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  const send = (status, obj, contentType = "application/json") => {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
  };

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/healthz") {
      return send(200, { ok: true });
    }

    if (url.pathname === "/github/token") {
      const t = await mintGitHubToken();
      console.log(`[broker] issued github token (expires ${t.expiresAt})`);
      return send(200, t);
    }

    if (url.pathname === "/github/credential") {
      const t = await mintGitHubToken();
      console.log(`[broker] issued github credential (expires ${t.expiresAt})`);
      return send(
        200,
        `username=x-access-token\npassword=${t.token}\n`,
        "text/plain",
      );
    }

    if (url.pathname === "/github/identity") {
      const id = await getGitHubIdentity();
      console.log(`[broker] issued github identity ${id.name}`);
      return send(200, id);
    }

    if (url.pathname === "/anthropic/key") {
      // Reachable only from the proxy on the `secure` network.
      // cred-gateway does not whitelist this path, so dev cannot reach it.
      console.log("[broker] issued anthropic key to proxy");
      return send(200, { key: getAnthropicKey() });
    }

    if (url.pathname === "/cloudflare/token") {
      const profile = url.searchParams.get("profile");
      if (!profile) return send(400, { error: "profile parameter required" });
      const t = await mintCloudflareToken(profile);
      console.log(
        `[broker] issued cloudflare token profile=${profile} (expires ${t.expiresAt})`,
      );
      return send(200, t);
    }

    return send(404, { error: "not found" });
  } catch (err) {
    console.error("[broker] error:", err);
    return send(500, { error: String(err.message || err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[broker] listening on :${PORT}`);
});
