// ---------------------------------------------------------------------------
// Mints the awkward half of the credentials: the Music-User-Token.
//
//   bun run token           # writes music-token.html, prints instructions
//   bun run token --serve   # also serves it on http://localhost:8899
//
// Apple only issues a user token to MusicKit JS in a real browser, so there is
// no headless option.
//
// Why NOT just paste a snippet into the console at music.apple.com? Because
// Apple's own player has already called MusicKit.configure() with Apple's
// developer token. A second configure() hands back that existing instance, so
// the user token you receive is bound to Apple's app - and every request you
// make with YOUR developer token comes back 403 "Invalid authentication".
// We need a page where MusicKit has not been configured yet, hence the HTML.
//
// The user token is bound to the developer token that requested it, so the page
// bakes in OURS.
//
// Bun loads .env automatically, so no dotenv import is needed.
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { getDeveloperToken } from "./appleMusic";

const APP_NAME = "AppleMusicSorter";
const APP_BUILD = "1.0.0";
const PORT = 8899;
const OUT_FILE = "music-token.html";

/** The standalone page that authorizes MusicKit and reveals the user token. */
export function buildPage(developerToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Apple Music user token</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; }
  button { font: inherit; padding: .5rem 1.1rem; border-radius: .5rem; border: 0; background: #fa2d48; color: #fff; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  textarea { width: 100%; box-sizing: border-box; margin-top: 1rem; font: 12px/1.4 ui-monospace, monospace; }
  #status { min-height: 1.5em; }
  .err { color: #c00; }
  .ok { color: #0a0; }
</style>
</head>
<body>
  <h1>Apple Music user token</h1>
  <p>Sign in to Apple Music when the popup appears. Requires an active subscription.</p>
  <button id="go" disabled>Authorize</button>
  <p id="status">Loading MusicKit\u2026</p>
  <textarea id="out" rows="4" readonly hidden></textarea>
  <script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js"></script>
  <script>
    const DEVELOPER_TOKEN = ${JSON.stringify(developerToken)};
    const statusEl = document.getElementById("status");
    const button = document.getElementById("go");
    const out = document.getElementById("out");

    function fail(message) {
      statusEl.className = "err";
      statusEl.textContent = message;
    }

    window.addEventListener("load", async () => {
      try {
        const music = await MusicKit.configure({
          developerToken: DEVELOPER_TOKEN,
          app: { name: ${JSON.stringify(APP_NAME)}, build: ${JSON.stringify(APP_BUILD)} },
        });

        statusEl.textContent = "Ready. Click Authorize.";
        button.disabled = false;

        button.onclick = async () => {
          button.disabled = true;
          statusEl.className = "";
          statusEl.textContent = "Waiting for Apple\\u2026";
          try {
            await music.authorize();
            const userToken = music.musicUserToken;
            if (!userToken) throw new Error("authorize() returned no token");
            out.hidden = false;
            out.value = "APPLE_MUSIC_USER_TOKEN=" + userToken;
            out.select();
            statusEl.className = "ok";
            try {
              await navigator.clipboard.writeText(out.value);
              statusEl.textContent = "Copied to clipboard - paste it into .env.";
            } catch {
              statusEl.textContent = "Copy the value below into .env.";
            }
          } catch (err) {
            fail("Authorization failed: " + (err && err.message ? err.message : err));
            button.disabled = false;
          }
        };
      } catch (err) {
        fail("MusicKit failed to load: " + (err && err.message ? err.message : err));
      }
    });
  </script>
</body>
</html>`;
}

try {
  const developerToken = await getDeveloperToken();
  const page = buildPage(developerToken);
  writeFileSync(OUT_FILE, page, "utf8");

  const serve = process.argv.includes("--serve") || process.env.SERVE === "1";

  if (serve) {
    createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
    }).listen(PORT, "127.0.0.1", () => {
      console.log(`How to get APPLE_MUSIC_USER_TOKEN:\n`);
      console.log(`  1. Open http://localhost:${PORT} in your browser.`);
      console.log("  2. Click Authorize and sign in to Apple Music.");
      console.log("  3. Paste the value it shows into .env as APPLE_MUSIC_USER_TOKEN.");
      console.log(`\nCtrl-C to stop. (The page is also saved as ${OUT_FILE}.)`);
    });
  } else {
    console.log("How to get APPLE_MUSIC_USER_TOKEN:\n");
    console.log(`  1. Serve the generated ${OUT_FILE} over http - file:// usually breaks`);
    console.log("     Apple's sign-in popup. Either:");
    console.log(`       python3 -m http.server ${PORT}`);
    console.log(`     or re-run this script with: bun run token --serve`);
    console.log(`  2. Open http://localhost:${PORT}/${OUT_FILE}`);
    console.log("  3. Click Authorize, sign in, then paste the value into .env.\n");
    console.log(`Page written to ${OUT_FILE} (git-ignored).`);
  }
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`Could not build the developer token: ${reason}`);
  process.exit(1);
}
