// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE SYNC
// Lets the user sign in with their Google account and back up / restore their
// project data to a private space in their own Google Drive (the "appDataFolder",
// which is invisible in the normal Drive UI and only accessible by this app).
//
// This means: if the user logs out, clears the browser, or reinstalls the PWA,
// they can sign back in with the same Google account and restore everything.
//
// IMPORTANT — setup required before this works:
// You must create a free Google Cloud OAuth Client ID and paste it into
// GOOGLE_CLIENT_ID below. Steps:
//   1. Go to https://console.cloud.google.com/apis/credentials
//   2. Create an OAuth 2.0 Client ID, type "Web application"
//   3. Add your app's URL (e.g. https://yourapp.netlify.app) under
//      "Authorized JavaScript origins"
//   4. Enable the "Google Drive API" in the project
//   5. Copy the generated Client ID string into GOOGLE_CLIENT_ID below
// Until this is configured, the Google Drive sync button will show a clear
// setup-required message instead of failing silently.
// ═══════════════════════════════════════════════════════════════════════════════

export const GOOGLE_CLIENT_ID = "149463679522-7ckkfndj9ejd418glr8tptsdiksbhlcu.apps.googleusercontent.com";

const DRIVE_FILE_NAME = "mpm-backup.json";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";

let gisLoaded = false;
let tokenClient = null;
let currentToken = null;

// ─── Load Google Identity Services script once ────────────────────────────────
function loadGIS() {
  return new Promise((resolve, reject) => {
    if (gisLoaded && window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => { gisLoaded = true; resolve(); };
    script.onerror = () => reject(new Error("Failed to load Google Sign-In script. Check your internet connection."));
    document.head.appendChild(script);
  });
}

// ─── Public: is Google Drive sync configured by the developer? ───────────────
export function isGoogleSyncConfigured() {
  return !!GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID.length > 10;
}

// ─── Public: sign in, returns { email, name, picture } on success ────────────
export async function signInWithGoogle() {
  if (!isGoogleSyncConfigured()) {
    throw new Error(
      "Google Drive sync isn't set up yet. The developer needs to add a Google " +
      "OAuth Client ID to enable this feature. See mosParser setup notes."
    );
  }
  await loadGIS();

  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES + " https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
      callback: async (response) => {
        if (response.error) { reject(new Error(response.error)); return; }
        currentToken = response.access_token;
        try {
          // Fetch basic profile info to show "signed in as ..."
          const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${currentToken}` },
          });
          const profile = await profileRes.json();
          resolve({ email: profile.email, name: profile.name, picture: profile.picture, token: currentToken });
        } catch (err) {
          reject(err);
        }
      },
    });
    tokenClient.requestAccessToken();
  });
}

// ─── Public: sign out (revokes the local token; doesn't touch the Drive file) ─
export function signOutGoogle() {
  if (currentToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(currentToken, () => {});
  }
  currentToken = null;
}

// ─── Internal: find existing backup file in appDataFolder, if any ────────────
async function findBackupFile(token) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${DRIVE_FILE_NAME}'&fields=files(id,modifiedTime)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("Could not reach Google Drive. Please try again.");
  const data = await res.json();
  return data.files?.[0] || null;
}

// ─── Public: upload current app data to the user's Drive appDataFolder ───────
export async function backupToGoogleDrive(token, data) {
  const existing = await findBackupFile(token);
  const payload = JSON.stringify({ __version: 1, __app: "MechanicalProjectsManager", __syncedAt: new Date().toISOString(), ...data });

  const metadata = existing
    ? { name: DRIVE_FILE_NAME }
    : { name: DRIVE_FILE_NAME, parents: ["appDataFolder"] };

  const boundary = "mpm_boundary_" + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;

  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error("Upload to Google Drive failed. Please try again.");
  return true;
}

// ─── Public: download backup data from the user's Drive appDataFolder ────────
// Returns null if no backup exists yet (e.g. first time signing in on this account).
export async function restoreFromGoogleDrive(token) {
  const existing = await findBackupFile(token);
  if (!existing) return null;

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("Could not download backup from Google Drive.");
  const parsed = await res.json();
  const { __version, __app, __syncedAt, ...projectData } = parsed;
  return { data: projectData, syncedAt: __syncedAt };
}
