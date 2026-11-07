// AvgSoft's Railway template for Paperclip: first admin from the deploy form.
//
// Runs before Paperclip starts. Paperclip itself has no variable for a first admin:
// in authenticated/private mode the first signed-in user claims the instance. So on an
// instance with no admin yet, this starts Paperclip once on 127.0.0.1 (the public domain
// can't reach it) with sign-ups open, signs ADMIN_EMAIL up through Paperclip's own API,
// claims the instance for that account, and stops it. The real start that follows keeps
// PAPERCLIP_AUTH_DISABLE_SIGN_UP=true, so nobody can sign up or claim from outside.
// Never prints the password. Never fails the deploy: on a problem it logs why and lets
// Paperclip start; fix the variable and redeploy to try again.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const log = (message) => console.log(`[admin-setup] ${message}`);
const home = process.env.PAPERCLIP_HOME || "/paperclip";
const marker = path.join(home, ".admin-created");
const port = 3199;
const base = `http://127.0.0.1:${port}`;

if (fs.existsSync(marker)) process.exit(0);

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
const publicUrl = (process.env.PAPERCLIP_PUBLIC_URL || "").trim().replace(/\/+$/, "");

function stop(reason) {
  log(`${reason} No admin created; Paperclip starts with sign-ups closed. Fix it in Variables and redeploy.`);
  process.exit(0);
}
if (!email || !email.includes("@")) stop("ADMIN_EMAIL is empty or not an email address.");
if (password.length < 8 || password.length > 128) stop("ADMIN_PASSWORD must be 8 to 128 characters.");
if (!publicUrl.startsWith("https://")) stop("PAPERCLIP_PUBLIC_URL is not an https URL (does the service have a public domain?).");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const origin = new URL(publicUrl).origin;

log("No admin yet: starting Paperclip once on 127.0.0.1 to create it.");
const child = spawn(
  process.execPath,
  // The image's own start: Paperclip 2026.1106 and later boot from a precompiled bundle, older ones from the tsx build.
  fs.existsSync("/app/server/dist-runtime/index.mjs")
    ? ["server/dist-runtime/index.mjs"]
    : ["--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"],
  {
    cwd: "/app",
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PAPERCLIP_BIND: "loopback",
      PORT: String(port),
      PAPERCLIP_AUTH_DISABLE_SIGN_UP: "false",
    },
  },
);
let exited = false;
child.on("exit", () => { exited = true; });

async function stopChild() {
  if (exited) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 60 && !exited; i++) await sleep(500);
  if (!exited) child.kill("SIGKILL");
}

async function post(pathname, body, cookie) {
  const headers = { "content-type": "application/json", origin };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + pathname, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, text, cookies };
}

async function main() {
  let health = null;
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { health = await res.json(); break; }
    } catch {}
    await sleep(2000);
  }
  if (!health) { log("Paperclip didn't answer on 127.0.0.1 within 4 minutes; skipping."); return; }
  if (health.bootstrapStatus === "ready") {
    log("This instance already has an admin.");
    fs.writeFileSync(marker, new Date().toISOString() + "\n");
    return;
  }

  const name = email.split("@")[0];
  let session = await post("/api/auth/sign-up/email", { email, password, name });
  if (session.status !== 200) {
    // The account may exist from an earlier attempt: sign in instead.
    const signIn = await post("/api/auth/sign-in/email", { email, password });
    if (signIn.status !== 200) {
      log(`Sign-up failed (${session.status}: ${session.text.slice(0, 200)}) and sign-in failed (${signIn.status}).`);
      return;
    }
    session = signIn;
  }
  if (!session.cookies) { log("Sign-up returned no session cookie."); return; }

  const claim = await post("/api/bootstrap/claim", {}, session.cookies);
  if (claim.status === 200 || claim.status === 409) {
    log(claim.status === 200 ? `Admin created: ${email}` : "This instance already has an admin.");
    fs.writeFileSync(marker, new Date().toISOString() + "\n");
    return;
  }
  log(`Claiming the instance failed (${claim.status}: ${claim.text.slice(0, 200)}).`);
}

try {
  await main();
} catch (error) {
  log(`Unexpected error: ${error?.message || error}`);
} finally {
  await stopChild();
  log("Starting Paperclip.");
  process.exit(0);
}
