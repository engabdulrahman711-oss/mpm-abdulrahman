import { useState, useEffect, useRef, useCallback } from "react";
// mosParser is lazy-loaded (dynamic import) inside MOSImportModal to keep the
// initial app bundle small — pdfjs-dist + mammoth are large libraries only
// needed when a user actually opens the MOS import feature.

// ─── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_KEY   = "mpm-data-v2";
const PROFILE_KEY   = "mpm-profile-v1";
const THEME_KEY     = "mpm-theme-v1";
const NOTIF_KEY     = "mpm-notif-dismissed-v1";
const NAV_KEY       = "mpm-nav-state-v1";   // remembers which project + tab user was viewing
const TAB_ORDER_KEY = "mpm-tab-order-v1";   // remembers custom order of project detail tabs
const GOOGLE_ACCOUNT_KEY = "mpm-google-account-v1"; // remembers which Google account is linked (display info only — never the token)
const AUTO_BACKUP_KEY = "mpm-auto-backup-v1"; // tracks when the last automatic local backup file was downloaded
const ROLLOVER_KEY   = "mpm-rollover-v1";    // tracks which date we last ran the end-of-day rollover check

// ─── Image compression helper ─────────────────────────────────────────────────
// Compress a base64 image to max ~200KB JPEG before storing
const compressImage = (base64, maxW=800, quality=0.7) => new Promise(resolve => {
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, maxW / Math.max(img.width, img.height));
    const w = Math.round(img.width  * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    resolve(canvas.toDataURL("image/jpeg", quality));
  };
  img.onerror = () => resolve(base64); // fallback: keep original
  img.src = base64;
});

// ─── IndexedDB for images (no size limit) ─────────────────────────────────────
const IDB_NAME = "mpm-images-v1";
const IDB_STORE = "images";

const openIDB = () => new Promise((res, rej) => {
  const req = indexedDB.open(IDB_NAME, 1);
  req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
  req.onsuccess = e => res(e.target.result);
  req.onerror   = e => rej(e.target.error);
});

const idbSet = async (key, val) => {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = res; tx.onerror = rej;
  });
};

const idbGet = async (key) => {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = e => res(e.target.result ?? null);
    req.onerror   = rej;
  });
};

const idbDelete = async (key) => {
  try {
    const db = await openIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch { /* best-effort cleanup — never block the UI on this */ }
};

// ─── Extract / restore images from project data ───────────────────────────────
// Before saving: pull out all image blobs → store in IDB → replace with placeholder keys
// After loading: pull keys from data → load blobs from IDB → put back

const COVER_KEY = (id) => `cover::${id}`;
const IMG_KEY   = (id, imgId) => `img::${id}::${imgId}`;
const MOS_FILE_KEY = (projectId, stepId) => `mosfile::${projectId}::${stepId}`;
const TASK_NOTE_IMG_KEY = (projectId, taskId, imgId) => `tasknoteimg::${projectId}::${taskId}::${imgId}`;

const extractAndSaveImages = async (projects) => {
  const stripped = await Promise.all(projects.map(async (p) => {
    const proj = {...p, images: (p.images||[]).map(i => ({...i})), steps: (p.steps||[]).map(s => ({...s})),
                  tasks: { ...(p.tasks||{}), daily: ((p.tasks||{}).daily||[]).map(t => ({...t})) }};
    // Cover image
    if (proj.coverImage && proj.coverImage.startsWith("data:")) {
      const compressed = await compressImage(proj.coverImage, 1200, 0.75);
      await idbSet(COVER_KEY(p.id), compressed);
      proj.coverImage = COVER_KEY(p.id); // store key, not blob
    }
    // Gallery images
    proj.images = await Promise.all((proj.images||[]).map(async (img) => {
      if (img.src && img.src.startsWith("data:")) {
        const compressed = await compressImage(img.src, 1000, 0.70);
        await idbSet(IMG_KEY(p.id, img.id), compressed);
        return {...img, src: IMG_KEY(p.id, img.id)};
      }
      return img;
    }));
    // Per-step MOS file attachments — these are PDFs/DOCX, not images, so no
    // compression; stored as raw base64 data URLs in IDB (no size limit there).
    proj.steps = await Promise.all((proj.steps||[]).map(async (step) => {
      if (step.mosFile && step.mosFile.data && step.mosFile.data.startsWith("data:")) {
        const key = MOS_FILE_KEY(p.id, step.id);
        await idbSet(key, step.mosFile.data);
        return { ...step, mosFile: { ...step.mosFile, data: key } }; // store key, not the raw blob
      }
      return step;
    }));
    // Daily task note images — same compression approach as gallery photos
    proj.tasks.daily = await Promise.all((proj.tasks.daily||[]).map(async (t) => {
      if (!t.noteImages || t.noteImages.length === 0) return t;
      const noteImages = await Promise.all(t.noteImages.map(async (img) => {
        if (img.src && img.src.startsWith("data:")) {
          const compressed = await compressImage(img.src, 1000, 0.70);
          const key = TASK_NOTE_IMG_KEY(p.id, t.id, img.id);
          await idbSet(key, compressed);
          return {...img, src: key};
        }
        return img;
      }));
      return {...t, noteImages};
    }));
    return proj;
  }));
  return stripped;
};

const restoreImages = async (projects) => {
  return Promise.all(projects.map(async (p) => {
    const proj = {...p, images: (p.images||[]).map(i => ({...i})), steps: (p.steps||[]).map(s => ({...s})),
                  tasks: { ...(p.tasks||{}), daily: ((p.tasks||{}).daily||[]).map(t => ({...t})) }};
    // Cover
    if (proj.coverImage && proj.coverImage.startsWith("cover::")) {
      proj.coverImage = await idbGet(proj.coverImage) ?? null;
    }
    // Gallery
    proj.images = await Promise.all((proj.images||[]).map(async (img) => {
      if (img.src && img.src.startsWith("img::")) {
        return {...img, src: await idbGet(img.src) ?? ""};
      }
      return img;
    }));
    // Per-step MOS file attachments
    proj.steps = await Promise.all((proj.steps||[]).map(async (step) => {
      if (step.mosFile && step.mosFile.data && step.mosFile.data.startsWith("mosfile::")) {
        const data = await idbGet(step.mosFile.data) ?? null;
        return { ...step, mosFile: { ...step.mosFile, data } };
      }
      return step;
    }));
    // Daily task note images
    proj.tasks.daily = await Promise.all((proj.tasks.daily||[]).map(async (t) => {
      if (!t.noteImages || t.noteImages.length === 0) return t;
      const noteImages = await Promise.all(t.noteImages.map(async (img) => {
        if (img.src && img.src.startsWith("tasknoteimg::")) {
          return {...img, src: await idbGet(img.src) ?? ""};
        }
        return img;
      }));
      return {...t, noteImages};
    }));
    return proj;
  }));
};

// ─── Core storage (text-only, no images) ──────────────────────────────────────
let _saveInProgress = false;
let _pendingSave    = null;

const saveData = async (d) => {
  // Serialize save calls: if one is running, queue the latest and skip
  if (_saveInProgress) { _pendingSave = d; return; }
  _saveInProgress = true;
  try {
    const stripped = await extractAndSaveImages(d.projects || []);
    const payload  = JSON.stringify({...d, projects: stripped});
    localStorage.setItem(STORAGE_KEY, payload);
  } catch (err) {
    // localStorage quota exceeded — show user a warning
    console.error("Save failed:", err);
    if (err && err.name === "QuotaExceededError") {
      // Non-blocking alert
      setTimeout(() => alert(
        "⚠️ Storage full!\n\nThe app could not save your data.\n" +
        "Please go to Export (⇅) and download a backup immediately,\n" +
        "then clear some space by removing unused projects or photos."
      ), 100);
    }
  } finally {
    _saveInProgress = false;
    if (_pendingSave) { const p = _pendingSave; _pendingSave = null; saveData(p); }
  }
};

// ─── Debounced save ────────────────────────────────────────────────────────────
// saveData() is expensive: it walks EVERY image and MOS file attachment across
// EVERY project (compressing images, reading/writing IndexedDB) on every call.
// If something calls it on every keystroke (e.g. typing in a procurement item
// name), that heavy walk runs per-character and the input visibly lags behind
// what's typed. _commit() below already updates React state synchronously (so
// typing always feels instant), but the actual persistence to localStorage/IDB
// is debounced here — it waits until 500ms have passed with no further updates
// before actually writing, coalescing rapid keystrokes into a single save.
let _saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 500;

const saveDataDebounced = (d) => {
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(() => {
    _saveDebounceTimer = null;
    saveData(d);
  }, SAVE_DEBOUNCE_MS);
};

// Forces any pending debounced save to run immediately — used right before the
// app might lose focus (backgrounding, closing) so we never lose the last
// few hundred milliseconds of typing.
const flushPendingSave = (d) => {
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }
  saveData(d);
};

const loadData = async () => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    const parsed = JSON.parse(v);
    // Restore images from IDB back into project objects
    parsed.projects = await restoreImages(parsed.projects || []);
    return parsed;
  } catch { return null; }
};

const loadProf  = () => { try { const v = localStorage.getItem(PROFILE_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveProf  = (p) => { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} };
const loadTheme = () => { try { const v = localStorage.getItem(THEME_KEY); return v || "navy"; } catch { return "navy"; } };
const saveTheme = (t) => { try { localStorage.setItem(THEME_KEY, t); } catch {} };
const loadDismissed = () => { try { const v = localStorage.getItem(NOTIF_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveDismissed = (d) => { try { localStorage.setItem(NOTIF_KEY, JSON.stringify(d)); } catch {} };
const loadNavState  = () => { try { const v = localStorage.getItem(NAV_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveNavState  = (n) => { try { localStorage.setItem(NAV_KEY, JSON.stringify(n)); } catch {} };
const loadTabOrder  = () => { try { const v = localStorage.getItem(TAB_ORDER_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveTabOrder  = (order) => { try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order)); } catch {} };
const loadGoogleAccount = () => { try { const v = localStorage.getItem(GOOGLE_ACCOUNT_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveGoogleAccount = (acc) => { try { acc ? localStorage.setItem(GOOGLE_ACCOUNT_KEY, JSON.stringify(acc)) : localStorage.removeItem(GOOGLE_ACCOUNT_KEY); } catch {} };
const loadAutoBackupState = () => { try { const v = localStorage.getItem(AUTO_BACKUP_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveAutoBackupState = (s) => { try { localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(s)); } catch {} };
const loadRolloverState = () => { try { const v = localStorage.getItem(ROLLOVER_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveRolloverState = (s) => { try { localStorage.setItem(ROLLOVER_KEY, JSON.stringify(s)); } catch {} };

// ─── THEMES ───────────────────────────────────────────────────────────────────
const THEMES = {
  navy: {
    name: "Navy Steel",
    icon: "⚙",
    bg:       "#020817",
    surface:  "#0a1628",
    card:     "#0f1f3d",
    border:   "#1a2e4a",
    border2:  "#243a56",
    text:     "#e8eef8",
    muted:    "#6b82a0",
    dim:      "#3a5070",
    accent:   "#f97316",
    accentDim:"#7a3810",
    green:    "#22c55e",
    blue:     "#3b82f6",
    red:      "#ef4444",
    amber:    "#f59e0b",
    purple:   "#a78bfa",
    light:    false,
  },
  slate: {
    name: "Iron Slate",
    icon: "🔩",
    bg:       "#0d0d0f",
    surface:  "#161618",
    card:     "#1e1e22",
    border:   "#2a2a30",
    border2:  "#36363e",
    text:     "#e4e4e8",
    muted:    "#707078",
    dim:      "#404048",
    accent:   "#60a5fa",
    accentDim:"#1e3a5f",
    green:    "#4ade80",
    blue:     "#818cf8",
    red:      "#f87171",
    amber:    "#fbbf24",
    purple:   "#c084fc",
    light:    false,
  },
  forest: {
    name: "Hydraulic Green",
    icon: "🌊",
    bg:       "#020f08",
    surface:  "#071a0f",
    card:     "#0a2416",
    border:   "#133d24",
    border2:  "#1a5232",
    text:     "#d4ede0",
    muted:    "#5a8a6a",
    dim:      "#2d5040",
    accent:   "#34d399",
    accentDim:"#064e3b",
    green:    "#6ee7b7",
    blue:     "#67e8f9",
    red:      "#f87171",
    amber:    "#fcd34d",
    purple:   "#a78bfa",
    light:    false,
  },
  amber: {
    name: "Construction Yellow",
    icon: "🏗",
    bg:       "#0d0900",
    surface:  "#1a1000",
    card:     "#241700",
    border:   "#3d2800",
    border2:  "#523800",
    text:     "#fef3c7",
    muted:    "#a07840",
    dim:      "#6b4f20",
    accent:   "#f59e0b",
    accentDim:"#6b3200",
    green:    "#84cc16",
    blue:     "#38bdf8",
    red:      "#f87171",
    amber:    "#fcd34d",
    purple:   "#c084fc",
    light:    false,
  },
  midnight: {
    name: "Night Shift",
    icon: "🌙",
    bg:       "#000005",
    surface:  "#080812",
    card:     "#0e0e1e",
    border:   "#1a1a2e",
    border2:  "#22223a",
    text:     "#e0e0f0",
    muted:    "#5a5a80",
    dim:      "#30305a",
    accent:   "#c084fc",
    accentDim:"#4a1080",
    green:    "#34d399",
    blue:     "#60a5fa",
    red:      "#f87171",
    amber:    "#fbbf24",
    purple:   "#e879f9",
    light:    false,
  },
  // ── LIGHT THEMES ──────────────────────────────────
  light_clean: {
    name: "Clean White",
    icon: "☀",
    light:    true,
    bg:       "#f0f4f8",
    surface:  "#ffffff",
    card:     "#ffffff",
    border:   "#dde3ea",
    border2:  "#c8d0db",
    text:     "#1a2433",
    muted:    "#5a6a7e",
    dim:      "#9aaabb",
    accent:   "#e8590c",
    accentDim:"#fddcca",
    green:    "#2a9d4e",
    blue:     "#1d6fd4",
    red:      "#d93030",
    amber:    "#c47c00",
    purple:   "#7c3aed",
  },
  light_steel: {
    name: "Steel Blue Light",
    icon: "🔷",
    light:    true,
    bg:       "#eef2f7",
    surface:  "#ffffff",
    card:     "#f8fafc",
    border:   "#cbd5e1",
    border2:  "#b0bfcc",
    text:     "#0f2340",
    muted:    "#4a6080",
    dim:      "#8099b3",
    accent:   "#1d6fd4",
    accentDim:"#c8ddf5",
    green:    "#1a8c44",
    blue:     "#4361ee",
    red:      "#d93030",
    amber:    "#b45309",
    purple:   "#6d28d9",
  },
  light_sand: {
    name: "Desert Sand",
    icon: "🏜",
    light:    true,
    bg:       "#f5f0e8",
    surface:  "#ffffff",
    card:     "#fdfaf5",
    border:   "#ddd0b8",
    border2:  "#c8b898",
    text:     "#2d1f0a",
    muted:    "#7a6040",
    dim:      "#b8a080",
    accent:   "#b45309",
    accentDim:"#fde8c8",
    green:    "#2d6a2d",
    blue:     "#1d5fa0",
    red:      "#c0392b",
    amber:    "#c47c00",
    purple:   "#6b21a8",
  },
};

// ─── Seed ─────────────────────────────────────────────────────────────────────
const SEED = {
  personalTasks: [], // standalone tasks not tied to any specific project — general work matters
  projects: [
    {
      id: "p1", order: 0,
      name: "Shaheen Pumping Station",
      client: "Al-Menya Water Authority",
      location: "Al-Menya, Egypt",
      status: "active",
      startDate: "2025-01-01",
      endDate: "2026-12-31",
      progress: 62,
      discipline: "Pump Stations",
      coverImage: null,
      images: [],
      tasks: {
        daily:  [
          { id: "t1", text: "Supervise valve chamber shutdown works", done: true,  date: "2026-06-14" },
          { id: "t2", text: "Inspect penstock M.PK.02 flange bolting torque sequence", done: false, date: "2026-06-14" },
        ],
        weekly: [
          { id: "t3", text: "Prepare weekly progress report for consultant", done: false, date: "2026-06-14" },
          { id: "t4", text: "Coordinate with client on shutdown window for Phase 3", done: true,  date: "2026-06-10" },
        ],
      },
      deliverables: [
        { id: "d1", title: "MOS – Main Header Valve Chamber (SPS-VC-MOS-002)", status: "submitted", dueDate: "2026-05-20" },
        { id: "d2", title: "MOS – Penstock Replacement M.PK.02/03/04",          status: "approved",  dueDate: "2026-05-28" },
        { id: "d3", title: "As-Built Drawings – Phase 1",                        status: "pending",   dueDate: "2026-07-15" },
      ],
      procurements: [
        { id: "pr1", item: "DN600 Non-Return Valve",    qty: 1,  unit: "No.", status: "delivered", supplier: "Local Supplier" },
        { id: "pr2", item: "Gate Valve M.KGV.17/18",    qty: 2,  unit: "No.", status: "delivered", supplier: "Local Supplier" },
        { id: "pr3", item: "Tee Reducer 600×400",       qty: 1,  unit: "No.", status: "ordered",   supplier: "Ahmed Trading" },
        { id: "pr4", item: "Wedge Anchors M20×200",     qty: 50, unit: "Pcs", status: "received",  supplier: "Hardware Store" },
      ],
      approvals: [
        { id: "a1", title: "Shutdown Permit – Phase 2",           status: "approved", issuedBy: "Consultant",  date: "2026-06-01" },
        { id: "a2", title: "Method Statement Rev.01 – Penstock",  status: "approved", issuedBy: "Client",      date: "2026-05-30" },
        { id: "a3", title: "Lifting Plan – Penstock Craneage",    status: "pending",  issuedBy: "HSE Manager", date: "" },
      ],
      notes: "Phase 2 shutdown confirmed. Coordinate crane access for penstock 700×700 mm (GEMKA) on 20 Jun 2026.",
      steps: [
        { id:"s1", order:1, title:"Site Mobilization & Safety Setup",      desc:"Deliver equipment, erect safety fencing, prepare confined space rescue kit.", status:"done", mosFile:null },
        { id:"s2", order:2, title:"Dewatering & Wet Well Isolation",        desc:"Insert DN700 inflatable plug, pump down wet well to working level.", status:"done", mosFile:null },
        { id:"s3", order:3, title:"Penstock Removal (M.PK.02)",             desc:"Dismantle old penstock gate; cardan shaft removal per MOS-002.", status:"active", mosFile:null },
        { id:"s4", order:4, title:"Structural Repair & Anchor Installation",desc:"Drill M24 anchor bolts (200mm embedment, C25 concrete).", status:"pending", mosFile:null },
        { id:"s5", order:5, title:"New Penstock Installation",              desc:"Lower and align new penstock gate, torque flanges per sequence.", status:"pending", mosFile:null },
        { id:"s6", order:6, title:"Electrical & Controls Reinstatement",   desc:"Reconnect ATEX motor, test PLC control panel.", status:"pending", mosFile:null },
        { id:"s7", order:7, title:"Commissioning & Testing",               desc:"Functional test under load, vibration check, sign-off with consultant.", status:"pending", mosFile:null },
      ],
    },
  ],
};

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_OPTS = [
  { value: "active",    label: "قائم",          en: "Active",           color: "#22c55e", bg: "#052e16" },
  { value: "handover1", label: "تسليم ابتدائي", en: "Provisional H/O", color: "#f59e0b", bg: "#451a03" },
  { value: "handover2", label: "تسليم نهائي",   en: "Final H/O",       color: "#3b82f6", bg: "#1e3a5f" },
  { value: "closed",    label: "منتهى",          en: "Closed",          color: "#6b7280", bg: "#111827" },
];
const DELIVERY_STATUS = {
  pending:   { label: "Pending",   color: "#f59e0b" },
  submitted: { label: "Submitted", color: "#3b82f6" },
  approved:  { label: "Approved",  color: "#22c55e" },
  rejected:  { label: "Rejected",  color: "#ef4444" },
};
const PROCURE_STATUS = {
  pending:   { label: "Pending",   color: "#6b7280" },
  ordered:   { label: "Ordered",   color: "#f59e0b" },
  received:  { label: "Received",  color: "#3b82f6" },
  delivered: { label: "Delivered", color: "#22c55e" },
};
const DISCIPLINES = [
  "Pump Stations","HVAC","Fire Fighting","Plumbing","Drainage",
  "HVAC & Mechanical","Water Treatment","Fuel Systems","Other"
];
const uid   = () => Math.random().toString(36).slice(2, 9);
const today = () => new Date().toISOString().slice(0, 10);
const getStatus = (v) => STATUS_OPTS.find(s => s.value === v) || STATUS_OPTS[0];

// ─── Theme Context ─────────────────────────────────────────────────────────────
let C = { ...THEMES.navy };

// ─── Style tokens (reactive) ──────────────────────────────────────────────────
const getInputStyle = () => ({
  width: "100%", background: C.surface, border: `1px solid ${C.border2}`,
  borderRadius: 7, color: C.text, padding: "9px 13px", fontSize: 14,
  outline: "none", boxSizing: "border-box", fontFamily: "inherit", transition: "border-color 0.2s",
});
const getLabelStyle   = () => ({ color: C.muted, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", marginBottom: 5, display: "block" });
const getBtnPrimary   = () => ({ background: C.accent, border: "none", borderRadius: 8, color: "#fff", padding: "9px 20px", cursor: "pointer", fontWeight: 700, fontSize: 13, fontFamily: "inherit" });
const getBtnSecondary = () => ({ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, color: C.muted, padding: "9px 16px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" });


// ─── Responsive width hook (re-renders on resize/orientation change) ──────────
function useWindowWidth() {
  const [width, setWidth] = useState(() => typeof window !== "undefined" ? window.innerWidth : 1024);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return width;
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────
function Field({ label, children }) {
  return <div style={{ marginBottom: 14 }}><label style={getLabelStyle()}>{label}</label>{children}</div>;
}
function Badge({ color, label }) {
  return (
    <span style={{ background: color + "22", border: `1px solid ${color}55`, color, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>
      {label}
    </span>
  );
}
function SectionLabel({ children }) {
  return <div style={{ color: C.muted, fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12, fontWeight: 700 }}>{children}</div>;
}
function Divider() {
  return <div style={{ height: 1, background: C.border, margin: "20px 0" }} />;
}

// ─── Gear SVG Icon (Mechanical Engineer) ──────────────────────────────────────
function GearIcon({ size = 26, color }) {
  const c = color || C.accent;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Outer gear teeth */}
      <path d="M13 2h6l1 3.5a9.5 9.5 0 012.8 1.6L26.3 6l3 5.2-2.6 2.4a9.6 9.6 0 010 3.2l2.6 2.4-3 5.2-3.5-1.1A9.5 9.5 0 0119 24.5L18 28h-6l-1-3.5a9.5 9.5 0 01-2.8-1.6L4.7 24 1.7 18.8l2.6-2.4a9.6 9.6 0 010-3.2L1.7 10.8 4.7 5.6l3.5 1.1A9.5 9.5 0 0111 5.5L13 2z"
        stroke={c} strokeWidth="1.5" fill={c + "18"}/>
      {/* Inner circle */}
      <circle cx="16" cy="16" r="4.5" stroke={c} strokeWidth="1.5" fill={c + "30"}/>
      {/* Center dot */}
      <circle cx="16" cy="16" r="1.5" fill={c}/>
      {/* Pump/pipe lines */}
      <line x1="16" y1="11.5" x2="16" y2="8" stroke={c} strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="16" y1="20.5" x2="16" y2="24" stroke={c} strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="11.5" y1="16" x2="8" y2="16" stroke={c} strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="20.5" y1="16" x2="24" y2="16" stroke={c} strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

// ─── Progress Ring ────────────────────────────────────────────────────────────
function ProgressRing({ pct, size = 52 }) {
  const r = (size - 8) / 2, circ = 2 * Math.PI * r, dash = (pct / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.border} strokeWidth="6"/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.accent} strokeWidth="6"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" style={{ transition: "stroke-dasharray 0.6s ease" }}/>
    </svg>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16 }}
         onClick={e => e.target===e.currentTarget && onClose()}>
      <div style={{ background:C.card,border:`1px solid ${C.border2}`,borderRadius:14,width:"100%",maxWidth:wide?880:540,maxHeight:"92vh",display:"flex",flexDirection:"column",boxShadow:"0 30px 80px rgba(0,0,0,0.7)" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"18px 24px",borderBottom:`1px solid ${C.border}` }}>
          <span style={{ color:C.text,fontWeight:800,fontSize:15,fontFamily:"'JetBrains Mono',monospace",letterSpacing:0.5 }}>{title}</span>
          <button onClick={onClose} style={{ background:"none",border:`1px solid ${C.border2}`,color:C.muted,borderRadius:6,width:30,height:30,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>
        </div>
        <div style={{ overflowY:"auto",padding:"22px 24px",flex:1 }}>{children}</div>
      </div>
    </div>
  );
}

// ─── AddRow ───────────────────────────────────────────────────────────────────

// ─── AutoResizeInput ──────────────────────────────────────────────────────────
// A <textarea> that looks and behaves exactly like a single-line <input>, but
// unlike <input> it correctly scrolls to follow the cursor on Android — the root
// cause of text appearing to "disappear" after ~8 words when typing long task
// names. It grows vertically only when the user explicitly adds a newline (which
// submits via Enter anyway), otherwise stays one line.
function AutoResizeInput({ value, onChange, onKeyDown, placeholder, style, autoFocus }) {
  const ref = useRef();
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = ref.current.scrollHeight + "px";
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      autoFocus={autoFocus}
      rows={1}
      style={{
        ...style,
        resize:"none",
        overflow:"hidden",
        lineHeight:"1.4",
        display:"block",
      }}
    />
  );
}

function AddRow({ placeholder, onAdd, fields }) {
  const [vals, setVals] = useState(fields ? Object.fromEntries(fields.map(f => [f.key,""])) : { text:"" });
  const set = (k,v) => setVals(p => ({...p,[k]:v}));
  const handle = () => {
    if (fields) { if(!vals[fields[0].key].trim()) return; onAdd(vals); setVals(Object.fromEntries(fields.map(f=>[f.key,""]))); }
    else { if(!vals.text.trim()) return; onAdd(vals.text.trim()); setVals({text:""}); }
  };
  const is = getInputStyle();
  const bp = getBtnPrimary();
  return (
    <div style={{ display:"flex",gap:6,marginTop:12,flexWrap:"wrap",alignItems:"center" }}>
      {fields ? fields.map(f=>(
        <input key={f.key} placeholder={f.label} value={vals[f.key]}
          onChange={e=>set(f.key,e.target.value)} onKeyDown={e=>e.key==="Enter"&&handle()}
          style={{...is,flex:f.flex||1,width:"auto"}}/>
      )) : (
        <AutoResizeInput placeholder={placeholder} value={vals.text}
          onChange={e=>set("text",e.target.value)}
          onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handle(); } }}
          style={{...is,flex:1}}/>
      )}
      {!fields && (
        <MicButton size={36} onResult={(text)=>set("text", vals.text ? `${vals.text} ${text}` : text)}/>
      )}
      <button onClick={handle} style={{...bp,padding:"0 18px",height:40}}>+ Add</button>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// VOICE INPUT HOOK — Web Speech API (works on Chrome/Android, Safari iOS 14.5+)
// ═══════════════════════════════════════════════════════════════════════════════
function useVoiceInput(onResult) {
  const [listening, setListening] = useState(false);
  const [supported] = useState(() => typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition));
  const recognitionRef = useRef(null);

  const start = useCallback(() => {
    if (!supported) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SpeechRecognition();
    rec.lang = "ar-EG"; // Egyptian Arabic; falls back gracefully if unsupported
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;

    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      onResult(transcript);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);

    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }, [supported, onResult]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  return { listening, supported, start, stop };
}

function MicButton({ onResult, size = 28 }) {
  const { listening, supported, start, stop } = useVoiceInput(onResult);
  if (!supported) return null;
  return (
    <button
      onClick={() => listening ? stop() : start()}
      title={listening ? "Stop recording" : "Voice input"}
      style={{
        width:size, height:size, borderRadius:"50%", flexShrink:0,
        border:`1px solid ${listening ? C.red : C.border2}`,
        background: listening ? C.red+"22" : "transparent",
        color: listening ? C.red : C.muted,
        cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
        fontSize: size*0.5, transition:"all 0.2s", position:"relative",
      }}>
      {listening && (
        <div style={{
          position:"absolute", inset:-3, borderRadius:"50%",
          border:`2px solid ${C.red}55`, animation:"pulse-ring 1.4s ease-out infinite",
        }}/>
      )}
      {listening ? "⏹" : "🎤"}
    </button>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// DAILY REPORT GENERATOR — builds a WhatsApp/email-ready text summary
// ═══════════════════════════════════════════════════════════════════════════════
function generateDailyReport(projects, profileName) {
  const dateStr = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  let lines = [];
  lines.push(`📋 *DAILY SITE REPORT*`);
  lines.push(`📅 ${dateStr}`);
  if (profileName) lines.push(`👤 ${profileName}`);
  lines.push("");

  projects.forEach(p => {
    const daily = p.tasks?.daily || [];
    const done  = daily.filter(t=>t.done);
    const pending = daily.filter(t=>!t.done);
    const notesCount = daily.filter(t=>t.notes && t.notes.trim()).length;

    if (daily.length === 0 && (p.steps||[]).every(s=>s.status!=="active")) return; // skip silent projects

    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`🏗 *${p.name}*`);
    lines.push(`   ${p.client || ""} · ${p.location || ""}`);
    lines.push("");

    if (done.length > 0) {
      lines.push(`✅ Completed (${done.length}):`);
      done.forEach(t => {
        lines.push(`  • ${t.text}`);
        if (t.notes && t.notes.trim()) lines.push(`     📝 ${t.notes.trim()}`);
      });
    }
    if (pending.length > 0) {
      lines.push(`⏳ Pending (${pending.length}):`);
      pending.forEach(t => {
        lines.push(`  • ${t.text}`);
        if (t.notes && t.notes.trim()) lines.push(`     📝 ${t.notes.trim()}`);
      });
    }

    // Active execution steps
    const activeSteps = (p.steps||[]).filter(s=>s.status==="active");
    if (activeSteps.length > 0) {
      lines.push(`▶ In Progress:`);
      activeSteps.forEach(s => lines.push(`  • ${s.title}`));
    }

    // Overdue approvals
    const todayStr = today();
    const overdue = (p.approvals||[]).filter(a=>a.status==="pending" && a.dueDate && a.dueDate < todayStr);
    if (overdue.length > 0) {
      lines.push(`🔴 Overdue Approvals:`);
      overdue.forEach(a => lines.push(`  • ${a.title}`));
    }

    lines.push("");
  });

  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated via Mechanical Projects Manager`);

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERIOD REPORT GENERATOR — weekly/monthly rollup across all projects
// ═══════════════════════════════════════════════════════════════════════════════
function generatePeriodReport(projects, profileName, days) {
  const periodLabel = days === 7 ? "WEEKLY" : days === 30 ? "MONTHLY" : `${days}-DAY`;
  const cutoffMs = Date.now() - days*86400000;
  const todayStr = today();
  const rangeStart = new Date(cutoffMs).toLocaleDateString("en-GB",{day:"2-digit",month:"short"});
  const rangeEnd   = new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});

  let lines = [];
  lines.push(`📊 *${periodLabel} SITE REPORT*`);
  lines.push(`📅 ${rangeStart} → ${rangeEnd}`);
  if (profileName) lines.push(`👤 ${profileName}`);
  lines.push("");

  let anyContent = false;

  projects.forEach(p => {
    const daily = p.tasks?.daily || [];
    // Tasks completed within the period (best-effort: falls back to "done" with no
    // timestamp being counted as in-period, since legacy tasks lack createdAt)
    const completedInPeriod = daily.filter(t => t.done && (typeof t.createdAt !== "number" || t.createdAt >= cutoffMs));
    const stillPending = daily.filter(t => !t.done);

    const steps = p.steps || [];
    const doneSteps = steps.filter(s=>s.status==="done").length;
    const stepProgress = steps.length ? Math.round((doneSteps/steps.length)*100) : null;
    const activeSteps = steps.filter(s=>s.status==="active");

    // Comments added within the period, across all steps — gives a sense of what happened
    const recentComments = [];
    steps.forEach(s => (s.comments||[]).forEach(c => {
      const ts = new Date(c.at).getTime();
      if (!isNaN(ts) && ts >= cutoffMs) recentComments.push({ step: s.title, text: c.text, at: ts });
    }));
    recentComments.sort((a,b) => a.at - b.at);

    const overdueApprovals = (p.approvals||[]).filter(a=>a.status==="pending" && a.dueDate && a.dueDate < todayStr);

    // Skip projects with zero activity in the period to keep the report focused
    if (completedInPeriod.length===0 && recentComments.length===0 && activeSteps.length===0 && overdueApprovals.length===0) return;
    anyContent = true;

    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`🏗 *${p.name}*`);
    lines.push(`   ${p.client || ""} · ${p.location || ""}`);
    if (stepProgress !== null) lines.push(`   Progress: ${stepProgress}% (${doneSteps}/${steps.length} steps)`);
    lines.push("");

    if (completedInPeriod.length > 0) {
      lines.push(`✅ Completed this period (${completedInPeriod.length}):`);
      completedInPeriod.forEach(t => lines.push(`  • ${t.text}`));
    }
    if (activeSteps.length > 0) {
      lines.push(`▶ Currently in progress:`);
      activeSteps.forEach(s => lines.push(`  • ${s.title}${s.assignee ? ` (${s.assignee})` : ""}`));
    }
    if (recentComments.length > 0) {
      lines.push(`💬 Notes logged this period:`);
      recentComments.forEach(c => lines.push(`  • [${c.step}] ${c.text}`));
    }
    if (stillPending.length > 0) {
      lines.push(`⏳ Still pending: ${stillPending.length} task${stillPending.length!==1?"s":""}`);
    }
    if (overdueApprovals.length > 0) {
      lines.push(`🔴 Overdue approvals:`);
      overdueApprovals.forEach(a => lines.push(`  • ${a.title}`));
    }
    lines.push("");
  });

  if (!anyContent) {
    lines.push("No activity recorded across any project in this period.");
    lines.push("");
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated via Mechanical Projects Manager`);

  return lines.join("\n");
}


// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT STATUS REPORT GENERATOR — full single-project snapshot for sharing
// ═══════════════════════════════════════════════════════════════════════════════
function generateProjectStatusReport(project) {
  const todayStr = today();
  const st = getStatus(project.status);
  const steps = project.steps || [];
  const doneSteps = steps.filter(s=>s.status==="done").length;
  const stepProgress = steps.length ? Math.round((doneSteps/steps.length)*100) : null;

  let lines = [];
  lines.push(`🏗 *PROJECT STATUS — ${project.name}*`);
  lines.push(`📅 ${new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"long",year:"numeric"})}`);
  lines.push("");
  lines.push(`Client: ${project.client || "—"}`);
  lines.push(`Location: ${project.location || "—"}`);
  lines.push(`Status: ${st.en} (${st.label})`);
  if (project.startDate || project.endDate) {
    lines.push(`Timeline: ${project.startDate || "?"} → ${project.endDate || "?"}`);
  }
  if (stepProgress !== null) {
    lines.push(`Execution Progress: ${stepProgress}% (${doneSteps}/${steps.length} steps complete)`);
  }
  lines.push("");

  // Execution sequence snapshot
  if (steps.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`▶ EXECUTION SEQUENCE`);
    steps.forEach((s, i) => {
      const icon = s.status==="done" ? "✅" : s.status==="active" ? "🔵" : "⬜";
      lines.push(`${icon} ${i+1}. ${s.title}${s.assignee ? ` — ${s.assignee}` : ""}`);
    });
    lines.push("");
  }

  // Pending daily tasks
  const pendingTasks = (project.tasks?.daily||[]).filter(t=>!t.done);
  if (pendingTasks.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`⏳ PENDING TASKS (${pendingTasks.length})`);
    pendingTasks.forEach(t => lines.push(`  • ${t.text}`));
    lines.push("");
  }

  // Approvals
  const approvals = project.approvals || [];
  const overdue = approvals.filter(a=>a.status==="pending" && a.dueDate && a.dueDate < todayStr);
  const pendingApprovals = approvals.filter(a=>a.status==="pending" && !(a.dueDate && a.dueDate < todayStr));
  if (overdue.length > 0 || pendingApprovals.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📋 APPROVALS`);
    if (overdue.length > 0) {
      lines.push(`🔴 Overdue:`);
      overdue.forEach(a => lines.push(`  • ${a.title}`));
    }
    if (pendingApprovals.length > 0) {
      lines.push(`⏳ Pending:`);
      pendingApprovals.forEach(a => lines.push(`  • ${a.title}`));
    }
    lines.push("");
  }

  // Recent comments across steps (last 5, most recent first)
  const allComments = [];
  steps.forEach(s => (s.comments||[]).forEach(c => allComments.push({ step:s.title, ...c })));
  allComments.sort((a,b) => new Date(b.at) - new Date(a.at));
  if (allComments.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`💬 RECENT NOTES`);
    allComments.slice(0,5).forEach(c => lines.push(`  • [${c.step}] ${c.text}`));
    lines.push("");
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Generated via Mechanical Projects Manager`);

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCUREMENT SHARE GENERATOR — builds a WhatsApp/email-ready text for procurement
// ═══════════════════════════════════════════════════════════════════════════════
function generateProcurementReport(projectName, items) {
  const dateStr = new Date().toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"long",year:"numeric"});
  let lines = [];
  lines.push(`📦 *PROCUREMENT REQUEST*`);
  lines.push(`🏗 Project: ${projectName}`);
  lines.push(`📅 ${dateStr}`);
  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━━`);

  items.forEach((row, idx) => {
    const st = PROCURE_STATUS[row.status] || PROCURE_STATUS.pending;
    lines.push(`${idx+1}. *${row.item}*`);
    lines.push(`   Qty: ${row.qty} ${row.unit || "No."}`);
    if (row.supplier) lines.push(`   Supplier: ${row.supplier}`);
    lines.push(`   Status: ${st.icon || ""} ${st.label}`.trim());
    lines.push("");
  });

  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  lines.push(`Total items: ${items.length}`);
  lines.push(`Sent via Mechanical Projects Manager`);

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION BANNER
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO BACKUP REMINDER
// Browsers block truly-automatic file downloads without a user gesture (security
// restriction — especially strict on mobile). So instead of a silent background
// backup, this shows a lightweight one-tap reminder once enough time has passed
// since the last local backup file was saved, tracked via AUTO_BACKUP_KEY.
// One tap downloads a fresh MPM-backup-YYYY-MM-DD.json to the device's normal
// Downloads folder — from there the user can move/share it to Drive, WhatsApp,
// email, etc. however they prefer.
// ═══════════════════════════════════════════════════════════════════════════════
const AUTO_BACKUP_INTERVAL_DAYS = 3; // remind if it's been this many days since the last backup


// ═══════════════════════════════════════════════════════════════════════════════
// TASK ROLLOVER DIALOG
// Appears once per day when the app is opened and there are unfinished daily
// tasks from previous days. For each task the user can choose to:
//   - Roll over → move to today (date updated, stays in the list)
//   - Archive   → remove from daily list and put in an archive log
//   - Skip      → leave as-is for now (will appear again tomorrow)
// The dialog only appears once per calendar day regardless of how many times
// the app is opened.
// ═══════════════════════════════════════════════════════════════════════════════
function TaskRolloverDialog({ overdueItems, onDone }) {
  // overdueItems: [{projectId, projectName, taskId, text, date}]
  // decisions:    {taskId: "rollover" | "archive" | "skip"}
  const [decisions, setDecisions] = useState(() =>
    Object.fromEntries(overdueItems.map(t => [t.taskId, "rollover"]))
  );

  const setDecision = (taskId, action) =>
    setDecisions(d => ({ ...d, [taskId]: action }));

  const overdueCount = overdueItems.length;

  return (
    <div style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", zIndex:950,
      display:"flex", alignItems:"center", justifyContent:"center", padding:"16px",
    }}>
      <div style={{
        background:C.card, border:`1px solid ${C.amber}44`, borderRadius:14,
        width:"100%", maxWidth:480, maxHeight:"90vh", display:"flex", flexDirection:"column",
        boxShadow:"0 24px 60px rgba(0,0,0,0.6)",
      }}>
        {/* Header */}
        <div style={{ padding:"20px 20px 14px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
          <div style={{ color:C.amber, fontSize:11, letterSpacing:2, textTransform:"uppercase", fontWeight:700, marginBottom:6 }}>
            ⚠ Unfinished Tasks
          </div>
          <div style={{ color:C.text, fontSize:16, fontWeight:800 }}>
            {overdueCount} task{overdueCount!==1?"s":""} from previous days
          </div>
          <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>
            What do you want to do with each one?
          </div>
        </div>

        {/* Task list */}
        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px" }}>
          {overdueItems.map(item => {
            const decision = decisions[item.taskId];
            return (
              <div key={item.taskId} style={{
                background:C.surface, border:`1px solid ${C.border}`,
                borderRadius:9, padding:"12px 14px", marginBottom:10,
              }}>
                <div style={{ marginBottom:8 }}>
                  <div style={{ color:C.muted, fontSize:10, marginBottom:3 }}>
                    {item.projectName} · {item.date}
                  </div>
                  <div style={{ color:C.text, fontSize:13, fontWeight:600, lineHeight:1.4 }}>
                    {item.text}
                  </div>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  {[
                    ["rollover", "📅 Roll to Today", C.accent],
                    ["archive",  "📦 Archive",       C.green],
                    ["skip",     "⏭ Skip",           C.dim],
                  ].map(([action, label, color]) => (
                    <button key={action} onClick={()=>setDecision(item.taskId, action)}
                      style={{
                        flex:1, background: decision===action ? color+"22" : "transparent",
                        border:`1px solid ${decision===action ? color : C.border2}`,
                        color: decision===action ? color : C.muted,
                        borderRadius:7, padding:"6px 0", cursor:"pointer",
                        fontSize:11, fontWeight: decision===action ? 700 : 500,
                        fontFamily:"inherit", transition:"all 0.15s",
                      }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding:"14px 16px", borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
          <button onClick={()=>onDone(decisions)}
            style={{ width:"100%", background:C.accent, border:"none", borderRadius:9,
                     color:"#fff", padding:"13px", cursor:"pointer",
                     fontSize:14, fontWeight:800, fontFamily:"inherit" }}>
            ✓ Apply Decisions
          </button>
        </div>
      </div>
    </div>
  );
}

function AutoBackupReminder({ data }) {
  const [dismissedToday, setDismissedToday] = useState(false);
  const [justBackedUp, setJustBackedUp] = useState(false);

  const state = loadAutoBackupState();
  const lastBackupAt = state?.lastBackupAt || null;
  const daysSinceBackup = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : Infinity;
  const todayStr = today();
  const dismissedTodayStored = state?.dismissedDate === todayStr;

  const shouldShow = !dismissedToday && !dismissedTodayStored &&
                      daysSinceBackup >= AUTO_BACKUP_INTERVAL_DAYS &&
                      (data.projects || []).length > 0; // nothing to back up yet on a brand-new install

  if (!shouldShow) return null;

  const doBackupNow = () => {
    const payload = {
      __version: 1,
      __app: "MechanicalProjectsManager",
      __exported: new Date().toISOString(),
      ...data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const date = new Date().toISOString().slice(0,10);
    a.href     = url;
    a.download = `MPM-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);

    saveAutoBackupState({ lastBackupAt: Date.now(), dismissedDate: null });
    setJustBackedUp(true);
    setTimeout(() => setJustBackedUp(false), 2500);
  };

  const dismiss = () => {
    saveAutoBackupState({ ...state, dismissedDate: todayStr });
    setDismissedToday(true);
  };

  return (
    <div style={{
      background: `linear-gradient(135deg, ${C.amber}18, ${C.amber}08)`,
      border: `1px solid ${C.amber}44`,
      borderRadius: 10, padding: "12px 16px",
      display: "flex", alignItems: "center", gap: 12,
      marginBottom: 20, flexWrap: "wrap",
    }}>
      <span style={{ fontSize: 22, flexShrink: 0 }}>💾</span>
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ color: C.amber, fontWeight: 800, fontSize: 13, marginBottom: 2 }}>
          {lastBackupAt
            ? `It's been ${daysSinceBackup} days since your last backup`
            : "You haven't backed up your data yet"}
        </div>
        <div style={{ color: C.muted, fontSize: 12 }}>
          One tap saves a backup file to your device — keep it somewhere safe (Drive, WhatsApp to yourself, email)
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button onClick={doBackupNow}
          style={{ background: justBackedUp ? C.green : C.amber, border: "none", borderRadius: 7, color: "#fff",
                   padding: "7px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
          {justBackedUp ? "✓ Saved" : "💾 Backup Now"}
        </button>
        <button onClick={dismiss}
          style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7, color: C.muted,
                   padding: "7px 12px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
          title="Remind me again tomorrow">
          Later
        </button>
      </div>
    </div>
  );
}

function NotificationBanner({ projects, onDismiss, onOpenDaily, onOpenApprovals }) {
  const pendingTasks = projects.reduce((n,p) => n + (p.tasks.daily||[]).filter(t=>!t.done).length, 0);
  const todayStr = today();
  const overdueApprovals = projects.reduce((n,p) =>
    n + (p.approvals||[]).filter(a => a.status==="pending" && a.dueDate && a.dueDate < todayStr).length, 0);
  const dueSoonApprovals = projects.reduce((n,p) =>
    n + (p.approvals||[]).filter(a => a.status==="pending" && a.dueDate && a.dueDate >= todayStr &&
      (new Date(a.dueDate)-new Date(todayStr)) <= 3*86400000).length, 0);

  const hasApprovalAlerts = overdueApprovals > 0 || dueSoonApprovals > 0;
  if (pendingTasks === 0 && !hasApprovalAlerts) return null;

  const alertColor = overdueApprovals > 0 ? C.red : C.accent;

  return (
    <div style={{
      background: `linear-gradient(135deg, ${alertColor}18, ${C.accentDim}40)`,
      border: `1px solid ${alertColor}44`,
      borderRadius: 10,
      padding: "12px 16px",
      display: "flex",
      alignItems: "center",
      gap: 12,
      marginBottom: 20,
      flexWrap: "wrap",
    }}>
      {/* Gear pulse icon */}
      <div style={{ flexShrink: 0, position: "relative" }}>
        <div style={{
          position: "absolute", inset: -4, borderRadius: "50%",
          border: `2px solid ${alertColor}44`,
          animation: "pulse-ring 2s ease-out infinite",
        }}/>
        <GearIcon size={28} color={alertColor}/>
      </div>

      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ color: alertColor, fontWeight: 800, fontSize: 13, fontFamily: "'JetBrains Mono',monospace", marginBottom: 2 }}>
          {pendingTasks > 0 && `${pendingTasks} Pending Task${pendingTasks > 1 ? "s" : ""}`}
          {pendingTasks > 0 && hasApprovalAlerts && " · "}
          {overdueApprovals > 0 && `${overdueApprovals} Overdue Approval${overdueApprovals > 1 ? "s" : ""}`}
          {overdueApprovals > 0 && dueSoonApprovals > 0 && " · "}
          {dueSoonApprovals > 0 && `${dueSoonApprovals} Due Soon`}
        </div>
        <div style={{ color: C.muted, fontSize: 12 }}>
          {hasApprovalAlerts ? "Check unfinished tasks and pending approvals" : "You have unfinished daily tasks across your projects"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        {pendingTasks > 0 && (
          <button onClick={onOpenDaily}
            style={{ background: C.accent, border: "none", borderRadius: 7, color: "#fff",
                     padding: "7px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
            ☑ Tasks
          </button>
        )}
        {hasApprovalAlerts && onOpenApprovals && (
          <button onClick={onOpenApprovals}
            style={{ background: overdueApprovals>0?C.red:C.amber, border: "none", borderRadius: 7, color: "#fff",
                     padding: "7px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
            📋 Approvals
          </button>
        )}
        <button onClick={onDismiss}
          style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7, color: C.muted,
                   padding: "7px 12px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
          title="Dismiss notifications for today">
          Dismiss
        </button>
      </div>

      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(0.8); opacity: 1; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// THEME PICKER MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function ThemePickerModal({ currentTheme, onSelect, onClose }) {
  return (
    <Modal title="🎨 App Theme" onClose={onClose}>
      {[
        { label:"🌑 Dark Themes",  filter: t => !t.light },
        { label:"☀️ Light Themes", filter: t =>  t.light },
      ].map(({ label, filter }) => {
        const entries = Object.entries(THEMES).filter(([,t]) => filter(t));
        if (!entries.length) return null;
        return (
          <div key={label} style={{ marginBottom: 20 }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: 2, textTransform: "uppercase",
                          fontWeight: 700, marginBottom: 10, fontFamily:"'JetBrains Mono',monospace" }}>
              {label}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {entries.map(([key, theme]) => {
                const isActive = key === currentTheme;
                return (
                  <button key={key} onClick={() => { onSelect(key); onClose(); }}
                    style={{
                      background: theme.card,
                      border: `2px solid ${isActive ? theme.accent : theme.border2}`,
                      borderRadius: 12, padding: "14px",
                      cursor: "pointer", textAlign: "left",
                      transition: "all 0.15s", outline: "none",
                      position: "relative", overflow: "hidden",
                      boxShadow: theme.light ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                    }}>
                    <div style={{ display: "flex", gap: 3, marginBottom: 8 }}>
                      {[theme.accent, theme.green, theme.blue, theme.amber, theme.purple].map((col, i) => (
                        <div key={i} style={{ flex: 1, height: 5, background: col, borderRadius: 3 }}/>
                      ))}
                    </div>
                    <div style={{ color: theme.text, fontWeight: 800, fontSize: 13, marginBottom: 3,
                                  textShadow: theme.light ? "none" : "none" }}>
                      {theme.icon} {theme.name}
                    </div>
                    <div style={{ color: theme.muted, fontSize: 11 }}>
                      {theme.light ? "Light" : "Dark"} · {theme.bg}
                    </div>
                    {isActive && (
                      <div style={{
                        position: "absolute", top: 8, right: 8,
                        background: theme.accent, borderRadius: "50%",
                        width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#fff", fontSize: 11, fontWeight: 800,
                      }}>✓</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </Modal>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// DATA MANAGER — Export / Import
// ═══════════════════════════════════════════════════════════════════════════════
function DataManagerModal({ data, onImport, onClose }) {
  const [tab,      setTab]      = useState("export");
  const [status,   setStatus]   = useState(null);   // {type:"ok"|"err", msg}
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  // ── Google Account sync state ──
  const [googleAccount, setGoogleAccount] = useState(() => loadGoogleAccount());
  const [googleToken,   setGoogleToken]   = useState(null); // never persisted — re-auth each session
  const [googleBusy,    setGoogleBusy]    = useState(false);
  const [googleStatus,  setGoogleStatus]  = useState(null);

  const handleGoogleSignIn = async () => {
    setGoogleBusy(true);
    setGoogleStatus(null);
    try {
      const { signInWithGoogle } = await import("./lib/googleSync.js");
      const profile = await signInWithGoogle();
      const acct = { email: profile.email, name: profile.name, picture: profile.picture };
      setGoogleAccount(acct);
      saveGoogleAccount(acct);
      setGoogleToken(profile.token);
      setGoogleStatus({type:"ok", msg:`Signed in as ${profile.email}`});
    } catch (err) {
      setGoogleStatus({type:"err", msg: err.message || "Sign-in failed."});
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleGoogleSignOut = async () => {
    try {
      const { signOutGoogle } = await import("./lib/googleSync.js");
      signOutGoogle();
    } catch {}
    setGoogleAccount(null);
    saveGoogleAccount(null);
    setGoogleToken(null);
    setGoogleStatus(null);
  };

  const handleGoogleBackup = async () => {
    setGoogleBusy(true);
    setGoogleStatus(null);
    try {
      let token = googleToken;
      if (!token) {
        const { signInWithGoogle } = await import("./lib/googleSync.js");
        const profile = await signInWithGoogle();
        token = profile.token;
        setGoogleToken(token);
        const acct = { email: profile.email, name: profile.name, picture: profile.picture };
        setGoogleAccount(acct);
        saveGoogleAccount(acct);
      }
      const { backupToGoogleDrive } = await import("./lib/googleSync.js");
      await backupToGoogleDrive(token, data);
      // A successful Google Drive backup also satisfies the local-backup reminder
      saveAutoBackupState({ lastBackupAt: Date.now(), dismissedDate: null });
      setGoogleStatus({type:"ok", msg:`Backed up ${data.projects?.length||0} project(s) to Google Drive ✓`});
    } catch (err) {
      setGoogleStatus({type:"err", msg: err.message || "Backup failed."});
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleGoogleRestore = async () => {
    if (!window.confirm("Restore from Google Drive?\n\nThis will REPLACE all current data on this device with the backup from your Google account.")) return;
    setGoogleBusy(true);
    setGoogleStatus(null);
    try {
      let token = googleToken;
      if (!token) {
        const { signInWithGoogle } = await import("./lib/googleSync.js");
        const profile = await signInWithGoogle();
        token = profile.token;
        setGoogleToken(token);
        const acct = { email: profile.email, name: profile.name, picture: profile.picture };
        setGoogleAccount(acct);
        saveGoogleAccount(acct);
      }
      const { restoreFromGoogleDrive } = await import("./lib/googleSync.js");
      const result = await restoreFromGoogleDrive(token);
      if (!result) {
        setGoogleStatus({type:"err", msg:"No backup found on this Google account yet. Use 'Backup Now' first."});
        return;
      }
      onImport(result.data);
      setGoogleStatus({type:"ok", msg:`Restored ${result.data.projects?.length||0} project(s) from Google Drive ✓`});
    } catch (err) {
      setGoogleStatus({type:"err", msg: err.message || "Restore failed."});
    } finally {
      setGoogleBusy(false);
    }
  };

  // ── Export ──
  const doExport = () => {
    const payload = {
      __version: 1,
      __app: "MechanicalProjectsManager",
      __exported: new Date().toISOString(),
      ...data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const date = new Date().toISOString().slice(0,10);
    a.href     = url;
    a.download = `MPM-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    // A manual export satisfies the auto-backup reminder too — no need to nag
    // someone who already just backed up themselves.
    saveAutoBackupState({ lastBackupAt: Date.now(), dismissedDate: null });
    setStatus({type:"ok", msg:`Exported ${data.projects?.length||0} project(s) — MPM-backup-${date}.json`});
  };

  // ── Import ──
  const parseFile = (file) => {
    if (!file) return;
    if (!file.name.endsWith(".json")) {
      setStatus({type:"err", msg:"Please select a .json file exported from this app."}); return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!parsed.projects || !Array.isArray(parsed.projects)) {
          setStatus({type:"err", msg:"Invalid file — no projects array found."}); return;
        }
        const projectCount = parsed.projects.length;
        // Strip meta keys, keep only data
        const { __version, __app, __exported, ...importData } = parsed;
        if (window.confirm(
          `Import ${projectCount} project(s) from this backup?\n\nThis will REPLACE your current data.\nMake sure you exported a backup first.`
        )) {
          onImport(importData);
          setStatus({type:"ok", msg:`Imported ${projectCount} project(s) successfully!`});
        }
      } catch {
        setStatus({type:"err", msg:"Could not parse file. Make sure it is a valid MPM backup."});
      }
    };
    reader.readAsText(file);
  };

  const onFileChange = (e) => parseFile(e.target.files[0]);
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    parseFile(e.dataTransfer.files[0]);
  };

  const bs = getBtnSecondary();
  const bp = getBtnPrimary();

  return (
    <Modal title="⇅ Export / Import Data" onClose={onClose}>

      {/* Tabs */}
      <div style={{ display:"flex",gap:4,marginBottom:24,background:C.surface,borderRadius:8,padding:4 }}>
        {[["export","📤 Export"],["import","📥 Import"],["google","🔗 Google Account"]].map(([k,lbl])=>(
          <button key={k} onClick={()=>{setTab(k);setStatus(null);}}
            style={{ flex:1,background:tab===k?C.accent:"transparent",border:"none",
                     color:tab===k?"#fff":C.muted,borderRadius:6,padding:"8px",
                     cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit",transition:"all 0.2s" }}>
            {lbl}
          </button>
        ))}
      </div>

      {/* ── EXPORT ── */}
      {tab==="export" && (
        <div>
          <div style={{ background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"20px",marginBottom:20 }}>
            <div style={{ color:C.text,fontWeight:700,fontSize:15,marginBottom:8 }}>
              Backup your data
            </div>
            <div style={{ color:C.muted,fontSize:13,lineHeight:1.7,marginBottom:16 }}>
              Downloads a <code style={{color:C.accent,background:C.card,padding:"1px 5px",borderRadius:4}}>.json</code> file
              with all your projects, tasks, procurement, notes, and execution steps.
              <br/><br/>
              Save this file somewhere safe (Google Drive, WhatsApp to yourself, email).
              When you get a new app version, import it to restore everything.
            </div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:10,marginBottom:16 }}>
              {[
                ["Projects",  data.projects?.length||0,              C.accent],
                ["Tasks",     data.projects?.reduce((n,p)=>n+(p.tasks?.daily?.length||0)+(p.tasks?.weekly?.length||0),0)||0, C.blue],
                ["Steps",     data.projects?.reduce((n,p)=>n+(p.steps?.length||0),0)||0, C.green],
                ["Procure",   data.projects?.reduce((n,p)=>n+(p.procurements?.length||0),0)||0, C.purple],
              ].map(([lbl,val,col])=>(
                <div key={lbl} style={{ background:C.card,border:`1px solid ${col}33`,borderRadius:8,padding:"10px 16px",minWidth:90,textAlign:"center" }}>
                  <div style={{ color:col,fontWeight:800,fontSize:22,fontFamily:"'JetBrains Mono',monospace" }}>{val}</div>
                  <div style={{ color:C.muted,fontSize:11,marginTop:3 }}>{lbl}</div>
                </div>
              ))}
            </div>
            <button onClick={doExport} style={{...bp,width:"100%",padding:"12px",fontSize:14}}>
              📤 Download Backup (.json)
            </button>
          </div>
        </div>
      )}

      {/* ── IMPORT ── */}
      {tab==="import" && (
        <div>
          <div style={{ background:"#7a1f1f22",border:"1px solid #ef444455",borderRadius:8,padding:"12px 16px",marginBottom:20 }}>
            <div style={{ color:"#f87171",fontWeight:700,fontSize:13,marginBottom:4 }}>⚠ Warning</div>
            <div style={{ color:"#f8717199",fontSize:12,lineHeight:1.6 }}>
              Importing will <strong style={{color:"#f87171"}}>replace all current data</strong>.
              Make sure you exported a backup before importing.
            </div>
          </div>

          {/* Drop zone */}
          <div
            onClick={()=>fileRef.current.click()}
            onDragOver={e=>{e.preventDefault();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={onDrop}
            style={{
              border:`2px dashed ${dragOver?C.accent:C.border2}`,
              borderRadius:12, padding:"40px 20px", textAlign:"center",
              cursor:"pointer", transition:"all 0.2s",
              background:dragOver?C.accent+"10":C.surface,
              marginBottom:16,
            }}>
            <div style={{ fontSize:36,marginBottom:12 }}>📂</div>
            <div style={{ color:C.text,fontWeight:700,fontSize:14,marginBottom:6 }}>
              {dragOver ? "Drop it here!" : "Click to select or drag & drop"}
            </div>
            <div style={{ color:C.muted,fontSize:12 }}>
              MPM-backup-YYYY-MM-DD.json
            </div>
            <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={onFileChange}/>
          </div>
        </div>
      )}

      {/* ── GOOGLE ACCOUNT ── */}
      {tab==="google" && (
        <div>
          <div style={{ color:C.muted, fontSize:13, lineHeight:1.7, marginBottom:18 }}>
            Link your Google account to back up your projects to your own Google Drive.
            If you sign out, clear your browser, or reinstall the app, sign back in with the
            same account to restore everything.
          </div>

          {!googleAccount ? (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"24px", textAlign:"center" }}>
              <div style={{ fontSize:32, marginBottom:12 }}>🔗</div>
              <div style={{ color:C.text, fontWeight:700, fontSize:14, marginBottom:16 }}>No Google account linked</div>
              <button onClick={handleGoogleSignIn} disabled={googleBusy}
                style={{...bp, padding:"11px 24px", fontSize:14, opacity:googleBusy?0.6:1}}>
                {googleBusy ? "Connecting…" : "🔗 Sign in with Google"}
              </button>
            </div>
          ) : (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"18px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:18 }}>
                {googleAccount.picture ? (
                  <img src={googleAccount.picture} style={{width:42,height:42,borderRadius:"50%",flexShrink:0}}/>
                ) : (
                  <div style={{width:42,height:42,borderRadius:"50%",background:C.accent+"33",display:"flex",
                               alignItems:"center",justifyContent:"center",flexShrink:0,color:C.accent,fontWeight:800}}>
                    {googleAccount.name?.[0] || "G"}
                  </div>
                )}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:C.text, fontWeight:700, fontSize:14 }}>{googleAccount.name}</div>
                  <div style={{ color:C.muted, fontSize:12, overflow:"hidden", textOverflow:"ellipsis" }}>{googleAccount.email}</div>
                </div>
                <button onClick={handleGoogleSignOut} style={{...bs, fontSize:11, padding:"5px 10px", flexShrink:0}}>Sign Out</button>
              </div>

              <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                <button onClick={handleGoogleBackup} disabled={googleBusy}
                  style={{...bp, flex:1, minWidth:140, padding:"10px", fontSize:13, opacity:googleBusy?0.6:1}}>
                  {googleBusy ? "Working…" : "☁ Backup Now"}
                </button>
                <button onClick={handleGoogleRestore} disabled={googleBusy}
                  style={{...bs, flex:1, minWidth:140, padding:"10px", fontSize:13, opacity:googleBusy?0.6:1}}>
                  {googleBusy ? "Working…" : "⬇ Restore from Drive"}
                </button>
              </div>
            </div>
          )}

          {googleStatus && (
            <div style={{
              background: googleStatus.type==="ok" ? C.green+"18" : "#ef444422",
              border:`1px solid ${googleStatus.type==="ok" ? C.green+"55" : "#ef444455"}`,
              borderRadius:8, padding:"12px 16px", color: googleStatus.type==="ok" ? C.green : "#f87171",
              fontSize:13, lineHeight:1.5, marginTop:14,
            }}>
              {googleStatus.type==="ok" ? "✓ " : "✕ "}{googleStatus.msg}
            </div>
          )}

          <div style={{ marginTop:18, color:C.dim, fontSize:11, lineHeight:1.6, borderTop:`1px solid ${C.border}`, paddingTop:14 }}>
            🔒 Your data is stored in a private app-only space in your own Google Drive —
            it isn't visible in your regular Drive files and isn't shared with anyone else.
          </div>
        </div>
      )}

      {/* Status message */}
      {status && (
        <div style={{
          background: status.type==="ok" ? C.green+"18" : "#ef444422",
          border:`1px solid ${status.type==="ok" ? C.green+"55" : "#ef444455"}`,
          borderRadius:8, padding:"12px 16px",
          color: status.type==="ok" ? C.green : "#f87171",
          fontSize:13, lineHeight:1.5, marginTop:8,
        }}>
          {status.type==="ok" ? "✓ " : "✕ "}{status.msg}
        </div>
      )}

      <div style={{ display:"flex",justifyContent:"flex-end",marginTop:20 }}>
        <button onClick={onClose} style={bs}>Close</button>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE SETUP / EDIT
// ═══════════════════════════════════════════════════════════════════════════════
function ProfileSetup({ onDone, initial }) {
  const [form, setForm] = useState(initial || { name:"", title:"", phone:"", avatar:null });
  const fileRef = useRef();
  const set = (k,v) => setForm(p=>({...p,[k]:v}));

  const pickAvatar = (e) => {
    const f = e.target.files[0]; if(!f) return;
    const r = new FileReader(); r.onload=ev=>set("avatar",ev.target.result); r.readAsDataURL(f);
  };
  const submit = () => { if(!form.name.trim()) return; onDone(form); };
  const is = getInputStyle();
  const bp = getBtnPrimary();

  return (
    <div style={{ minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:24 }}>
      <div style={{ background:C.card,border:`1px solid ${C.border2}`,borderRadius:16,padding:"40px 36px",width:"100%",maxWidth:440 }}>
        <div style={{ textAlign:"center",marginBottom:32 }}>
          <div style={{ margin:"0 auto 12px", display:"flex", justifyContent:"center" }}>
            <GearIcon size={44} color={C.accent}/>
          </div>
          <div style={{ color:C.text,fontWeight:800,fontSize:18,fontFamily:"'JetBrains Mono',monospace",letterSpacing:1 }}>
            {initial ? "Edit Profile" : "Welcome"}
          </div>
          <div style={{ color:C.muted,fontSize:13,marginTop:6 }}>
            {initial ? "Update your profile information" : "Set up your profile to get started"}
          </div>
        </div>

        <div style={{ textAlign:"center",marginBottom:24 }}>
          <div onClick={()=>fileRef.current.click()} style={{ width:80,height:80,borderRadius:"50%",background:C.surface,border:`2px dashed ${C.border2}`,cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",overflow:"hidden",transition:"border-color 0.2s" }}
            onMouseEnter={e=>e.currentTarget.style.borderColor=C.accent}
            onMouseLeave={e=>e.currentTarget.style.borderColor=C.border2}>
            {form.avatar ? <img src={form.avatar} style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <span style={{fontSize:28,color:C.dim}}>👤</span>}
          </div>
          <div style={{ color:C.muted,fontSize:11,marginTop:6 }}>Click to add photo</div>
          <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={pickAvatar}/>
        </div>

        <Field label="Full Name *">
          <input value={form.name} onChange={e=>set("name",e.target.value)} style={is} placeholder="e.g. Abdelrahman Hassan" autoFocus/>
        </Field>
        <Field label="Job Title">
          <input value={form.title||""} onChange={e=>set("title",e.target.value)} style={is} placeholder="e.g. Mechanical Installations Engineer"/>
        </Field>
        <Field label="Phone">
          <input value={form.phone||""} onChange={e=>set("phone",e.target.value)} style={is} placeholder="+20 ···"/>
        </Field>

        <button onClick={submit} style={{...bp,width:"100%",padding:"12px",fontSize:15,marginTop:8}}>
          {initial ? "Save Profile" : "Get Started →"}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY TASKS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY TASK ROW
// Extracted as its own component (was previously inline inside a .map() callback
// with hooks called directly in the loop — a Rules-of-Hooks violation that caused
// the app to crash whenever the list length changed, e.g. on delete). Each row
// now owns its own isolated hook state, safe to add/remove freely.
// ═══════════════════════════════════════════════════════════════════════════════
function DailyTaskRow({ t, tIdx, proj, pTasksLength, projects, onToggle, onReorder, onEditTask, onRemoveTask, onUpdateProject }) {
  const [panelEditing,  setPanelEditing]  = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [panelDraft,    setPanelDraft]    = useState(t.text);
  const [panelNote,     setPanelNote]     = useState(t.notes||"");
  const panelInputRef = useRef();
  const noteFileRef = useRef();
  const [uploadingImg, setUploadingImg] = useState(false);

  const commitPanelEdit = () => {
    const txt = panelDraft.trim();
    if (txt && txt !== t.text) onEditTask(proj.id, t.id, txt);
    setPanelEditing(false);
  };
  const commitNote = () => {
    const proj2 = projects.find(p=>p.id===proj.id);
    if(!proj2) return;
    const updated = {...proj2,tasks:{...proj2.tasks,daily:proj2.tasks.daily.map(tt=>tt.id===t.id?{...tt,notes:panelNote}:tt)}};
    onUpdateProject(updated);
  };

  // Attach a photo to this task's notes (e.g. site condition, defect, proof of work)
  const handleAddNoteImage = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingImg(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const proj2 = projects.find(p=>p.id===proj.id);
      if (!proj2) { setUploadingImg(false); return; }
      const newImg = { id: uid(), src: ev.target.result };
      const updated = {...proj2, tasks:{...proj2.tasks, daily: proj2.tasks.daily.map(tt =>
        tt.id===t.id ? {...tt, noteImages:[...(tt.noteImages||[]), newImg]} : tt
      )}};
      onUpdateProject(updated);
      setUploadingImg(false);
    };
    reader.onerror = () => setUploadingImg(false);
    reader.readAsDataURL(file);
  };

  const removeNoteImage = (imgId) => {
    const proj2 = projects.find(p=>p.id===proj.id);
    if (!proj2) return;
    // Best-effort IndexedDB cleanup for the underlying blob, if it was already persisted
    const task = (proj2.tasks.daily||[]).find(tt => tt.id===t.id);
    const img = task?.noteImages?.find(i => i.id===imgId);
    if (img?.src?.startsWith("tasknoteimg::")) idbDelete(img.src);
    const updated = {...proj2, tasks:{...proj2.tasks, daily: proj2.tasks.daily.map(tt =>
      tt.id===t.id ? {...tt, noteImages:(tt.noteImages||[]).filter(i=>i.id!==imgId)} : tt
    )}};
    onUpdateProject(updated);
  };

  const hasNote = !!(t.notes && t.notes.trim());
  const hasNoteImages = (t.noteImages||[]).length > 0;

  return (
    <div style={{ background:"transparent", borderBottom:`1px solid ${C.border}` }}>
      {/* Main row */}
      <div style={{ display:"flex",alignItems:"center",gap:6,padding:"7px 16px 7px 8px" }}>
        {/* Reorder */}
        <div style={{ display:"flex",flexDirection:"column",gap:1,flexShrink:0 }}>
          <button onClick={()=>onReorder(proj.id,tIdx,tIdx-1)} disabled={tIdx===0}
            style={{ background:"none",border:"none",color:tIdx===0?C.border2:C.dim,
                     cursor:tIdx===0?"default":"pointer",padding:"1px 4px",fontSize:10,lineHeight:1 }}>▲</button>
          <button onClick={()=>onReorder(proj.id,tIdx,tIdx+1)} disabled={tIdx===pTasksLength-1}
            style={{ background:"none",border:"none",color:tIdx===pTasksLength-1?C.border2:C.dim,
                     cursor:tIdx===pTasksLength-1?"default":"pointer",padding:"1px 4px",fontSize:10,lineHeight:1 }}>▼</button>
        </div>
        {/* Checkbox */}
        <button onClick={()=>onToggle(proj.id,t.id)}
          style={{ width:20,height:20,borderRadius:"50%",border:`2px solid ${t.done?C.green:C.dim}`,
                   background:t.done?C.green+"22":"transparent",cursor:"pointer",
                   display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
                   color:C.green,fontSize:11,transition:"all 0.2s" }}>
          {t.done&&"✓"}
        </button>
        {/* Text */}
        {panelEditing ? (
          <AutoResizeInput value={panelDraft} onChange={e=>setPanelDraft(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();commitPanelEdit();}if(e.key==="Escape"){setPanelDraft(t.text);setPanelEditing(false);}}}
            autoFocus
            style={{...getInputStyle(),flex:1,padding:"3px 7px",fontSize:13}}/>
        ) : (
          <span onDoubleClick={()=>{setPanelDraft(t.text);setPanelEditing(true);}}
            style={{ flex:1,color:t.done?C.dim:C.text,fontSize:13,
                     textDecoration:t.done?"line-through":"none",cursor:"text",
                     overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
            {t.text}
          </span>
        )}
        {/* Notes toggle */}
        {!panelEditing && (
          <button onClick={()=>setPanelExpanded(v=>!v)}
            style={{ background:panelExpanded?C.accent+"22":"none",
                     border:`1px solid ${panelExpanded?C.accent+"55":"transparent"}`,
                     color:panelExpanded?C.accent:C.dim,
                     borderRadius:5,cursor:"pointer",fontSize:10,padding:"2px 6px",
                     flexShrink:0,transition:"all 0.15s",fontFamily:"inherit",fontWeight:600 }}>
            {panelExpanded?"▲":"▼"}{(hasNote||hasNoteImages)?" ●":""}
          </button>
        )}
        {/* Edit */}
        {!panelEditing && (
          <button onClick={()=>{setPanelDraft(t.text);setPanelEditing(true);}}
            style={{ background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:11,opacity:0.6,flexShrink:0,padding:"0 2px" }}>✎</button>
        )}
        {/* Delete */}
        <button onClick={()=>onRemoveTask(proj.id,t.id)}
          style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:11,opacity:0.5,flexShrink:0,padding:"0 4px" }}>✕</button>
      </div>
      {/* Notes panel */}
      {panelExpanded && (
        <div style={{ padding:"10px 16px 12px 40px",background:C.surface }}>
          <div style={{ color:C.accent,fontSize:9,letterSpacing:1.5,textTransform:"uppercase",fontWeight:700,marginBottom:6,fontFamily:"'JetBrains Mono',monospace" }}>
            📋 Notes
          </div>
          <textarea value={panelNote} onChange={e=>setPanelNote(e.target.value)}
            onBlur={commitNote}
            placeholder="Add notes... e.g. Found 10 gates on site"
            style={{...getInputStyle(),width:"100%",minHeight:70,resize:"vertical",
                    fontSize:12,padding:"6px 10px",lineHeight:1.6,
                    borderColor:panelNote!==(t.notes||"")?C.accent:C.border2}}/>
          {panelNote !== (t.notes||"") && (
            <div style={{ display:"flex",gap:6,marginTop:6 }}>
              <button onClick={commitNote}
                style={{ background:C.accent,border:"none",borderRadius:6,color:"#fff",
                         padding:"5px 14px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit" }}>✓ Save</button>
              <button onClick={()=>setPanelNote(t.notes||"")}
                style={{ background:"none",border:`1px solid ${C.border2}`,borderRadius:6,color:C.muted,
                         padding:"5px 10px",cursor:"pointer",fontSize:11,fontFamily:"inherit" }}>Discard</button>
            </div>
          )}

          {/* Note images — photos attached to this task (site condition, proof of work, defects...) */}
          <div style={{ marginTop:10 }}>
            {hasNoteImages && (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(70px, 1fr))", gap:6, marginBottom:8 }}>
                {t.noteImages.map(img => (
                  <div key={img.id} style={{ position:"relative", borderRadius:6, overflow:"hidden", border:`1px solid ${C.border}` }}>
                    <img src={img.src} style={{ width:"100%", height:70, objectFit:"cover", display:"block" }}/>
                    <button onClick={()=>removeNoteImage(img.id)}
                      style={{ position:"absolute", top:2, right:2, background:"rgba(0,0,0,0.7)", border:"none",
                               color:C.red, borderRadius:5, width:18, height:18, cursor:"pointer", fontSize:10, lineHeight:1 }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <button onClick={()=>noteFileRef.current.click()} disabled={uploadingImg}
              style={{ background:"none", border:`1px dashed ${C.border2}`, color:C.dim,
                       borderRadius:6, padding:"5px 10px", cursor:"pointer", fontSize:10,
                       display:"flex", alignItems:"center", gap:5, fontFamily:"inherit",
                       opacity: uploadingImg ? 0.6 : 1 }}>
              📷 {uploadingImg ? "Uploading…" : "Add photo"}
            </button>
            <input ref={noteFileRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleAddNoteImage}/>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// PERSONAL TASK ROW
// Same pattern as DailyTaskRow (proper standalone component, not hooks-in-map)
// but for standalone personal tasks that aren't tied to any project.
// ═══════════════════════════════════════════════════════════════════════════════
function PersonalTaskRow({ t, tIdx, tasksLength, onToggle, onReorder, onEditTask, onRemoveTask, onUpdateNote }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.text);
  const [expanded, setExpanded] = useState(false);
  const [noteDraft, setNoteDraft] = useState(t.notes||"");
  const inputRef = useRef();

  const commitEdit = () => {
    const txt = draft.trim();
    if (txt && txt !== t.text) onEditTask(t.id, txt);
    setEditing(false);
  };
  const commitNote = () => onUpdateNote(t.id, noteDraft);

  const hasNote = !!(t.notes && t.notes.trim());

  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:9, marginBottom:8, overflow:"hidden" }}>
      <div style={{ display:"flex",alignItems:"center",gap:8,padding:"10px 12px" }}>
        <div style={{ display:"flex",flexDirection:"column",gap:1,flexShrink:0 }}>
          <button onClick={()=>onReorder(tIdx,tIdx-1)} disabled={tIdx===0}
            style={{ background:"none",border:"none",color:tIdx===0?C.border2:C.dim,
                     cursor:tIdx===0?"default":"pointer",padding:"1px 4px",fontSize:10,lineHeight:1 }}>▲</button>
          <button onClick={()=>onReorder(tIdx,tIdx+1)} disabled={tIdx===tasksLength-1}
            style={{ background:"none",border:"none",color:tIdx===tasksLength-1?C.border2:C.dim,
                     cursor:tIdx===tasksLength-1?"default":"pointer",padding:"1px 4px",fontSize:10,lineHeight:1 }}>▼</button>
        </div>
        <button onClick={()=>onToggle(t.id)}
          style={{ width:22,height:22,borderRadius:"50%",border:`2px solid ${t.done?C.green:C.dim}`,
                   background:t.done?C.green+"22":"transparent",cursor:"pointer",
                   display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
                   color:C.green,fontSize:12,transition:"all 0.2s" }}>
          {t.done&&"✓"}
        </button>
        {editing ? (
          <AutoResizeInput value={draft} onChange={e=>setDraft(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();commitEdit();}if(e.key==="Escape"){setDraft(t.text);setEditing(false);}}}
            autoFocus
            style={{...getInputStyle(),flex:1,padding:"4px 8px",fontSize:14}}/>
        ) : (
          <span onDoubleClick={()=>{setDraft(t.text);setEditing(true);}}
            style={{ flex:1,color:t.done?C.dim:C.text,fontSize:14,
                     textDecoration:t.done?"line-through":"none",cursor:"text",
                     overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
            {t.text}
          </span>
        )}
        {!editing && (
          <button onClick={()=>setExpanded(v=>!v)}
            style={{ background:expanded?C.accent+"22":"none",
                     border:`1px solid ${expanded?C.accent+"55":"transparent"}`,
                     color:expanded?C.accent:C.dim,
                     borderRadius:5,cursor:"pointer",fontSize:11,padding:"3px 7px",
                     flexShrink:0,fontFamily:"inherit",fontWeight:600 }}>
            {expanded?"▲":"▼"}{hasNote?" ●":""}
          </button>
        )}
        {!editing && (
          <button onClick={()=>{setDraft(t.text);setEditing(true);}}
            style={{ background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:12,opacity:0.6,flexShrink:0,padding:"0 3px" }}>✎</button>
        )}
        <button onClick={()=>onRemoveTask(t.id)}
          style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:12,opacity:0.5,flexShrink:0,padding:"0 4px" }}>✕</button>
      </div>
      {expanded && (
        <div style={{ padding:"0 12px 12px 44px",background:C.surface }}>
          <textarea value={noteDraft} onChange={e=>setNoteDraft(e.target.value)}
            onBlur={commitNote}
            placeholder="Add notes…"
            style={{...getInputStyle(),width:"100%",minHeight:60,resize:"vertical",
                    fontSize:12,padding:"6px 10px",lineHeight:1.6,
                    borderColor:noteDraft!==(t.notes||"")?C.accent:C.border2}}/>
          {noteDraft !== (t.notes||"") && (
            <div style={{ display:"flex",gap:6,marginTop:6 }}>
              <button onClick={commitNote}
                style={{ background:C.accent,border:"none",borderRadius:6,color:"#fff",
                         padding:"5px 14px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit" }}>✓ Save</button>
              <button onClick={()=>setNoteDraft(t.notes||"")}
                style={{ background:"none",border:`1px solid ${C.border2}`,borderRadius:6,color:C.muted,
                         padding:"5px 10px",cursor:"pointer",fontSize:11,fontFamily:"inherit" }}>Discard</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSONAL TASKS PANEL
// A standalone task list independent of any project — for general work matters
// (admin, personal reminders, things that don't belong to one specific site).
// Same interaction patterns as the per-project Daily list, just not grouped by
// project at all.
// ═══════════════════════════════════════════════════════════════════════════════
function PersonalTasksPanel({ tasks, onUpdateTasks, onClose }) {
  tasks = tasks || [];
  const [addText, setAddText] = useState("");
  const [filter, setFilter] = useState("all"); // all | pending | done

  const toggle = (id) => onUpdateTasks(tasks.map(t=>t.id===id?{...t,done:!t.done}:t));
  const reorder = (fromIdx, toIdx) => {
    if (toIdx<0 || toIdx>=tasks.length) return;
    const a = [...tasks];
    [a[fromIdx],a[toIdx]] = [a[toIdx],a[fromIdx]];
    onUpdateTasks(a);
  };
  const editTask = (id, text) => onUpdateTasks(tasks.map(t=>t.id===id?{...t,text}:t));
  const removeTask = (id) => onUpdateTasks(tasks.filter(t=>t.id!==id));
  const updateNote = (id, notes) => onUpdateTasks(tasks.map(t=>t.id===id?{...t,notes}:t));
  const addTask = () => {
    const text = addText.trim();
    if (!text) return;
    onUpdateTasks([...tasks, { id:uid(), text, done:false, date:today(), createdAt:Date.now(), notes:"" }]);
    setAddText("");
  };

  const filtered = tasks.filter(t => filter==="all" ? true : filter==="done" ? t.done : !t.done);
  const doneCount = tasks.filter(t=>t.done).length;
  const pct = tasks.length ? Math.round((doneCount/tasks.length)*100) : 0;
  const is = getInputStyle();
  const bp = getBtnPrimary();
  const bs = getBtnSecondary();

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:900,display:"flex",alignItems:"stretch",justifyContent:"flex-end" }}
         onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:C.card,borderLeft:`1px solid ${C.border2}`,width:"100%",maxWidth:480,display:"flex",flexDirection:"column",height:"100%",boxShadow:"-20px 0 60px rgba(0,0,0,0.6)" }}>

        <div style={{ padding:"22px 24px",borderBottom:`1px solid ${C.border}`,background:C.surface,flexShrink:0 }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14 }}>
            <div>
              <div style={{ color:C.accent,fontSize:11,letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:4 }}>
                📌 Personal Tasks
              </div>
              <div style={{ color:C.text,fontSize:16,fontWeight:800,fontFamily:"'JetBrains Mono',monospace" }}>
                Not tied to any project
              </div>
            </div>
            <button onClick={onClose} style={{...bs,padding:"7px 14px",fontSize:12}}>✕ Close</button>
          </div>

          {tasks.length > 0 && (
            <div style={{ display:"flex",alignItems:"center",gap:10 }}>
              <div style={{ flex:1,background:C.border,borderRadius:6,height:8,overflow:"hidden" }}>
                <div style={{ width:`${pct}%`,height:"100%",background:`linear-gradient(90deg,${C.accent},${C.accentDim})`,borderRadius:6,transition:"width 0.5s" }}/>
              </div>
              <span style={{ color:C.accent,fontWeight:800,fontSize:13,fontFamily:"'JetBrains Mono',monospace",minWidth:36 }}>{pct}%</span>
              <span style={{ color:C.muted,fontSize:12 }}>{doneCount}/{tasks.length}</span>
            </div>
          )}

          <div style={{ display:"flex",gap:6,marginTop:12 }}>
            {[["all","All"],["pending","Pending"],["done","Done"]].map(([k,lbl])=>(
              <button key={k} onClick={()=>setFilter(k)}
                style={{ background:filter===k?C.accent:"transparent", border:`1px solid ${filter===k?C.accent:C.border2}`,
                         color:filter===k?"#fff":C.muted, borderRadius:6, padding:"4px 12px",
                         cursor:"pointer", fontSize:11, fontWeight:600, fontFamily:"inherit" }}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex:1,overflowY:"auto",padding:"16px" }}>
          {filtered.length === 0 && (
            <div style={{ color:C.dim,fontSize:14,textAlign:"center",padding:"40px 0",fontStyle:"italic" }}>
              {tasks.length===0 ? "No personal tasks yet — add one below" : "Nothing here for this filter"}
            </div>
          )}
          {filtered.map((t) => {
            const realIdx = tasks.findIndex(x=>x.id===t.id);
            return (
              <PersonalTaskRow key={t.id} t={t} tIdx={realIdx} tasksLength={tasks.length}
                onToggle={toggle} onReorder={reorder} onEditTask={editTask}
                onRemoveTask={removeTask} onUpdateNote={updateNote}/>
            );
          })}
        </div>

        <div style={{ padding:"14px 16px",borderTop:`1px solid ${C.border}`,background:C.surface,flexShrink:0,display:"flex",gap:8,alignItems:"flex-end" }}>
          <AutoResizeInput value={addText} onChange={e=>setAddText(e.target.value)}
            placeholder="Add a personal task…"
            onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); addTask(); } }}
            style={{...is,flex:1,padding:"9px 12px",fontSize:14}}/>
          <button onClick={addTask} style={{...bp,padding:"0 18px",height:42,flexShrink:0}}>+ Add</button>
        </div>
      </div>
    </div>
  );
}

function DailyPanel({ projects, onUpdateProject, onClose, profile }) {
  const todayStr = today();
  const todayLabel = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});

  const allTasks = projects.flatMap(p =>
    (p.tasks.daily||[]).map(t => ({ ...t, projectId: p.id, projectName: p.name, statusColor: getStatus(p.status).color }))
  );
  const pending   = allTasks.filter(t => !t.done);
  const done      = allTasks.filter(t =>  t.done);
  const pctDone   = allTasks.length ? Math.round((done.length/allTasks.length)*100) : 0;

  const toggle = (projectId, taskId) => {
    const proj = projects.find(p=>p.id===projectId);
    if (!proj) return;
    const updated = { ...proj, tasks: { ...proj.tasks, daily: proj.tasks.daily.map(t=>t.id===taskId?{...t,done:!t.done}:t) } };
    onUpdateProject(updated);
  };

  const addTask = (projectId, text) => {
    const proj = projects.find(p=>p.id===projectId);
    if (!proj || !text.trim()) return;
    const updated = { ...proj, tasks: { ...proj.tasks, daily: [...(proj.tasks.daily||[]), {id:uid(),text:text.trim(),done:false,date:todayStr,createdAt:Date.now()}] } };
    onUpdateProject(updated);
  };

  const removeTask = (projectId, taskId) => {
    const proj = projects.find(p=>p.id===projectId);
    if (!proj) return;
    const updated = { ...proj, tasks: { ...proj.tasks, daily: proj.tasks.daily.filter(t=>t.id!==taskId) } };
    onUpdateProject(updated);
  };

  const editTask = (projectId, taskId, text) => {
    const proj = projects.find(p=>p.id===projectId);
    if (!proj) return;
    const updated = { ...proj, tasks: { ...proj.tasks, daily: proj.tasks.daily.map(t=>t.id===taskId?{...t,text}:t) } };
    onUpdateProject(updated);
  };

  const reorderTask = (projectId, fromIdx, toIdx) => {
    const proj = projects.find(p=>p.id===projectId);
    if (!proj) return;
    const arr = [...(proj.tasks.daily||[])];
    if (toIdx < 0 || toIdx >= arr.length) return;
    [arr[fromIdx], arr[toIdx]] = [arr[toIdx], arr[fromIdx]];
    const updated = { ...proj, tasks: { ...proj.tasks, daily: arr } };
    onUpdateProject(updated);
  };

  const bs = getBtnSecondary();
  const [reportCopied, setReportCopied] = useState(false);
  const [showReportMenu, setShowReportMenu] = useState(false);
  const [showArchive, setShowArchive] = useState(false);

  const shareText = async (text, title) => {
    if (navigator.share) {
      try {
        await navigator.share({ title, text });
        return;
      } catch { /* user cancelled or unsupported — fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      setReportCopied(true);
      setTimeout(()=>setReportCopied(false), 2000);
    } catch {
      alert(text); // last-resort fallback
    }
  };

  const handleShareReport = (period) => {
    setShowReportMenu(false);
    if (period === "daily") {
      shareText(generateDailyReport(projects, profile?.name), "Daily Site Report");
    } else if (period === "weekly") {
      shareText(generatePeriodReport(projects, profile?.name, 7), "Weekly Site Report");
    } else if (period === "monthly") {
      shareText(generatePeriodReport(projects, profile?.name, 30), "Monthly Site Report");
    }
  };

  // ── HTML Report with embedded photos ──────────────────────────────────────
  const handleHTMLReport = () => {
    setShowReportMenu(false);
    const todayStr = today();
    const dateLabel = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});

    // Collect all projects with tasks or active steps today
    const projectSections = projects.map(p => {
      const daily = (p.tasks?.daily||[]);
      const done    = daily.filter(t=>t.done);
      const pending = daily.filter(t=>!t.done);
      const active  = (p.steps||[]).filter(s=>s.status==="active");
      const overdue = (p.approvals||[]).filter(a=>a.status==="pending"&&a.dueDate&&a.dueDate<todayStr);
      // Collect note images from all tasks
      const noteImgs = daily.flatMap(t=>(t.noteImages||[]).map(img=>({...img, taskText:t.text, done:t.done})));
      // Gallery images
      const galleryImgs = (p.images||[]).filter(img=>img.src&&img.src.startsWith("data:"));
      if (!daily.length && !active.length && !overdue.length) return null;
      return { p, done, pending, active, overdue, noteImgs, galleryImgs };
    }).filter(Boolean);

    const tasksHTML = (items, icon, color) => items.map(t=>
      `<li style="margin:4px 0;color:#${color}">${icon} ${t.text}${t.notes?`<br><small style="color:#888;margin-left:20px">📝 ${t.notes}</small>`:""}</li>`
    ).join("");

    const imagesHTML = (imgs) => imgs.length===0 ? "" : `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0">
        ${imgs.map(img=>`
          <div style="position:relative">
            <img src="${img.src}" style="width:160px;height:120px;object-fit:cover;border-radius:8px;border:1px solid #333"/>
            ${img.takenAt||img.taskText?`<div style="font-size:10px;color:#888;margin-top:2px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${img.taskText||""}${img.takenAt?" · "+new Date(img.takenAt).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}):""}
            </div>`:""}
          </div>`).join("")}
      </div>`;

    const html = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily Site Report — ${dateLabel}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px}
  h1{color:#38bdf8;font-size:20px;margin:0 0 4px}
  .sub{color:#64748b;font-size:13px;margin:0 0 20px}
  .project{background:#1e293b;border-left:4px solid #38bdf8;border-radius:8px;padding:14px 16px;margin-bottom:14px}
  .project h2{margin:0 0 10px;font-size:15px;color:#f1f5f9}
  .project .meta{font-size:11px;color:#64748b;margin-bottom:8px}
  ul{margin:6px 0;padding-left:18px}
  li{font-size:13px;line-height:1.6}
  .section-label{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#38bdf8;font-weight:700;margin:10px 0 4px}
  .footer{margin-top:24px;text-align:center;color:#334155;font-size:11px}
</style>
</head>
<body>
<h1>📋 Daily Site Report</h1>
<p class="sub">📅 ${dateLabel}${profile?.name?" · 👤 "+profile.name:""}</p>
${projectSections.map(({p, done, pending, active, overdue, noteImgs, galleryImgs})=>`
<div class="project">
  <h2>🏗 ${p.name}</h2>
  <div class="meta">${[p.client,p.location].filter(Boolean).join(" · ")}</div>
  ${done.length?`<div class="section-label">✅ Completed (${done.length})</div><ul>${tasksHTML(done,"✅","86efac")}</ul>`:""}
  ${pending.length?`<div class="section-label">⏳ Pending (${pending.length})</div><ul>${tasksHTML(pending,"⏳","fbbf24")}</ul>`:""}
  ${active.length?`<div class="section-label">▶ In Progress</div><ul>${active.map(s=>`<li style="color:#93c5fd">▶ ${s.title}</li>`).join("")}</ul>`:""}
  ${overdue.length?`<div class="section-label">🔴 Overdue Approvals</div><ul>${overdue.map(a=>`<li style="color:#f87171">🔴 ${a.title}</li>`).join("")}</ul>`:""}
  ${noteImgs.length?`<div class="section-label">📷 Task Photos (${noteImgs.length})</div>${imagesHTML(noteImgs)}`:""}
  ${galleryImgs.length?`<div class="section-label">🖼 Site Gallery (${galleryImgs.length})</div>${imagesHTML(galleryImgs)}`:""}
</div>`).join("")}
<div class="footer">Generated by Mechanical Projects Manager</div>
</body></html>`;

    const blob = new Blob([html], {type:"text/html;charset=utf-8"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `Site-Report-${todayStr}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Download today's photos only ──────────────────────────────────────────
  const handleDownloadPhotos = () => {
    setShowReportMenu(false);
    const todayStr = today();
    let count = 0;

    projects.forEach(p => {
      // Note images from daily tasks
      (p.tasks?.daily||[]).forEach(t => {
        (t.noteImages||[]).forEach((img, idx) => {
          if (!img.src?.startsWith("data:")) return;
          const a    = document.createElement("a");
          a.href     = img.src;
          const ext  = img.src.startsWith("data:image/png") ? "png" : "jpg";
          a.download = `${p.name.replace(/\s+/g,"-")}_task-${t.text.slice(0,20).replace(/\s+/g,"-")}_${idx+1}.${ext}`;
          a.click();
          count++;
        });
      });
      // Gallery images
      (p.images||[]).forEach((img, idx) => {
        if (!img.src?.startsWith("data:")) return;
        const a    = document.createElement("a");
        a.href     = img.src;
        const ext  = img.src.startsWith("data:image/png") ? "png" : "jpg";
        a.download = `${p.name.replace(/\s+/g,"-")}_gallery_${todayStr}_${idx+1}.${ext}`;
        a.click();
        count++;
      });
    });

    if (count === 0) alert("No photos found across today's projects.");
  };

  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:900,display:"flex",alignItems:"stretch",justifyContent:"flex-end" }}
         onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:C.card,borderLeft:`1px solid ${C.border2}`,width:"100%",maxWidth:480,display:"flex",flexDirection:"column",height:"100%",boxShadow:"-20px 0 60px rgba(0,0,0,0.6)" }}>
        
        <div style={{ padding:"22px 24px",borderBottom:`1px solid ${C.border}`,background:C.surface,flexShrink:0 }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14 }}>
            <div>
              <div style={{ color:C.accent,fontSize:11,letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:4 }}>Daily Tasks</div>
              <div style={{ color:C.text,fontSize:16,fontWeight:800,fontFamily:"'JetBrains Mono',monospace" }}>{todayLabel}</div>
            </div>
            <div style={{ display:"flex",gap:8 }}>
              <div style={{ position:"relative" }}>
                <button onClick={()=>setShowReportMenu(v=>!v)}
                  style={{ background: reportCopied ? C.green+"22" : C.accent+"22",
                           border:`1px solid ${reportCopied ? C.green : C.accent}55`,
                           color: reportCopied ? C.green : C.accent,
                           borderRadius:8, padding:"7px 14px", cursor:"pointer", fontSize:12, fontWeight:700,
                           fontFamily:"inherit", transition:"all 0.2s" }}>
                  {reportCopied ? "✓ Copied" : "📤 Report ▾"}
                </button>
                {showReportMenu && (
                  <>
                    <div onClick={()=>setShowReportMenu(false)} style={{ position:"fixed", inset:0, zIndex:10 }}/>
                    <div style={{
                      position:"absolute", top:"110%", right:0, zIndex:11,
                      background:C.card, border:`1px solid ${C.border2}`, borderRadius:8,
                      boxShadow:"0 8px 24px rgba(0,0,0,0.4)", minWidth:190, overflow:"hidden",
                    }}>
                      {/* Text reports */}
                      <div style={{ padding:"6px 14px 4px", color:C.dim, fontSize:10, letterSpacing:1, textTransform:"uppercase" }}>Text Report</div>
                      {[["daily","📅 Daily"],["weekly","🗓 Weekly"],["monthly","📆 Monthly"]].map(([k,lbl])=>(
                        <button key={k} onClick={()=>handleShareReport(k)}
                          style={{ display:"block", width:"100%", textAlign:"left", background:"none", border:"none",
                                   color:C.text, padding:"9px 14px", cursor:"pointer", fontSize:12, fontFamily:"inherit" }}
                          onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                          onMouseLeave={e=>e.currentTarget.style.background="none"}>
                          {lbl}
                        </button>
                      ))}
                      {/* Separator */}
                      <div style={{ height:1, background:C.border, margin:"4px 0" }}/>
                      {/* With photos */}
                      <div style={{ padding:"6px 14px 4px", color:C.dim, fontSize:10, letterSpacing:1, textTransform:"uppercase" }}>With Photos</div>
                      <button onClick={handleHTMLReport}
                        style={{ display:"block", width:"100%", textAlign:"left", background:"none", border:"none",
                                 color:C.text, padding:"9px 14px", cursor:"pointer", fontSize:12, fontFamily:"inherit" }}
                        onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                        onMouseLeave={e=>e.currentTarget.style.background="none"}>
                        🌐 HTML Report + Photos
                      </button>
                      <button onClick={handleDownloadPhotos}
                        style={{ display:"block", width:"100%", textAlign:"left", background:"none", border:"none",
                                 color:C.text, padding:"9px 14px 12px", cursor:"pointer", fontSize:12, fontFamily:"inherit" }}
                        onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                        onMouseLeave={e=>e.currentTarget.style.background="none"}>
                        📷 Download Today's Photos
                      </button>
                    </div>
                  </>
                )}
              </div>
              <button onClick={()=>setShowArchive(v=>!v)}
                style={{...bs, padding:"7px 14px", fontSize:12,
                         borderColor: showArchive ? C.accent+"55" : C.border2,
                         color: showArchive ? C.accent : C.muted }}>
                📦 {showArchive ? "Tasks" : "Archive"}
              </button>
              <button onClick={onClose} style={{...bs,padding:"7px 14px",fontSize:12}}>✕ Close</button>
            </div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ flex:1,background:C.border,borderRadius:6,height:8,overflow:"hidden" }}>
              <div style={{ width:`${pctDone}%`,height:"100%",background:`linear-gradient(90deg,${C.accent},${C.accentDim})`,borderRadius:6,transition:"width 0.5s" }}/>
            </div>
            <span style={{ color:C.accent,fontWeight:800,fontSize:13,fontFamily:"'JetBrains Mono',monospace",minWidth:36 }}>{pctDone}%</span>
            <span style={{ color:C.muted,fontSize:12 }}>{done.length}/{allTasks.length}</span>
          </div>
        </div>

        {/* ── Cross-site "what's active right now" summary ── */}
        {(() => {
          const activeStepsAcrossSites = projects.flatMap(p =>
            (p.steps||[]).filter(s=>s.status==="active").map(s => ({...s, projectName:p.name, projectColor:getStatus(p.status).color}))
          );
          if (activeStepsAcrossSites.length === 0) return null;
          return (
            <div style={{ padding:"12px 24px", borderBottom:`1px solid ${C.border}`, background:C.surface }}>
              <div style={{ color:C.amber, fontSize:10, letterSpacing:1.5, textTransform:"uppercase",
                            fontWeight:700, marginBottom:8, fontFamily:"'JetBrains Mono',monospace" }}>
                ▶ Active Across Sites ({activeStepsAcrossSites.length})
              </div>
              {activeStepsAcrossSites.map(s=>(
                <div key={s.id} style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}>
                  <div style={{ width:3,height:14,borderRadius:2,background:s.projectColor,flexShrink:0 }}/>
                  <span style={{ color:C.dim,fontSize:11,flexShrink:0 }}>{s.projectName}:</span>
                  <span style={{ color:C.text,fontSize:12,flex:1 }}>{s.title}</span>
                </div>
              ))}
            </div>
          );
        })()}

        <div style={{ flex:1,overflowY:"auto",padding:"16px 0" }}>

          {/* ── Archive view ── */}
          {showArchive ? (
            <div style={{ padding:"0 16px" }}>
              <div style={{ color:C.accent, fontSize:11, letterSpacing:1.5, textTransform:"uppercase",
                            fontWeight:700, marginBottom:12, fontFamily:"'JetBrains Mono',monospace" }}>
                📦 Archived Tasks
              </div>
              {projects.every(p => !(p.tasks?.archived||[]).length) && (
                <div style={{ color:C.dim, fontSize:14, textAlign:"center", padding:"40px 0", fontStyle:"italic" }}>
                  No archived tasks yet — archive completed or old tasks from the rollover dialog.
                </div>
              )}
              {projects.filter(p=>(p.tasks?.archived||[]).length>0).map(p => (
                <div key={p.id} style={{ marginBottom:16 }}>
                  <div style={{ color:C.muted, fontSize:11, fontWeight:700, marginBottom:6 }}>{p.name}</div>
                  {(p.tasks.archived||[]).map(t => (
                    <div key={t.id} style={{
                      background:C.surface, border:`1px solid ${C.border}`,
                      borderRadius:8, padding:"8px 12px", marginBottom:6,
                      display:"flex", alignItems:"flex-start", gap:10,
                    }}>
                      <span style={{ color:C.green, fontSize:12, flexShrink:0, marginTop:1 }}>✓</span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ color:C.dim, fontSize:12, lineHeight:1.4 }}>{t.text}</div>
                        <div style={{ color:C.border2, fontSize:10, marginTop:2, fontFamily:"'JetBrains Mono',monospace" }}>
                          {t.date} · archived {new Date(t.archivedAt).toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
          <>
          {/*
            Dynamic project ordering: only show projects that actually have at least
            one daily task today, and order them by when their FIRST task was added
            (earliest createdAt wins), not by the fixed dashboard project order.
            Tasks created before this feature shipped have no createdAt — treat them
            as oldest (sort first), since they were logically "added" earliest.
          */}
          {projects
            .filter(p => (p.tasks.daily||[]).length > 0)
            .map(p => {
              const tasksList = p.tasks.daily || [];
              const earliestCreatedAt = tasksList.reduce((min, t) => {
                const ts = typeof t.createdAt === "number" ? t.createdAt : 0; // legacy tasks sort first
                return min === null ? ts : Math.min(min, ts);
              }, null);
              return { proj: p, earliestCreatedAt };
            })
            .sort((a, b) => a.earliestCreatedAt - b.earliestCreatedAt)
            .map(({ proj }) => (
              <DailyProjectGroup
                key={proj.id}
                proj={proj}
                projects={projects}
                onToggle={toggle}
                onReorder={reorderTask}
                onEditTask={editTask}
                onRemoveTask={removeTask}
                onUpdateProject={onUpdateProject}
                onAddTask={addTask}
              />
            ))}
          </>
          )} {/* end of archive/tasks toggle */}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY PROJECT GROUP
// One project's section within the Daily Panel — extracted as its own component
// for the same reason as DailyTaskRow: it previously had useState() called
// directly inside the outer .map(), which crashed the app whenever the list of
// projects-with-tasks shrank (e.g. deleting a project's last remaining task).
// ═══════════════════════════════════════════════════════════════════════════════
function DailyProjectGroup({ proj, projects, onToggle, onReorder, onEditTask, onRemoveTask, onUpdateProject, onAddTask }) {
  const [addText, setAddText] = useState("");
  const pTasks = (proj.tasks.daily||[]);
  const pColor = getStatus(proj.status).color;
  const is = getInputStyle();
  const bp = getBtnPrimary();

  return (
    <div style={{ marginBottom:4 }}>
      <div style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 24px",background:C.surface }}>
        <div style={{ width:3,height:16,borderRadius:2,background:pColor,flexShrink:0 }}/>
        <span style={{ color:C.text,fontWeight:700,fontSize:13,flex:1 }}>{proj.name}</span>
        <span style={{ color:C.dim,fontSize:11 }}>
          {pTasks.filter(t=>t.done).length}/{pTasks.length}
        </span>
      </div>

      {pTasks.length===0&&(
        <div style={{ color:C.dim,fontSize:13,padding:"8px 24px 8px 40px",fontStyle:"italic" }}>No tasks today</div>
      )}

      {pTasks.map((t,tIdx) => (
        <DailyTaskRow
          key={t.id}
          t={t}
          tIdx={tIdx}
          proj={proj}
          pTasksLength={pTasks.length}
          projects={projects}
          onToggle={onToggle}
          onReorder={onReorder}
          onEditTask={onEditTask}
          onRemoveTask={onRemoveTask}
          onUpdateProject={onUpdateProject}
        />
      ))}

      <div style={{ display:"flex",gap:6,padding:"6px 24px",alignItems:"flex-end" }}>
        <AutoResizeInput value={addText} onChange={e=>setAddText(e.target.value)}
          placeholder="Add task…"
          onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); onAddTask(proj.id,addText); setAddText(""); } }}
          style={{...is,fontSize:13,padding:"7px 10px",flex:1}}/>
        <button onClick={()=>{ onAddTask(proj.id,addText); setAddText(""); }}
          style={{...bp,padding:"0 12px",fontSize:13,flexShrink:0,height:38}}>+</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOUCH DRAG-AND-DROP HOOK (mobile + desktop)
// ═══════════════════════════════════════════════════════════════════════════════
function useTouchDragOrder(items, onReorder) {
  const dragIdx    = useRef(null);
  const overIdx    = useRef(null);
  const touchStart = useRef(null);

  // Desktop drag events
  const onDragStart = (idx) => { dragIdx.current = idx; };
  const onDragOver  = (e, idx) => { e.preventDefault(); overIdx.current = idx; };
  const onDrop      = () => {
    if (dragIdx.current === null || overIdx.current === null || dragIdx.current === overIdx.current) return;
    const arr = [...items];
    const [moved] = arr.splice(dragIdx.current, 1);
    arr.splice(overIdx.current, 0, moved);
    onReorder(arr);
    dragIdx.current = null; overIdx.current = null;
  };

  // Touch events for mobile
  const onTouchStart = useCallback((e, idx) => {
    dragIdx.current = idx;
    touchStart.current = { y: e.touches[0].clientY, idx };
  }, []);

  const onTouchMove = useCallback((e, idx, cardHeight) => {
    if (dragIdx.current === null || touchStart.current === null) return;
    e.preventDefault();
    const deltaY = e.touches[0].clientY - touchStart.current.y;
    const steps = Math.round(deltaY / (cardHeight || 120));
    const newOver = Math.max(0, Math.min(items.length - 1, touchStart.current.idx + steps));
    overIdx.current = newOver;
  }, [items.length]);

  const onTouchEnd = useCallback(() => {
    if (dragIdx.current !== null && overIdx.current !== null && dragIdx.current !== overIdx.current) {
      const arr = [...items];
      const [moved] = arr.splice(dragIdx.current, 1);
      arr.splice(overIdx.current, 0, moved);
      onReorder(arr);
    }
    dragIdx.current = null; overIdx.current = null; touchStart.current = null;
  }, [items, onReorder]);

  return { onDragStart, onDragOver, onDrop, onTouchStart, onTouchMove, onTouchEnd, overIdx };
}


// ═══════════════════════════════════════════════════════════════════════════════
// HOLD-TO-DRAG TAB REORDER HOOK (horizontal, long-press activated)
// ═══════════════════════════════════════════════════════════════════════════════
// Unlike the vertical project-card drag, this is horizontal AND requires a
// long-press (≈350ms) before drag mode activates. This avoids interfering with
// the normal single-tap that switches tabs, and avoids hijacking horizontal
// scroll on a tab bar that overflows on narrow screens.
function useHoldDragReorder(items, onReorder, { holdMs = 320 } = {}) {
  const [dragIdx, setDragIdx]   = useState(null);  // which index is currently being dragged
  const [overIdx, setOverIdx]   = useState(null);  // which index it's hovering over
  const holdTimer    = useRef(null);
  const startX       = useRef(0);
  const itemWidth     = useRef(80); // updated from actual DOM measurement on press
  const activatedRef  = useRef(false);
  const movedTooFar   = useRef(false); // if finger moves before hold completes, cancel (treat as scroll/tap)
  const activeElRef   = useRef(null);  // the DOM node currently being pressed/dragged

  const cancelHold = () => {
    clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  // touch-action must default to "auto" (normal scrolling) on every tab button so the
  // browser's native horizontal scroll works immediately. We only lock it to "none"
  // for the ONE element actually being dragged, and only once the hold has activated —
  // never before, and never on the whole tab bar. This is what lets a quick swipe
  // scroll the tab strip normally, while a deliberate long-press-then-drag reorders it.
  const onPressStart = (idx, clientX, widthHint, el) => {
    movedTooFar.current = false;
    activatedRef.current = false;
    startX.current = clientX;
    itemWidth.current = widthHint || 80;
    activeElRef.current = el || null;
    cancelHold();
    holdTimer.current = setTimeout(() => {
      if (!movedTooFar.current) {
        activatedRef.current = true;
        setDragIdx(idx);
        setOverIdx(idx);
        // Only NOW do we lock touch-action, after the hold has been confirmed as a drag gesture
        if (activeElRef.current) activeElRef.current.style.touchAction = "none";
        if (navigator.vibrate) navigator.vibrate(15);
      }
    }, holdMs);
  };

  const onPressMove = (clientX, e) => {
    const dx = clientX - startX.current;
    // Before activation: if finger moves more than a few px, this is a scroll/tap gesture — cancel the hold timer
    // and let the browser's native scroll handle it completely (we never called preventDefault, so nothing was blocked)
    if (!activatedRef.current) {
      if (Math.abs(dx) > 8) {
        movedTooFar.current = true;
        cancelHold();
      }
      return;
    }
    // After activation: we own the gesture now — prevent the page from also trying to scroll
    if (e && e.cancelable) e.preventDefault();
    if (dragIdx === null) return;
    const steps = Math.round(dx / itemWidth.current);
    const newOver = Math.max(0, Math.min(items.length - 1, dragIdx + steps));
    setOverIdx(newOver);
  };

  const onPressEnd = () => {
    cancelHold();
    if (activeElRef.current) activeElRef.current.style.touchAction = ""; // restore normal scrolling
    if (activatedRef.current && dragIdx !== null && overIdx !== null && dragIdx !== overIdx) {
      const arr = [...items];
      const [moved] = arr.splice(dragIdx, 1);
      arr.splice(overIdx, 0, moved);
      onReorder(arr);
    }
    setDragIdx(null);
    setOverIdx(null);
    activatedRef.current = false;
    activeElRef.current = null;
  };

  return {
    dragIdx, overIdx, isDragging: dragIdx !== null,
    onPressStart, onPressMove, onPressEnd,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT CARD
// ═══════════════════════════════════════════════════════════════════════════════
function ProjectCard({ project, onClick, onDelete, dragHandlers, isDragging, isOver }) {
  const st = getStatus(project.status);
  const pendingTasks = [...(project.tasks.daily||[]),(project.tasks.weekly||[])].filter(t=>!t.done).length;
  const pendingDocs  = (project.approvals||[]).filter(a=>a.status==="pending").length;
  const cardRef = useRef();

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={dragHandlers.dragStart}
      onDragOver={dragHandlers.dragOver}
      onDrop={dragHandlers.drop}
      style={{
        background:C.card, border:`1px solid ${isOver ? C.accent : C.border}`,
        borderRadius:13, overflow:"hidden",
        cursor:"default", transition:"all 0.2s",
        opacity:isDragging?0.45:1,
        transform: isOver ? "scale(1.02)" : "none",
        boxShadow:isDragging?"none": isOver ? `0 8px 32px ${C.accent}33` : "0 2px 12px rgba(0,0,0,0.3)",
        // NO touchAction here — let scroll work normally on the card body
      }}
      onMouseEnter={e=>{ if(!isDragging){e.currentTarget.style.borderColor=st.color+"88";e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 8px 24px rgba(0,0,0,0.4)`;} }}
      onMouseLeave={e=>{ e.currentTarget.style.borderColor=isOver?C.accent:C.border;e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="0 2px 12px rgba(0,0,0,0.3)"; }}>
      
      {project.coverImage ? (
        <div style={{ height:90,overflow:"hidden",position:"relative" }}>
          <img src={project.coverImage} style={{ width:"100%",height:"100%",objectFit:"cover" }}/>
          <div style={{ position:"absolute",inset:0,background:"linear-gradient(to bottom,transparent 40%,rgba(10,22,40,0.9))" }}/>
          <div style={{ position:"absolute",bottom:8,left:12 }}>
            <Badge color={st.color} label={st.en}/>
          </div>
        </div>
      ) : (
        <div style={{ height:4,background:`linear-gradient(90deg,${st.color},${st.color}88)` }}/>
      )}

      <div onClick={onClick} style={{ padding:"14px 16px 10px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8 }}>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ color:C.text,fontWeight:700,fontSize:15,marginBottom:3,lineHeight:1.3 }}>{project.name}</div>
            <div style={{ color:C.muted,fontSize:12,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{project.client}</div>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:6,marginLeft:8,flexShrink:0 }}>
            {!project.coverImage && <Badge color={st.color} label={st.en}/>}
            <button onClick={e=>{e.stopPropagation();if(confirm("Delete this project?"))onDelete();}}
              style={{ background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:13,padding:2,lineHeight:1 }}>✕</button>
          </div>
        </div>

        <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10 }}>
          <div style={{ flex:1,background:C.border,borderRadius:4,height:4,overflow:"hidden" }}>
            <div style={{ width:`${project.progress}%`,height:"100%",background:`linear-gradient(90deg,${C.accent},${C.accentDim})`,borderRadius:4,transition:"width 0.6s" }}/>
          </div>
          <span style={{ color:C.accent,fontSize:11,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",minWidth:30 }}>{project.progress}%</span>
        </div>

        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div style={{ color:C.dim,fontSize:11 }}>{project.discipline} · {project.location}</div>
          <div style={{ display:"flex",gap:6 }}>
            {pendingTasks>0 && <span style={{ background:C.accent+"22",color:C.accent,borderRadius:20,padding:"2px 8px",fontSize:11,fontWeight:700 }}>{pendingTasks} tasks</span>}
            {pendingDocs>0  && <span style={{ background:C.red+"22",color:C.red,borderRadius:20,padding:"2px 8px",fontSize:11,fontWeight:700 }}>{pendingDocs} docs</span>}
          </div>
        </div>
      </div>

      {/* Drag handle — ONLY this zone activates touch drag, leaving the rest of the card scrollable */}
      <div
        onTouchStart={(e) => { e.stopPropagation(); dragHandlers.touchStart(e, cardRef.current?.offsetHeight); }}
        onTouchMove={(e) => { e.stopPropagation(); dragHandlers.touchMove(e, cardRef.current?.offsetHeight); }}
        onTouchEnd={(e)  => { e.stopPropagation(); dragHandlers.touchEnd(); }}
        style={{
          display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          padding:"8px 16px", borderTop:`1px solid ${C.border}`,
          color:C.dim, fontSize:12, letterSpacing:0.5, userSelect:"none",
          cursor:"grab", touchAction:"none",   // ← none ONLY here
          background: C.surface + "80",
        }}>
        <span style={{ fontSize:16, lineHeight:1 }}>⠿</span>
        <span style={{ fontSize:10, letterSpacing:1, textTransform:"uppercase" }}>Hold to reorder</span>
        <span style={{ fontSize:16, lineHeight:1 }}>⠿</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT HEALTH PANEL
// One-glance view across all projects: actual progress, overdue tasks/approvals,
// and last activity — sorted so the project needing the most attention is on top.
// ═══════════════════════════════════════════════════════════════════════════════
function computeProjectHealth(p) {
  const todayStr = today();
  const steps = p.steps || [];
  const doneSteps = steps.filter(s => s.status === "done").length;
  const stepProgress = steps.length ? Math.round((doneSteps / steps.length) * 100) : null;

  const dailyTasks = p.tasks?.daily || [];
  const overdueTasks = dailyTasks.filter(t => !t.done && t.date && t.date < todayStr).length;
  const pendingTasks = dailyTasks.filter(t => !t.done).length;

  const approvals = p.approvals || [];
  const overdueApprovals = approvals.filter(a => a.status==="pending" && a.dueDate && a.dueDate < todayStr).length;

  // Last activity: most recent createdAt across tasks, or most recent comment timestamp across steps
  let lastActivity = null;
  dailyTasks.forEach(t => { if (typeof t.createdAt === "number") lastActivity = Math.max(lastActivity||0, t.createdAt); });
  steps.forEach(s => (s.comments||[]).forEach(c => {
    const ts = new Date(c.at).getTime();
    if (!isNaN(ts)) lastActivity = Math.max(lastActivity||0, ts);
  }));

  // Schedule-based delay detection: compare ACTUAL step progress to the EXPECTED
  // progress given how much of the start→end window has elapsed. A project that's
  // 80% through its timeline but only 30% through its steps is meaningfully behind.
  let isDelayed = false;
  let expectedProgress = null;
  if (p.startDate && p.endDate && stepProgress !== null && p.status === "active") {
    const start = new Date(p.startDate).getTime();
    const end   = new Date(p.endDate).getTime();
    const now   = Date.now();
    if (end > start && now > start) {
      const elapsedRatio = Math.min(1, (now - start) / (end - start));
      expectedProgress = Math.round(elapsedRatio * 100);
      // Flag as delayed only once there's a MEANINGFUL gap (>20 points) — avoids
      // noisy false positives from normal day-to-day variance early in a project.
      isDelayed = expectedProgress - stepProgress > 20;
    }
  }

  // Simple urgency score — higher means needs more attention. Used purely for sort order.
  const urgency = overdueApprovals*10 + overdueTasks*3 + (isDelayed ? 5 : 0) + (stepProgress !== null && stepProgress < 30 ? 2 : 0);

  return { stepProgress, overdueTasks, pendingTasks, overdueApprovals, lastActivity, urgency, isDelayed, expectedProgress };
}

function ProjectHealthPanel({ projects, onSelect }) {
  const [collapsed, setCollapsed] = useState(true);
  if (projects.length === 0) return null;

  const withHealth = projects
    .map(p => ({ project: p, health: computeProjectHealth(p) }))
    .sort((a, b) => b.health.urgency - a.health.urgency);

  const formatLastActivity = (ts) => {
    if (!ts) return "No recent activity";
    const diffMs = Date.now() - ts;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(ts).toLocaleDateString("en-GB", { day:"2-digit", month:"short" });
  };

  const needingAttentionCount = withHealth.filter(({health:h}) =>
    h.overdueApprovals > 0 || h.overdueTasks > 0 || h.isDelayed
  ).length;

  return (
    <div style={{ marginBottom:24 }}>
      <div onClick={()=>setCollapsed(v=>!v)}
        style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", marginBottom: collapsed ? 0 : 12 }}>
        <span style={{ color:C.dim, fontSize:11, transform: collapsed ? "rotate(-90deg)" : "none", transition:"transform 0.15s" }}>▾</span>
        <span style={{ color:C.text, fontSize:13, fontWeight:800, letterSpacing:0.5, textTransform:"uppercase" }}>
          📊 Project Health
        </span>
        {needingAttentionCount > 0 && (
          <span style={{ background:C.red+"22", border:`1px solid ${C.red}55`, color:C.red,
                         borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:700 }}>
            {needingAttentionCount} need{needingAttentionCount===1?"s":""} attention
          </span>
        )}
      </div>

      {!collapsed && (
        <div style={{ display:"grid", gap:8 }}>
          {withHealth.map(({ project: p, health: h }) => {
            const st = getStatus(p.status);
            const needsAttention = h.overdueApprovals > 0 || h.overdueTasks > 0 || h.isDelayed;
            return (
              <div key={p.id} onClick={()=>onSelect(p.id)}
                style={{
                  display:"flex", alignItems:"center", gap:14, cursor:"pointer",
                  background:C.card,
                  border:`1px solid ${(h.overdueApprovals>0||h.overdueTasks>0) ? C.red+"44" : h.isDelayed ? C.amber+"44" : C.border}`,
                  borderLeft:`3px solid ${st.color}`, borderRadius:9, padding:"12px 16px",
                  transition:"border-color 0.15s",
                }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:C.text, fontWeight:700, fontSize:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {p.name}
                  </div>
                  <div style={{ color:C.dim, fontSize:11, marginTop:2 }}>
                    {formatLastActivity(h.lastActivity)}
                  </div>
                </div>

                {/* Step progress */}
                {h.stepProgress !== null && (
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0, minWidth:90 }}>
                    <div style={{ width:50, height:5, background:C.border, borderRadius:3, overflow:"hidden" }}>
                      <div style={{ width:`${h.stepProgress}%`, height:"100%", background: h.stepProgress===100 ? C.green : C.accent }}/>
                    </div>
                    <span style={{ color:C.muted, fontSize:11, fontFamily:"'JetBrains Mono',monospace" }}>{h.stepProgress}%</span>
                  </div>
                )}

                {/* Pending tasks */}
                {h.pendingTasks > 0 && (
                  <Badge color={h.overdueTasks>0 ? C.red : C.muted} label={`${h.pendingTasks} task${h.pendingTasks!==1?"s":""}`}/>
                )}

                {/* Overdue approvals */}
                {h.overdueApprovals > 0 && (
                  <Badge color={C.red} label={`${h.overdueApprovals} overdue approval${h.overdueApprovals!==1?"s":""}`}/>
                )}

                {/* Behind schedule — actual progress trails expected progress by a meaningful margin */}
                {h.isDelayed && (
                  <Badge color={C.amber} label={`⏱ Behind schedule (${h.stepProgress}% vs ${h.expectedProgress}% expected)`}/>
                )}

                {!needsAttention && !h.isDelayed && h.overdueTasks===0 && h.overdueApprovals===0 && h.pendingTasks===0 && (
                  <span style={{ color:C.green, fontSize:11, fontWeight:700, flexShrink:0 }}>✓ On track</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Dashboard({ projects, data, onSelect, onAddNew, onDelete, onReorder, profile, onOpenDaily, notifDismissed, onDismissNotif }) {
  const [filter, setFilter]   = useState("all");
  const [search, setSearch]   = useState("");
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  const filtered = projects
    .filter(p => filter==="all" || p.status===filter)
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || (p.client||"").toLowerCase().includes(search.toLowerCase()));

  const handleReorder = useCallback((reordered) => {
    const reorderedIds = reordered.map(p=>p.id);
    const full = [...projects].sort((a,b) => {
      const ai = reorderedIds.indexOf(a.id), bi = reorderedIds.indexOf(b.id);
      if(ai===-1 && bi===-1) return 0;
      if(ai===-1) return 1;
      if(bi===-1) return -1;
      return ai-bi;
    });
    onReorder(full);
  }, [projects, onReorder]);

  const { onDragStart, onDragOver, onDrop, onTouchStart, onTouchMove, onTouchEnd } =
    useTouchDragOrder(filtered, handleReorder);

  const statusCounts = STATUS_OPTS.map(s => ({ ...s, count: projects.filter(p=>p.status===s.value).length }));
  const allPendingToday = projects.reduce((n,p) => n + (p.tasks.daily||[]).filter(t=>!t.done).length, 0);
  const firstName = profile?.name?.split(" ")[0] || "Engineer";
  const is = getInputStyle();
  const bp = getBtnPrimary();

  return (
    <div style={{ padding:"24px 28px",maxWidth:1200,margin:"0 auto" }}>

      {/* Greeting */}
      <div style={{ marginBottom:20 }}>
        <div style={{ color:C.muted,fontSize:13,marginBottom:4 }}>
          {new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
        </div>
        <div style={{ color:C.text,fontSize:22,fontWeight:800,fontFamily:"'JetBrains Mono',monospace" }}>
          Welcome, <span style={{ color:C.accent }}>{firstName}</span>
        </div>
      </div>

      {/* Backup reminder — shown above notifications since data safety comes first */}
      {data && <AutoBackupReminder data={data}/>}

      {/* Notification Banner */}
      {!notifDismissed && (
        <NotificationBanner
          projects={projects}
          onDismiss={onDismissNotif}
          onOpenDaily={onOpenDaily}
          onOpenApprovals={()=>{
            // Jump to the first project that has an overdue or due-soon approval
            const todayStr = today();
            const target = projects.find(p => (p.approvals||[]).some(a =>
              a.status==="pending" && a.dueDate && (new Date(a.dueDate)-new Date(todayStr)) <= 3*86400000
            ));
            if (target) onSelect(target.id);
          }}
        />
      )}

      {/* Project Health — sorted by urgency, jump straight into a project that needs attention */}
      <ProjectHealthPanel projects={projects} onSelect={onSelect}/>

      {/* KPI row */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:12,marginBottom:28 }}>
        {[
          { label:"Total Projects", val:projects.length, color:C.accent },
          { label:"Active",         val:projects.filter(p=>p.status==="active").length, color:C.green },
          { label:"Pending Tasks",  val:allPendingToday, color:C.amber },
          { label:"Provisional H/O",val:statusCounts.find(s=>s.value==="handover1")?.count||0, color:C.blue },
          { label:"Closed",         val:statusCounts.find(s=>s.value==="closed")?.count||0, color:C.dim },
        ].map(k => (
          <div key={k.label} style={{ background:C.card,border:`1px solid ${C.border}`,borderRadius:11,padding:"16px 18px" }}>
            <div style={{ color:k.color,fontWeight:800,fontSize:26,fontFamily:"'JetBrains Mono',monospace",lineHeight:1 }}>{k.val}</div>
            <div style={{ color:C.muted,fontSize:11,marginTop:6,letterSpacing:0.3 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display:"flex",gap:8,marginBottom:20,flexWrap:"wrap",alignItems:"center" }}>
        <input placeholder="Search projects…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{...is,maxWidth:220,flex:1}}/>

        <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
          {[{value:"all",en:"All",color:C.accent},...STATUS_OPTS].map(s=>(
            <button key={s.value} onClick={()=>setFilter(s.value)}
              style={{ background:filter===s.value?s.color+"22":C.surface,
                       border:`1px solid ${filter===s.value?s.color:C.border2}`,
                       color:filter===s.value?s.color:C.muted,
                       padding:"7px 13px",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,transition:"all 0.15s",fontFamily:"inherit" }}>
              {s.en}
            </button>
          ))}
        </div>

        <button onClick={onOpenDaily}
          style={{ background:allPendingToday>0?C.accent+"20":C.surface,border:`1px solid ${allPendingToday>0?C.accent:C.border2}`,
                   color:allPendingToday>0?C.accent:C.muted,
                   padding:"7px 16px",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,
                   display:"flex",alignItems:"center",gap:6,transition:"all 0.15s",fontFamily:"inherit" }}>
          ☑ Daily Tasks
          {allPendingToday>0 && <span style={{ background:C.accent,color:"#fff",borderRadius:12,padding:"0px 7px",fontSize:11,fontWeight:800 }}>{allPendingToday}</span>}
        </button>

        <button onClick={onAddNew} style={{...bp,marginLeft:"auto",whiteSpace:"nowrap"}}>+ New Project</button>
      </div>

      {/* Grid */}
      {filtered.length===0 ? (
        <div style={{ color:C.dim,textAlign:"center",padding:"72px 0",fontSize:15 }}>
          No projects found. Click <span style={{color:C.accent}}>+ New Project</span> to get started.
        </div>
      ) : (
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:16 }}>
          {filtered.map((p,idx) => (
            <ProjectCard key={p.id} project={p}
              onClick={()=>onSelect(p.id)}
              onDelete={()=>onDelete(p.id)}
              isDragging={draggingIdx===idx}
              isOver={overIdx===idx && draggingIdx!==idx}
              dragHandlers={{
                dragStart:  ()=>{ setDraggingIdx(idx); onDragStart(idx); },
                dragOver:   (e)=>{ onDragOver(e,idx); setOverIdx(idx); },
                drop:       ()=>{ setDraggingIdx(null); setOverIdx(null); onDrop(); },
                touchStart: (e, h)=>{ setDraggingIdx(idx); onTouchStart(e, idx); },
                touchMove:  (e, h)=>{ onTouchMove(e, idx, h); },
                touchEnd:   ()=>{ setDraggingIdx(null); setOverIdx(null); onTouchEnd(); },
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS TAB
// ═══════════════════════════════════════════════════════════════════════════════
function SortableTaskItem({ task, onToggle, onRemove, onEdit, onNoteChange, onMoveUp, onMoveDown, isFirst, isLast }) {
  const [editing,  setEditing]  = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft,    setDraft]    = useState(task.text);
  const [noteDraft,setNoteDraft]= useState(task.notes||"");
  const inputRef = useRef();
  const noteRef  = useRef();

  const commitEdit = () => {
    const t = draft.trim();
    if (t && t !== task.text) onEdit(t);
    setEditing(false);
  };
  const commitNote = () => {
    onNoteChange(noteDraft);
  };

  useEffect(() => { if (editing)  inputRef.current?.focus(); }, [editing]);
  useEffect(() => { if (expanded && !editing) noteRef.current?.focus(); }, [expanded]);

  const hasNote = !!(task.notes && task.notes.trim());
  const is = getInputStyle();

  return (
    <div style={{
      background:C.card, border:`1px solid ${expanded ? C.accent+"66" : C.border}`,
      borderRadius:9, marginBottom:6, overflow:"hidden",
      transition:"border-color 0.2s",
    }}>
      {/* ── Main row ── */}
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 8px 9px 0" }}>

        {/* Reorder arrows */}
        <div style={{ display:"flex",flexDirection:"column",gap:1,padding:"0 6px",flexShrink:0 }}>
          <button onClick={onMoveUp} disabled={isFirst}
            style={{ background:"none",border:"none",color:isFirst?C.border2:C.muted,
                     cursor:isFirst?"default":"pointer",padding:"2px 5px",fontSize:11,lineHeight:1,borderRadius:3 }}>▲</button>
          <button onClick={onMoveDown} disabled={isLast}
            style={{ background:"none",border:"none",color:isLast?C.border2:C.muted,
                     cursor:isLast?"default":"pointer",padding:"2px 5px",fontSize:11,lineHeight:1,borderRadius:3 }}>▼</button>
        </div>

        {/* Checkbox */}
        <button onClick={onToggle}
          style={{ width:22,height:22,borderRadius:"50%",border:`2px solid ${task.done?C.green:C.dim}`,
                   background:task.done?C.green+"22":"transparent",cursor:"pointer",
                   display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
                   color:C.green,fontSize:12,transition:"all 0.2s" }}>
          {task.done && "✓"}
        </button>

        {/* Text / inline editor */}
        {editing ? (
          <input ref={inputRef} value={draft} onChange={e=>setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e=>{ if(e.key==="Enter") commitEdit(); if(e.key==="Escape"){setDraft(task.text);setEditing(false);} }}
            style={{...is, flex:1, padding:"4px 8px", fontSize:14, height:32}}/>
        ) : (
          <span onDoubleClick={()=>{ setDraft(task.text); setEditing(true); }}
            style={{ flex:1,color:task.done?C.dim:C.text,fontSize:14,
                     textDecoration:task.done?"line-through":"none",lineHeight:1.4,
                     wordBreak:"break-word" }}>
            {task.text}
          </span>
        )}

        {/* Note indicator dot */}
        {hasNote && !expanded && (
          <div title="Has notes" style={{ width:7,height:7,borderRadius:"50%",background:C.amber,flexShrink:0,marginRight:2 }}/>
        )}

        {/* Expand notes button */}
        {!editing && (
          <button onClick={()=>setExpanded(v=>!v)}
            style={{ background: expanded ? C.accent+"22" : "none",
                     border: `1px solid ${expanded ? C.accent+"66" : "transparent"}`,
                     color: expanded ? C.accent : C.dim,
                     borderRadius:6, cursor:"pointer",
                     fontSize:11, flexShrink:0, padding:"3px 7px",
                     transition:"all 0.15s", fontFamily:"inherit", fontWeight:600 }}
            title={expanded?"Close notes":"Open notes"}>
            {expanded ? "▲ Notes" : `▼ Notes${hasNote?" ●":""}`}
          </button>
        )}

        {/* Edit pencil */}
        {!editing && (
          <button onClick={()=>{ setDraft(task.text); setEditing(true); }}
            style={{ background:"none",border:"none",color:C.dim,cursor:"pointer",
                     fontSize:13,flexShrink:0,padding:"0 3px",opacity:0.6 }}
            title="Edit task text">✎</button>
        )}

        {/* Delete */}
        <button onClick={onRemove}
          style={{ background:"none",border:"none",color:C.red,cursor:"pointer",
                   fontSize:14,flexShrink:0,padding:"0 8px",opacity:0.6 }}>✕</button>
      </div>

      {/* ── Expandable notes panel ── */}
      {expanded && (
        <div style={{
          borderTop:`1px solid ${C.border}`,
          background:C.surface,
          padding:"12px 14px 14px 14px",
        }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8 }}>
            <div style={{ color:C.accent,fontSize:10,letterSpacing:1.5,textTransform:"uppercase",
                          fontWeight:700,fontFamily:"'JetBrains Mono',monospace" }}>
              📋 Task Notes
            </div>
            <MicButton size={26} onResult={(text)=>{
              const updated = noteDraft ? `${noteDraft} ${text}` : text;
              setNoteDraft(updated);
              onNoteChange(updated);
            }}/>
          </div>
          <textarea
            ref={noteRef}
            value={noteDraft}
            onChange={e=>setNoteDraft(e.target.value)}
            onBlur={commitNote}
            placeholder={`Add notes for this task...
e.g. Found 10 gates on site, 3 need replacement`}
            style={{
              ...is,
              width:"100%", minHeight:90, resize:"vertical",
              lineHeight:1.7, padding:"10px 12px", fontSize:13,
              boxSizing:"border-box",
              borderColor: noteDraft !== (task.notes||"") ? C.accent : C.border2,
            }}
          />
          {noteDraft !== (task.notes||"") && (
            <div style={{ display:"flex",gap:8,marginTop:8 }}>
              <button onClick={commitNote}
                style={{ background:C.accent,border:"none",borderRadius:7,color:"#fff",
                         padding:"6px 16px",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit" }}>
                ✓ Save Note
              </button>
              <button onClick={()=>setNoteDraft(task.notes||"")}
                style={{ background:"none",border:`1px solid ${C.border2}`,borderRadius:7,color:C.muted,
                         padding:"6px 12px",cursor:"pointer",fontSize:12,fontFamily:"inherit" }}>
                Discard
              </button>
            </div>
          )}
          {hasNote && noteDraft === task.notes && (
            <div style={{ marginTop:8,color:C.dim,fontSize:11 }}>✓ Saved · click to edit</div>
          )}
        </div>
      )}
    </div>
  );
}

function TasksTab({ tasks, type, onUpdate }) {
  const todayStr = today();
  const items    = tasks || [];

  const toggle    = (id)        => onUpdate(items.map(t=>t.id===id?{...t,done:!t.done}:t));
  const remove    = (id)        => onUpdate(items.filter(t=>t.id!==id));
  const edit      = (id, text)  => onUpdate(items.map(t=>t.id===id?{...t,text}:t));
  const editNote  = (id, notes) => onUpdate(items.map(t=>t.id===id?{...t,notes}:t));
  const addTask   = (text)      => onUpdate([...items, {id:uid(),text,done:false,date:todayStr,notes:"",createdAt:Date.now()}]);
  const moveUp    = (idx) => { if(idx===0) return; const a=[...items]; [a[idx-1],a[idx]]=[a[idx],a[idx-1]]; onUpdate(a); };
  const moveDown  = (idx) => { if(idx===items.length-1) return; const a=[...items]; [a[idx],a[idx+1]]=[a[idx+1],a[idx]]; onUpdate(a); };

  const done = items.filter(t=>t.done);

  return (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
        <SectionLabel>{type==="daily"?"Daily Tasks":"Weekly Tasks"}</SectionLabel>
        <div style={{ color:C.muted,fontSize:11 }}>{done.length}/{items.length} done · ✎ to edit</div>
      </div>

      {items.length===0 && (
        <div style={{ color:C.dim,fontSize:14,textAlign:"center",padding:"40px 0",border:`1px dashed ${C.border2}`,borderRadius:9 }}>
          No tasks yet — add one below
        </div>
      )}

      {items.map((t,idx)=>(
        <SortableTaskItem key={t.id} task={t}
          onToggle={()=>toggle(t.id)}
          onRemove={()=>remove(t.id)}
          onEdit={(text)=>edit(t.id,text)}
          onNoteChange={(notes)=>editNote(t.id,notes)}
          onMoveUp={()=>moveUp(idx)}
          onMoveDown={()=>moveDown(idx)}
          isFirst={idx===0}
          isLast={idx===items.length-1}
        />
      ))}

      <AddRow placeholder={`Add ${type} task...`} onAdd={addTask}/>
    </div>
  );
}

// PROCUREMENT TAB
// ═══════════════════════════════════════════════════════════════════════════════
function ProcurementTab({ items, onUpdate, projectName }) {
  items = items||[];
  const setStatus = (id,s)  => onUpdate(items.map(i=>i.id===id?{...i,status:s}:i));
  const setField  = (id,k,v)=> onUpdate(items.map(i=>i.id===id?{...i,[k]:v}:i));
  const remove    = (id)    => onUpdate(items.filter(i=>i.id!==id));
  const add = ({item,qty,supplier}) => {
    if(!item?.trim()) return;
    onUpdate([...items,{id:uid(),item:item.trim(),qty:qty||"1",unit:"No.",status:"pending",supplier:supplier||""}]);
  };
  const is=getInputStyle();
  const bs=getBtnSecondary();

  // ── Share mode: pick which rows to include, then send via native share / clipboard ──
  const [shareMode, setShareMode]   = useState(false);
  const [selected, setSelected]     = useState(() => new Set());
  const [shareCopied, setShareCopied] = useState(false);

  const toggleShareMode = () => {
    if (!shareMode) setSelected(new Set(items.map(i=>i.id))); // default: everything selected
    setShareMode(v=>!v);
  };
  const toggleRow = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const selectAll  = () => setSelected(new Set(items.map(i=>i.id)));
  const selectNone = () => setSelected(new Set());

  const handleShare = async () => {
    const toShare = items.filter(i => selected.has(i.id));
    if (toShare.length === 0) return;
    const report = generateProcurementReport(projectName || "Project", toShare);
    if (navigator.share) {
      try {
        await navigator.share({ title: "Procurement Request", text: report });
        return;
      } catch { /* user cancelled — fall through to clipboard */ }
    }
    try {
      await navigator.clipboard.writeText(report);
      setShareCopied(true);
      setTimeout(()=>setShareCopied(false), 2000);
    } catch {
      alert(report);
    }
  };

  return (
    <div>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8 }}>
        <SectionLabel>Procurement Tracker</SectionLabel>
        {items.length > 0 && (
          <button onClick={toggleShareMode}
            style={{ background: shareMode ? C.accent+"22" : "transparent",
                     border:`1px solid ${shareMode ? C.accent+"66" : C.border2}`,
                     color: shareMode ? C.accent : C.muted,
                     borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:12, fontWeight:700,
                     fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}>
            {shareMode ? "✕ Cancel" : "📤 Share to Procurement"}
          </button>
        )}
      </div>

      {shareMode && (
        <div style={{ background:C.accent+"12", border:`1px solid ${C.accent}33`, borderRadius:9,
                      padding:"12px 14px", marginBottom:14, display:"flex", alignItems:"center",
                      justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
          <div style={{ color:C.text, fontSize:12 }}>
            <strong style={{color:C.accent}}>{selected.size}</strong> of {items.length} item{items.length!==1?"s":""} selected
          </div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <button onClick={selectAll}  style={{...bs, fontSize:11, padding:"5px 10px"}}>All</button>
            <button onClick={selectNone} style={{...bs, fontSize:11, padding:"5px 10px"}}>None</button>
            <button onClick={handleShare} disabled={selected.size===0}
              style={{ background: shareCopied ? C.green : C.accent, border:"none", borderRadius:7, color:"#fff",
                       padding:"6px 16px", cursor: selected.size===0 ? "default" : "pointer",
                       fontSize:12, fontWeight:700, fontFamily:"inherit",
                       opacity: selected.size===0 ? 0.5 : 1 }}>
              {shareCopied ? "✓ Copied" : "📤 Send"}
            </button>
          </div>
        </div>
      )}

      {items.map(row=>{
        const st=PROCURE_STATUS[row.status]||PROCURE_STATUS.pending;
        const isSelected = selected.has(row.id);
        return (
          <div key={row.id} style={{
            background: shareMode && !isSelected ? C.surface : C.card,
            border:`1px solid ${st.color}33`, borderLeft:`3px solid ${st.color}`,
            borderRadius:9, padding:"10px 12px", marginBottom:8,
            opacity: shareMode && !isSelected ? 0.5 : 1,
            transition:"all 0.15s",
            display:"flex", gap:10,
          }}>
            {shareMode && (
              <input type="checkbox" checked={isSelected} onChange={()=>toggleRow(row.id)}
                style={{ marginTop:6, flexShrink:0, accentColor:C.accent, width:16, height:16, cursor:"pointer" }}/>
            )}
            <div style={{ flex:1, minWidth:0 }}>
              {/* Row 1: editable name + status + delete */}
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}>
                <input value={row.item} onChange={e=>setField(row.id,"item",e.target.value)}
                  disabled={shareMode}
                  style={{...is,flex:1,padding:"5px 8px",fontSize:14,color:C.text}}/>
                <select value={row.status} onChange={e=>setStatus(row.id,e.target.value)}
                  disabled={shareMode}
                  style={{...is,width:"auto",color:st.color,padding:"5px 6px",flexShrink:0}}>
                  {Object.entries(PROCURE_STATUS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                </select>
                {!shareMode && (
                  <button onClick={()=>remove(row.id)} style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:14,flexShrink:0 }}>✕</button>
                )}
              </div>
              {/* Row 2: qty + supplier */}
              <div style={{ display:"flex",gap:8 }}>
                <input value={row.qty} onChange={e=>setField(row.id,"qty",e.target.value)}
                  disabled={shareMode}
                  placeholder="Qty"
                  style={{...is,width:70,padding:"4px 8px",fontSize:12,color:C.muted,flexShrink:0}}/>
                <input value={row.unit||"No."} onChange={e=>setField(row.id,"unit",e.target.value)}
                  disabled={shareMode}
                  placeholder="Unit"
                  style={{...is,width:60,padding:"4px 8px",fontSize:12,color:C.muted,flexShrink:0}}/>
                <input value={row.supplier||""} onChange={e=>setField(row.id,"supplier",e.target.value)}
                  disabled={shareMode}
                  placeholder="Supplier"
                  style={{...is,flex:1,padding:"4px 8px",fontSize:12,color:C.muted}}/>
              </div>
            </div>
          </div>
        );
      })}
      {!shareMode && (
        <AddRow fields={[{key:"item",label:"Item / Material...",flex:3},{key:"qty",label:"Qty",flex:1},{key:"supplier",label:"Supplier",flex:2}]} onAdd={add}/>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION SEQUENCE TAB
// ═══════════════════════════════════════════════════════════════════════════════
const STEP_STATUS = {
  pending:  { label: "Pending",     color: "#6b7280", icon: "○" },
  active:   { label: "In Progress", color: "#f59e0b", icon: "◉" },
  done:     { label: "Done",        color: "#22c55e", icon: "✓" },
  blocked:  { label: "Blocked",     color: "#ef4444", icon: "✕" },
  skipped:  { label: "Skipped",     color: "#6b7280", icon: "⊘" },
};


// ═══════════════════════════════════════════════════════════════════════════════
// STEP DOCUMENT ATTACHMENT
// Each execution step can have its OWN MOS file attached — completely independent
// from every other step's attachment. Files are stored as base64 and persisted
// via IndexedDB (see MOS_FILE_KEY / extractAndSaveImages / restoreImages above),
// the same mechanism already used for project photos.
// ═══════════════════════════════════════════════════════════════════════════════
function StepDocAttachment({ step, onUpdate }) {
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  const [extractStage, setExtractStage] = useState(null); // null | "extracting" | "review" | "error"
  const [extractedSteps, setExtractedSteps] = useState([]); // [{title, selected}]
  const [extractError, setExtractError] = useState("");
  const [extractSectionFound, setExtractSectionFound] = useState(true);
  const [pendingFile, setPendingFile] = useState(null); // the {name,type,size,data} object waiting to be confirmed
  const mosFile = step.mosFile; // { name, type, size, data }

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const validTypes = [".pdf", ".docx", ".doc"];
    const isValid = validTypes.some(ext => file.name.toLowerCase().endsWith(ext));
    if (!isValid) {
      alert("Please attach a PDF or Word document.");
      return;
    }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const fileObj = {
        name: file.name,
        type: file.type || (file.name.endsWith(".pdf") ? "application/pdf" : "application/msword"),
        size: file.size,
        data: ev.target.result, // data URL — will be moved into IndexedDB on next save
      };
      setPendingFile(fileObj);
      setUploading(false);

      // Attach the file immediately so it's never lost even if extraction fails or is dismissed
      onUpdate({ ...step, mosFile: fileObj });

      // Now try to extract this step's own procedure detail from the file, so the
      // user doesn't have to manually retype what's already written in the MOS.
      // Word (.doc, legacy binary) can't be parsed by mammoth — only .docx — so skip extraction for it.
      if (file.name.toLowerCase().endsWith(".doc") && !file.name.toLowerCase().endsWith(".docx")) {
        return;
      }
      setExtractStage("extracting");
      try {
        const { parseStepsFromFile } = await import("./lib/mosParser.js");
        const { steps, sectionFound } = await parseStepsFromFile(file);
        setExtractSectionFound(sectionFound);
        if (steps.length === 0) {
          setExtractStage("error");
          setExtractError(
            sectionFound
              ? "Found a Working Procedure section in this file, but couldn't detect numbered steps inside it."
              : "Couldn't find a 'Working Procedure' / 'خطوات التنفيذ' section heading in this file."
          );
          return;
        }
        setExtractedSteps(steps.map(s => ({ ...s, selected: true })));
        setExtractStage("review");
      } catch (err) {
        setExtractStage("error");
        setExtractError(err.message || "Could not read this file's contents.");
      }
    };
    reader.onerror = () => setUploading(false);
    reader.readAsDataURL(file);
  };

  const toggleExtracted = (idx) => {
    setExtractedSteps(arr => arr.map((s,i) => i===idx ? {...s, selected: !s.selected} : s));
  };
  const editExtracted = (idx, title) => {
    setExtractedSteps(arr => arr.map((s,i) => i===idx ? {...s, title} : s));
  };

  const applyExtractedToDescription = () => {
    const chosen = extractedSteps.filter(s => s.selected);
    if (chosen.length === 0) { setExtractStage(null); return; }
    // Append each extracted procedure line as its own checklist item (done:false),
    // so the user can tick off what's actually been completed on site — rather
    // than dumping everything as a single block of unstructured description text.
    // Existing checklist items are preserved; new ones are added after them.
    const newItems = chosen.map(s => ({ id: uid(), text: s.title, done: false }));
    const existingChecklist = step.checklist || [];
    onUpdate({ ...step, checklist: [...existingChecklist, ...newItems] });
    setExtractStage(null);
    setExtractedSteps([]);
    setPendingFile(null);
  };

  const dismissExtraction = () => {
    setExtractStage(null);
    setExtractedSteps([]);
    setExtractError("");
    setPendingFile(null);
  };

  const handleRemove = () => {
    if (!window.confirm(`Remove "${mosFile.name}" from this step?`)) return;
    onUpdate({ ...step, mosFile: null });
  };

  const handleOpen = async () => {
    if (!mosFile?.data) return;
    let resolvedData = mosFile.data;
    // Defensive fallback: if restoreImages() hasn't run yet (or failed) and data
    // is still the raw IndexedDB key string rather than the actual file blob,
    // fetch it directly here instead of failing silently.
    if (resolvedData.startsWith("mosfile::")) {
      try {
        resolvedData = await idbGet(resolvedData);
      } catch {
        resolvedData = null;
      }
      if (!resolvedData) {
        alert("Couldn't load this file right now. Please try again in a moment.");
        return;
      }
    }
    const win = window.open();
    if (mosFile.type === "application/pdf") {
      win.document.write(`<iframe src="${resolvedData}" style="width:100%;height:100vh;border:none;"></iframe>`);
    } else {
      // Word docs can't be previewed inline in a browser tab — trigger a download instead
      const a = document.createElement("a");
      a.href = resolvedData;
      a.download = mosFile.name;
      a.click();
      win.close();
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return "";
    if (bytes < 1024*1024) return `${Math.round(bytes/1024)} KB`;
    return `${(bytes/(1024*1024)).toFixed(1)} MB`;
  };

  return (
    <div style={{ marginTop:6, paddingLeft:30 }}>
      {!mosFile ? (
        <button onClick={()=>fileRef.current.click()} disabled={uploading}
          style={{
            background:"none", border:`1px dashed ${C.border2}`, color:C.dim,
            borderRadius:6, padding:"6px 12px", cursor:"pointer", fontSize:11,
            display:"flex", alignItems:"center", gap:6, fontFamily:"inherit",
            opacity: uploading ? 0.6 : 1,
          }}>
          📎 {uploading ? "Uploading…" : "Attach MOS for this step"}
        </button>
      ) : (
        <div style={{
          display:"flex", alignItems:"center", gap:8,
          background: C.accent+"10", border:`1px solid ${C.accent}33`,
          borderRadius:7, padding:"7px 10px",
        }}>
          <span style={{ fontSize:14, flexShrink:0 }}>
            {mosFile.type === "application/pdf" ? "📄" : "📝"}
          </span>
          <div onClick={handleOpen} style={{ flex:1, minWidth:0, cursor:"pointer" }}>
            <div style={{ color:C.accent, fontSize:12, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {mosFile.name}
            </div>
            <div style={{ color:C.dim, fontSize:10 }}>{formatSize(mosFile.size)} · tap to open</div>
          </div>
          <button onClick={handleRemove}
            style={{ background:"none", border:"none", color:C.red, cursor:"pointer", fontSize:13, opacity:0.6, flexShrink:0, padding:"2px 4px" }}>
            ✕
          </button>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".pdf,.docx,.doc" style={{display:"none"}} onChange={handleUpload}/>

      {/* ── Extracting this step's procedure detail from the uploaded file ── */}
      {extractStage === "extracting" && (
        <div style={{
          marginTop:8, display:"flex", alignItems:"center", gap:8,
          background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"8px 12px",
        }}>
          <div style={{ width:14,height:14,borderRadius:"50%",border:`2px solid ${C.border}`,borderTopColor:C.accent,
                        animation:"spin 0.8s linear infinite",flexShrink:0 }}/>
          <span style={{ color:C.muted, fontSize:11 }}>Reading this step's procedure detail from the file…</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ── Extraction failed — non-blocking, the file is already attached regardless ── */}
      {extractStage === "error" && (
        <div style={{
          marginTop:8, background:C.amber+"12", border:`1px solid ${C.amber}44`, borderRadius:7,
          padding:"9px 12px", color:C.amber, fontSize:11, lineHeight:1.6,
        }}>
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
            <span>⚠ {extractError} The file is still attached — you can add the description manually.</span>
            <button onClick={dismissExtraction} style={{ background:"none", border:"none", color:C.amber, cursor:"pointer", fontSize:13, flexShrink:0 }}>✕</button>
          </div>
        </div>
      )}

      {/* ── Review extracted procedure detail before merging into this step's description ── */}
      {extractStage === "review" && (
        <div style={{
          marginTop:8, background:C.card, border:`1px solid ${C.accent}44`, borderRadius:8, padding:"10px 12px",
        }}>
          <div style={{ color:C.accent, fontSize:11, fontWeight:700, marginBottom:6 }}>
            📋 Found {extractedSteps.length} procedure line{extractedSteps.length!==1?"s":""} for this step
          </div>
          {!extractSectionFound && (
            <div style={{ color:C.red, fontSize:10, lineHeight:1.5, marginBottom:8 }}>
              ⚠ No "Working Procedure" heading found — scanned the whole file, review carefully.
            </div>
          )}
          <div style={{ maxHeight:220, overflowY:"auto", marginBottom:10 }}>
            {extractedSteps.map((s, idx) => (
              <div key={idx} style={{ display:"flex", alignItems:"flex-start", gap:6, marginBottom:4 }}>
                <input type="checkbox" checked={s.selected} onChange={()=>toggleExtracted(idx)}
                  style={{ marginTop:3, flexShrink:0, accentColor:C.accent, width:13, height:13, cursor:"pointer" }}/>
                <input value={s.title} onChange={e=>editExtracted(idx, e.target.value)}
                  style={{ flex:1, background:C.surface, border:`1px solid ${C.border2}`, borderRadius:5,
                            color:C.text, fontSize:11, padding:"4px 6px", outline:"none", fontFamily:"inherit" }}/>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
            <button onClick={dismissExtraction}
              style={{ background:"none", border:`1px solid ${C.border2}`, color:C.muted, borderRadius:6,
                        padding:"5px 10px", cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
              Skip
            </button>
            <button onClick={applyExtractedToDescription}
              style={{ background:C.accent, border:"none", color:"#fff", borderRadius:6,
                        padding:"5px 12px", cursor:"pointer", fontSize:11, fontWeight:700, fontFamily:"inherit" }}>
              ✓ Add as Checklist
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP CHECKLIST
// Renders the checklist items extracted from a step's attached MOS (or added
// manually), each independently tickable. Tracks completion progress visually
// and lets the user add their own items or remove any item.
// ═══════════════════════════════════════════════════════════════════════════════
function StepChecklist({ step, onUpdate }) {
  const checklist = step.checklist || [];
  const [newItemText, setNewItemText] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  if (checklist.length === 0) return null;

  const doneCount = checklist.filter(i => i.done).length;
  const pct = Math.round((doneCount / checklist.length) * 100);

  const toggleItem = (id) => {
    onUpdate({ ...step, checklist: checklist.map(i => i.id===id ? {...i, done:!i.done} : i) });
  };
  const removeItem = (id) => {
    onUpdate({ ...step, checklist: checklist.filter(i => i.id!==id) });
  };
  const addItem = () => {
    const text = newItemText.trim();
    if (!text) return;
    onUpdate({ ...step, checklist: [...checklist, { id: uid(), text, done: false }] });
    setNewItemText("");
  };

  return (
    <div style={{ marginTop:8, paddingLeft:30 }}>
      <div onClick={()=>setCollapsed(v=>!v)}
        style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", marginBottom: collapsed ? 0 : 6 }}>
        <span style={{ color:C.dim, fontSize:10, transform: collapsed ? "rotate(-90deg)" : "none", transition:"transform 0.15s" }}>▾</span>
        <span style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:0.3 }}>
          ✓ Checklist · {doneCount}/{checklist.length}
        </span>
        <div style={{ flex:1, height:4, background:C.border, borderRadius:3, overflow:"hidden", maxWidth:80 }}>
          <div style={{ width:`${pct}%`, height:"100%", background: pct===100 ? C.green : C.accent, transition:"width 0.3s" }}/>
        </div>
      </div>

      {!collapsed && (
        <div>
          {checklist.map(item => (
            <div key={item.id} style={{
              display:"flex", alignItems:"flex-start", gap:7, padding:"3px 0",
            }}>
              <input type="checkbox" checked={item.done} onChange={()=>toggleItem(item.id)}
                style={{ marginTop:3, flexShrink:0, accentColor:C.green, width:14, height:14, cursor:"pointer" }}/>
              <span style={{
                flex:1, fontSize:12, lineHeight:1.5,
                color: item.done ? C.dim : C.text,
                textDecoration: item.done ? "line-through" : "none",
              }}>
                {item.text}
              </span>
              <button onClick={()=>removeItem(item.id)}
                style={{ background:"none", border:"none", color:C.red, opacity:0.5, cursor:"pointer", fontSize:11, flexShrink:0, padding:"0 4px" }}>
                ✕
              </button>
            </div>
          ))}
          <div style={{ display:"flex", gap:6, marginTop:6 }}>
            <input value={newItemText} onChange={e=>setNewItemText(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") addItem(); }}
              placeholder="Add checklist item…"
              style={{ flex:1, background:"transparent", border:"none", borderBottom:`1px dashed ${C.border2}`,
                       color:C.text, fontSize:11, padding:"3px 0", outline:"none", fontFamily:"inherit" }}/>
            <button onClick={addItem} disabled={!newItemText.trim()}
              style={{ background:"none", border:"none", color: newItemText.trim() ? C.accent : C.border2,
                       cursor: newItemText.trim() ? "pointer" : "default", fontSize:11, fontWeight:700, flexShrink:0 }}>
              + Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP COMMENTS
// A lightweight timestamped log per execution step — e.g. "Delayed due to
// supplier shortage" or "Consultant approved on site". Distinct from the
// checklist (which tracks discrete sub-tasks) — comments are a running history.
// ═══════════════════════════════════════════════════════════════════════════════
function StepComments({ step, onUpdate }) {
  const comments = step.comments || [];
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);

  const addComment = () => {
    const text = draft.trim();
    if (!text) return;
    const entry = { id: uid(), text, at: new Date().toISOString() };
    onUpdate({ ...step, comments: [...comments, entry] });
    setDraft("");
  };

  const removeComment = (id) => {
    onUpdate({ ...step, comments: comments.filter(c => c.id !== id) });
  };

  const formatWhen = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" })
      : d.toLocaleDateString("en-GB", { day:"2-digit", month:"short" }) + " " + d.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });
  };

  return (
    <div style={{ marginTop:8, paddingLeft:30 }}>
      <div onClick={()=>setExpanded(v=>!v)}
        style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
        <span style={{ color:C.dim, fontSize:10, transform: expanded ? "none" : "rotate(-90deg)", transition:"transform 0.15s" }}>▾</span>
        <span style={{ color:C.muted, fontSize:11, fontWeight:700, letterSpacing:0.3 }}>
          💬 Comments{comments.length > 0 ? ` · ${comments.length}` : ""}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop:6 }}>
          {comments.length === 0 && (
            <div style={{ color:C.dim, fontSize:11, fontStyle:"italic", marginBottom:6 }}>No comments yet</div>
          )}
          {comments.map(c => (
            <div key={c.id} style={{
              display:"flex", alignItems:"flex-start", gap:8, marginBottom:6,
              background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, padding:"6px 10px",
            }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color:C.text, fontSize:12, lineHeight:1.5 }}>{c.text}</div>
                <div style={{ color:C.dim, fontSize:10, marginTop:2, fontFamily:"'JetBrains Mono',monospace" }}>{formatWhen(c.at)}</div>
              </div>
              <button onClick={()=>removeComment(c.id)}
                style={{ background:"none", border:"none", color:C.red, opacity:0.5, cursor:"pointer", fontSize:11, flexShrink:0 }}>
                ✕
              </button>
            </div>
          ))}
          <div style={{ display:"flex", gap:6, marginTop:4 }}>
            <input value={draft} onChange={e=>setDraft(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") addComment(); }}
              placeholder="Add a note (e.g. delayed due to supplier shortage)…"
              style={{ flex:1, background:"transparent", border:"none", borderBottom:`1px dashed ${C.border2}`,
                       color:C.text, fontSize:12, padding:"4px 0", outline:"none", fontFamily:"inherit" }}/>
            <button onClick={addComment} disabled={!draft.trim()}
              style={{ background:"none", border:"none", color: draft.trim() ? C.accent : C.border2,
                       cursor: draft.trim() ? "pointer" : "default", fontSize:11, fontWeight:700, flexShrink:0 }}>
              + Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({ step, idx, total, onUpdate, onRemove, onMoveUp, onMoveDown }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc,  setEditingDesc]  = useState(false);
  const [draftTitle,   setDraftTitle]   = useState(step.title);
  const [draftDesc,    setDraftDesc]    = useState(step.desc||"");
  const titleRef = useRef();
  const descRef  = useRef();
  const st = STEP_STATUS[step.status] || STEP_STATUS.pending;
  const is = getInputStyle();

  const commitTitle = () => {
    const t = draftTitle.trim();
    if (t) onUpdate({...step, title: t});
    setEditingTitle(false);
  };
  const commitDesc = () => {
    onUpdate({...step, desc: draftDesc.trim()});
    setEditingDesc(false);
  };

  useEffect(()=>{ if(editingTitle) titleRef.current?.focus(); },[editingTitle]);
  useEffect(()=>{ if(editingDesc)  descRef.current?.focus();  },[editingDesc]);
  // Keep draftDesc in sync with step.desc when it changes from OUTSIDE this component
  // (e.g. StepDocAttachment merging extracted MOS procedure text into the description)
  // — but only while not actively editing, so we never clobber in-progress user typing.
  useEffect(()=>{ if(!editingDesc) setDraftDesc(step.desc||""); }, [step.desc, editingDesc]);

  return (
    <div style={{
      display:"flex", gap:0, marginBottom:0,
      position:"relative",
    }}>
      {/* Timeline column */}
      <div style={{ display:"flex",flexDirection:"column",alignItems:"center",width:40,flexShrink:0 }}>
        {/* Status circle */}
        <div onClick={()=>{
          const keys = Object.keys(STEP_STATUS);
          const next = keys[(keys.indexOf(step.status)+1) % keys.length];
          onUpdate({...step, status: next});
        }}
          style={{
            width:32, height:32, borderRadius:"50%",
            border:`2px solid ${st.color}`,
            background:`${st.color}20`,
            display:"flex", alignItems:"center", justifyContent:"center",
            color:st.color, fontSize:14, fontWeight:800,
            cursor:"pointer", flexShrink:0, zIndex:1,
            transition:"all 0.2s", userSelect:"none",
          }}
          title="Click to cycle status">
          {st.icon}
        </div>
        {/* Connector line */}
        {idx < total-1 && (
          <div style={{ width:2, flex:1, minHeight:24, background:`${st.color}40`, marginTop:2, marginBottom:-2 }}/>
        )}
      </div>

      {/* Content card */}
      <div style={{
        flex:1, background:C.card, border:`1px solid ${C.border}`,
        borderLeft:`3px solid ${st.color}`,
        borderRadius:"0 9px 9px 0", padding:"10px 12px",
        marginBottom:8, marginLeft:8,
      }}>
        {/* Header row: step number + title + controls */}
        <div style={{ display:"flex",alignItems:"flex-start",gap:8 }}>
          <span style={{ color:st.color,fontWeight:800,fontSize:11,fontFamily:"'JetBrains Mono',monospace",
                         minWidth:22,paddingTop:2,flexShrink:0 }}>
            {String(idx+1).padStart(2,"0")}
          </span>

          {editingTitle ? (
            <input ref={titleRef} value={draftTitle} onChange={e=>setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e=>{ if(e.key==="Enter") commitTitle(); if(e.key==="Escape"){setDraftTitle(step.title);setEditingTitle(false);} }}
              style={{...is,flex:1,padding:"3px 7px",fontSize:14,fontWeight:700,height:30}}/>
          ) : (
            <span onDoubleClick={()=>{setDraftTitle(step.title);setEditingTitle(true);}}
              style={{ flex:1,color:C.text,fontWeight:700,fontSize:14,lineHeight:1.3,cursor:"text",wordBreak:"break-word" }}>
              {step.title}
            </span>
          )}

          {/* Status selector */}
          <select value={step.status} onChange={e=>onUpdate({...step,status:e.target.value})}
            style={{...is,width:"auto",padding:"3px 6px",fontSize:11,color:st.color,flexShrink:0}}>
            {Object.entries(STEP_STATUS).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}
          </select>
        </div>

        {/* Linked MOS document — each step can have its OWN attached file, independent of other steps */}
        <StepDocAttachment step={step} onUpdate={onUpdate}/>

        {/* Reference no. + Assignee — compact row, both optional */}
        <div style={{ marginTop:6, paddingLeft:30, display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, flex:1, minWidth:140 }}>
            <span style={{ color:C.dim, fontSize:11, flexShrink:0 }}>🔖</span>
            <input
              value={step.docRef || ""}
              onChange={e=>onUpdate({...step, docRef: e.target.value})}
              placeholder="Reference no. (drawing, ITP hold point...)"
              style={{
                flex:1, background:"transparent", border:"none", borderBottom:`1px dashed ${C.border2}`,
                color: step.docRef ? C.accent : C.dim, fontSize:12, padding:"2px 0",
                outline:"none", fontFamily:"inherit", fontWeight: step.docRef ? 600 : 400,
              }}
            />
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flex:1, minWidth:140 }}>
            <span style={{ color:C.dim, fontSize:11, flexShrink:0 }}>👤</span>
            <input
              value={step.assignee || ""}
              onChange={e=>onUpdate({...step, assignee: e.target.value})}
              placeholder="Assignee (who's responsible)"
              style={{
                flex:1, background:"transparent", border:"none", borderBottom:`1px dashed ${C.border2}`,
                color: step.assignee ? C.text : C.dim, fontSize:12, padding:"2px 0",
                outline:"none", fontFamily:"inherit", fontWeight: step.assignee ? 600 : 400,
              }}
            />
          </div>

        </div>

        {/* Description */}
        <div style={{ marginTop:6, paddingLeft:30 }}>
          {editingDesc ? (
            <textarea ref={descRef} value={draftDesc} onChange={e=>setDraftDesc(e.target.value)}
              onBlur={commitDesc}
              onKeyDown={e=>{ if(e.key==="Escape"){setDraftDesc(step.desc||"");setEditingDesc(false);} }}
              style={{...is,width:"100%",minHeight:60,padding:"5px 8px",fontSize:13,resize:"vertical",lineHeight:1.5}}/>
          ) : (
            <div onDoubleClick={()=>{setDraftDesc(step.desc||"");setEditingDesc(true);}}
              style={{ color:step.desc?C.muted:C.dim, fontSize:13, lineHeight:1.5,
                       cursor:"text", fontStyle:step.desc?"normal":"italic",
                       minHeight:20 }}>
              {step.desc || "Double-tap to add description..."}
            </div>
          )}
        </div>

        {/* Checklist — items extracted from an attached MOS, or added manually */}
        <StepChecklist step={step} onUpdate={onUpdate}/>

        {/* Comments — timestamped log of notes/delays/approvals for this step */}
        <StepComments step={step} onUpdate={onUpdate}/>

        {/* Bottom controls */}
        <div style={{ display:"flex",alignItems:"center",gap:6,marginTop:8,paddingLeft:30 }}>
          <button onClick={()=>{setDraftTitle(step.title);setEditingTitle(true);}}
            style={{ background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:11,padding:"2px 4px" }}>✎ Edit</button>
          <button onClick={onMoveUp} disabled={idx===0}
            style={{ background:"none",border:"none",color:idx===0?C.border2:C.muted,cursor:idx===0?"default":"pointer",fontSize:11,padding:"2px 4px" }}>▲</button>
          <button onClick={onMoveDown} disabled={idx===total-1}
            style={{ background:"none",border:"none",color:idx===total-1?C.border2:C.muted,cursor:idx===total-1?"default":"pointer",fontSize:11,padding:"2px 4px" }}>▼</button>
          <div style={{ flex:1 }}/>
          <button onClick={onRemove}
            style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:12,opacity:0.6,padding:"2px 6px" }}>✕</button>
        </div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION TIMELINE
// A simplified horizontal sequence view of the execution steps — connected nodes
// colored by status, so gaps and the overall shape of progress are visible at a
// glance. This is intentionally NOT a date-based Gantt (steps don't carry their
// own start/end dates in this app) — it visualizes ORDER and STATUS instead.
// ═══════════════════════════════════════════════════════════════════════════════
function ExecutionTimeline({ steps, onSelectStep }) {
  if (steps.length === 0) return null;

  return (
    <div style={{ marginBottom:24, overflowX:"auto", paddingBottom:8 }}>
      <div style={{ display:"flex", alignItems:"flex-start", minWidth: steps.length*150, paddingTop:8 }}>
        {steps.map((s, idx) => {
          const st = STEP_STATUS[s.status] || STEP_STATUS.pending;
          const isLast = idx === steps.length - 1;
          return (
            <div key={s.id} style={{ display:"flex", alignItems:"flex-start", flex: isLast ? "0 0 auto" : 1 }}>
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", width:150, flexShrink:0 }}>
                {/* Node */}
                <div onClick={()=>onSelectStep && onSelectStep(s.id)}
                  style={{
                    width:36, height:36, borderRadius:"50%",
                    background: s.status==="done" ? st.color : C.card,
                    border:`2px solid ${st.color}`,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    color: s.status==="done" ? "#fff" : st.color,
                    fontWeight:800, fontSize:13, cursor: onSelectStep ? "pointer" : "default",
                    flexShrink:0, boxShadow: s.status==="active" ? `0 0 0 4px ${st.color}33` : "none",
                    transition:"box-shadow 0.3s",
                  }}>
                  {s.status==="done" ? "✓" : idx+1}
                </div>
                {/* Label */}
                <div style={{
                  marginTop:8, textAlign:"center", fontSize:11, color: s.status==="pending" ? C.dim : C.text,
                  lineHeight:1.4, padding:"0 6px", overflow:"hidden", textOverflow:"ellipsis",
                  display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical",
                }}>
                  {s.title}
                </div>
                {s.assignee && (
                  <div style={{ marginTop:3, fontSize:9, color:C.dim }}>👤 {s.assignee}</div>
                )}
              </div>
              {/* Connector line */}
              {!isLast && (
                <div style={{
                  flex:1, height:2, marginTop:17, minWidth:20,
                  background: s.status==="done" ? STEP_STATUS.done.color : C.border,
                }}/>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExecutionSequenceTab({ steps, onUpdate, projectId }) {
  steps = steps || [];
  const [showMOSImport, setShowMOSImport] = useState(false);
  const [viewMode, setViewMode] = useState("list"); // "list" | "timeline"
  const upd    = (id, newStep) => onUpdate(steps.map(s=>s.id===id?newStep:s));
  const remove = (id) => {
    // Best-effort cleanup of any attached MOS file in IndexedDB so we don't leak storage
    if (projectId) idbDelete(MOS_FILE_KEY(projectId, id));
    onUpdate(steps.filter(s=>s.id!==id));
  };
  const moveUp = (idx) => { if(idx===0) return; const a=[...steps]; [a[idx-1],a[idx]]=[a[idx],a[idx-1]]; onUpdate(a); };
  const moveDn = (idx) => { if(idx===steps.length-1) return; const a=[...steps]; [a[idx],a[idx+1]]=[a[idx+1],a[idx]]; onUpdate(a); };
  const addStep = (title) => {
    if(!title.trim()) return;
    onUpdate([...steps,{id:uid(),order:steps.length+1,title:title.trim(),desc:"",status:"pending",mosFile:null}]);
  };
  const importSteps = (newSteps) => {
    onUpdate([...steps, ...newSteps]);
  };

  const counts = Object.fromEntries(Object.keys(STEP_STATUS).map(k=>[k,steps.filter(s=>s.status===k).length]));
  const pct = steps.length ? Math.round((counts.done/steps.length)*100) : 0;
  const bs = getBtnSecondary();

  return (
    <div>
      {/* Header summary */}
      <div style={{ display:"flex",alignItems:"center",gap:16,marginBottom:20,flexWrap:"wrap" }}>
        <div>
          <SectionLabel>Execution Sequence</SectionLabel>
          <div style={{ color:C.muted,fontSize:12,marginTop:-6 }}>
            Click status circle to cycle · Double-tap text to edit
          </div>
        </div>
        <div style={{ marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>
          {Object.entries(STEP_STATUS).map(([k,v])=>(
            counts[k]>0 && <span key={k} style={{ background:v.color+"18",border:`1px solid ${v.color}44`,
              color:v.color,borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700 }}>
              {v.icon} {counts[k]} {v.label}
            </span>
          ))}
          <div style={{ display:"flex", background:C.surface, borderRadius:7, padding:2, gap:2 }}>
            {[["list","☰"],["timeline","📊"]].map(([k,icon])=>(
              <button key={k} onClick={()=>setViewMode(k)}
                style={{ background: viewMode===k ? C.accent : "transparent", border:"none",
                         color: viewMode===k ? "#fff" : C.muted, borderRadius:5, padding:"5px 10px",
                         cursor:"pointer", fontSize:13, fontFamily:"inherit" }}>
                {icon}
              </button>
            ))}
          </div>
          <button onClick={()=>setShowMOSImport(true)}
            style={{ background:C.accent+"18", border:`1px solid ${C.accent}55`, color:C.accent,
                     borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:12, fontWeight:700,
                     fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}>
            📄 Import from MOS
          </button>
        </div>
      </div>

      {showMOSImport && (
        <MOSImportModal onClose={()=>setShowMOSImport(false)} onImportSteps={importSteps}/>
      )}

      {/* Progress bar */}
      {steps.length > 0 && (
        <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:20 }}>
          <div style={{ flex:1,background:C.border,borderRadius:6,height:6,overflow:"hidden" }}>
            <div style={{ width:`${pct}%`,height:"100%",background:`linear-gradient(90deg,${C.green},${C.accent})`,borderRadius:6,transition:"width 0.5s" }}/>
          </div>
          <span style={{ color:C.green,fontWeight:800,fontSize:12,fontFamily:"'JetBrains Mono',monospace",minWidth:36 }}>{pct}%</span>
          <span style={{ color:C.muted,fontSize:12 }}>{counts.done}/{steps.length} done</span>
        </div>
      )}

      {steps.length===0 && (
        <div style={{ color:C.dim,fontSize:14,textAlign:"center",padding:"50px 0",border:`1px dashed ${C.border2}`,borderRadius:9,marginBottom:16 }}>
          No steps yet — add the first execution step below
        </div>
      )}

      {/* Timeline view */}
      {viewMode==="timeline" && steps.length > 0 && (
        <ExecutionTimeline steps={steps} onSelectStep={()=>setViewMode("list")}/>
      )}

      {/* Step list */}
      {viewMode==="list" && steps.map((step,idx)=>(
        <StepRow key={step.id} step={step} idx={idx} total={steps.length}
          onUpdate={(s)=>upd(step.id,s)}
          onRemove={()=>remove(step.id)}
          onMoveUp={()=>moveUp(idx)}
          onMoveDown={()=>moveDn(idx)}
        />
      ))}

      <div style={{ marginTop:8 }}>
        <AddRow placeholder="Add execution step title..." onAdd={addStep}/>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// MOS DOCUMENT IMPORT — upload a MOS/ITP file, auto-detect steps, review before adding
// ═══════════════════════════════════════════════════════════════════════════════
function MOSImportModal({ onClose, onImportSteps }) {
  const [stage, setStage]       = useState("upload");  // upload | parsing | review | error
  const [fileName, setFileName] = useState("");
  const [detected, setDetected] = useState([]);          // [{title, desc, selected}]
  const [errorMsg, setErrorMsg] = useState("");
  const [sectionFound, setSectionFound] = useState(true); // whether a Working Procedure section heading was actually located
  const [sourceFile, setSourceFile] = useState(null);      // the raw File object, kept so we can optionally attach it
  const [attachToAll, setAttachToAll] = useState(false);   // whether to attach the source file to every imported step
  const fileRef = useRef();
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith(".pdf") && !name.endsWith(".docx") && !name.endsWith(".txt")) {
      setStage("error");
      setErrorMsg("Unsupported file type. Please upload a PDF, DOCX, or TXT file.");
      return;
    }
    setFileName(file.name);
    setSourceFile(file.name.toLowerCase().endsWith(".txt") ? null : file); // .txt has nothing useful to "view" as an attachment
    setStage("parsing");
    try {
      // Lazy-load the parser module — this is when pdfjs/mammoth actually download
      const { parseStepsFromFile } = await import("./lib/mosParser.js");
      const { steps, sectionFound: found } = await parseStepsFromFile(file);
      setSectionFound(found);
      if (steps.length === 0) {
        setStage("error");
        setErrorMsg(
          found
            ? "Found a Working Procedure / Execution section, but couldn't detect numbered steps inside it.\n\n" +
              "Tip: steps should look like \"1. Mobilization...\" or \"Step 1: ...\" (or \"١. ...\" in Arabic). You can still add steps manually."
            : "Couldn't find a 'Working Procedure', 'Execution Sequence', or 'خطوات التنفيذ' / 'إجراءات العمل' section heading in this document, " +
              "so no steps were extracted (to avoid pulling numbers from unrelated sections like Scope of Work or Safety).\n\n" +
              "Tip: make sure the document has a clear section heading like \"Working Procedure\", \"Execution Sequence\", \"خطوات التنفيذ\", " +
              "or \"إجراءات العمل\" right before the numbered steps. You can still add steps manually."
        );
        return;
      }
      setDetected(steps.map(s => ({ ...s, selected: true })));
      setStage("review");
    } catch (err) {
      setStage("error");
      setErrorMsg(err.message || "Could not read this file. It may be corrupted, scanned (image-only), or password-protected.");
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const toggleSelected = (idx) => {
    setDetected(d => d.map((s,i) => i===idx ? {...s, selected: !s.selected} : s));
  };
  const editTitle = (idx, title) => {
    setDetected(d => d.map((s,i) => i===idx ? {...s, title} : s));
  };
  const selectAll  = () => setDetected(d => d.map(s => ({...s, selected:true})));
  const selectNone = () => setDetected(d => d.map(s => ({...s, selected:false})));

  const selectedCount = detected.filter(s=>s.selected).length;

  const fileToDataURL = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const handleImport = async () => {
    // Optionally convert the source file once, then reuse the same data URL for
    // every selected step — each step still gets its OWN independent mosFile
    // object (and can be replaced/removed individually later), this just saves
    // the user from re-uploading the same file multiple times when it genuinely
    // applies to all the steps just extracted from it.
    let sharedAttachment = null;
    if (attachToAll && sourceFile) {
      try {
        const data = await fileToDataURL(sourceFile);
        sharedAttachment = {
          name: sourceFile.name,
          type: sourceFile.type || (sourceFile.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/msword"),
          size: sourceFile.size,
          data,
        };
      } catch { /* if this fails, just import without attachments — not fatal */ }
    }

    const toImport = detected.filter(s=>s.selected).map(s => ({
      id: uid(),
      title: s.title,
      desc: s.desc || "",
      status: "pending",
      docRef: fileName,   // text note of which source file these steps came from
      mosFile: sharedAttachment ? { ...sharedAttachment } : null, // each step gets its own copy of the reference
    }));
    onImportSteps(toImport);
    onClose();
  };

  const bs = getBtnSecondary();
  const bp = getBtnPrimary();
  const is = getInputStyle();

  return (
    <Modal title="📄 Import Steps from MOS Document" onClose={onClose} wide={stage==="review"}>

      {/* ── Upload stage ── */}
      {stage === "upload" && (
        <div>
          <div style={{ color:C.muted, fontSize:13, lineHeight:1.7, marginBottom:18 }}>
            Upload a Method of Statement (PDF or Word), and the app will look for the
            "Working Procedure" / "Execution Sequence" section (or its Arabic equivalent —
            "خطوات التنفيذ", "إجراءات العمل", "منهجية التنفيذ") and extract the numbered
            steps from inside it only — ignoring numbers in unrelated sections like Scope
            of Work or Safety. You'll review everything before it's added to this project.
          </div>
          <div
            onClick={()=>fileRef.current.click()}
            onDragOver={e=>{e.preventDefault();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={onDrop}
            style={{
              border:`2px dashed ${dragOver?C.accent:C.border2}`,
              borderRadius:12, padding:"44px 20px", textAlign:"center",
              cursor:"pointer", transition:"all 0.2s",
              background:dragOver?C.accent+"10":C.surface,
            }}>
            <div style={{ fontSize:38,marginBottom:12 }}>📂</div>
            <div style={{ color:C.text,fontWeight:700,fontSize:14,marginBottom:6 }}>
              {dragOver ? "Drop it here!" : "Click to select or drag & drop"}
            </div>
            <div style={{ color:C.muted,fontSize:12 }}>PDF · DOCX · TXT</div>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" style={{display:"none"}}
              onChange={e=>handleFile(e.target.files[0])}/>
          </div>
        </div>
      )}

      {/* ── Parsing stage ── */}
      {stage === "parsing" && (
        <div style={{ textAlign:"center", padding:"50px 0" }}>
          <div style={{ width:48,height:48,margin:"0 auto 18px",borderRadius:"50%",
                        border:`3px solid ${C.border}`, borderTopColor:C.accent,
                        animation:"spin 0.8s linear infinite" }}/>
          <div style={{ color:C.text, fontWeight:700, fontSize:14, marginBottom:6 }}>Reading {fileName}…</div>
          <div style={{ color:C.muted, fontSize:12 }}>Extracting text and detecting steps</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* ── Error stage ── */}
      {stage === "error" && (
        <div>
          <div style={{ background:"#7a1f1f22", border:"1px solid #ef444455", borderRadius:8,
                        padding:"16px 18px", marginBottom:18 }}>
            <div style={{ color:"#f87171", fontWeight:700, fontSize:13, marginBottom:6 }}>⚠ Could not extract steps</div>
            <div style={{ color:"#f8717199", fontSize:12, lineHeight:1.7, whiteSpace:"pre-line" }}>{errorMsg}</div>
          </div>
          <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
            <button onClick={()=>setStage("upload")} style={bs}>Try Another File</button>
            <button onClick={onClose} style={bp}>Close</button>
          </div>
        </div>
      )}

      {/* ── Review stage ── */}
      {stage === "review" && (
        <div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14, flexWrap:"wrap", gap:8 }}>
            <div style={{ color:C.text, fontSize:13 }}>
              Found <strong style={{color:C.accent}}>{detected.length}</strong> step{detected.length!==1?"s":""} in
              <span style={{color:C.muted}}> {fileName}</span>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={selectAll}  style={{...bs, fontSize:11, padding:"5px 10px"}}>Select All</button>
              <button onClick={selectNone} style={{...bs, fontSize:11, padding:"5px 10px"}}>Select None</button>
            </div>
          </div>

          {sectionFound ? (
            <div style={{ background:C.green+"12", border:`1px solid ${C.green}33`, borderRadius:8,
                          padding:"10px 14px", marginBottom:12, color:C.green, fontSize:12, lineHeight:1.6,
                          display:"flex", alignItems:"center", gap:8 }}>
              <span>✓</span>
              <span>Steps extracted from the Working Procedure / Execution section only.</span>
            </div>
          ) : (
            <div style={{ background:C.red+"12", border:`1px solid ${C.red}44`, borderRadius:8,
                          padding:"10px 14px", marginBottom:12, color:C.red, fontSize:12, lineHeight:1.6 }}>
              ⚠ Couldn't find a clear "Working Procedure" / "Execution Sequence" section heading —
              these steps were detected by scanning the <strong>entire document</strong>, so some
              may have been picked up from unrelated sections (Scope, Safety, References, etc).
              Review extra carefully below.
            </div>
          )}

          <div style={{ background:C.amber+"15", border:`1px solid ${C.amber}44`, borderRadius:8,
                        padding:"10px 14px", marginBottom:16, color:C.amber, fontSize:12, lineHeight:1.6 }}>
            ⚠ Auto-detection isn't perfect — review each line below, edit any that look wrong,
            and uncheck anything that isn't really a step before importing.
          </div>

          {sourceFile && (
            <label style={{
              display:"flex", alignItems:"flex-start", gap:10, marginBottom:16,
              background:C.surface, border:`1px solid ${C.border}`, borderRadius:8,
              padding:"10px 14px", cursor:"pointer",
            }}>
              <input type="checkbox" checked={attachToAll} onChange={e=>setAttachToAll(e.target.checked)}
                style={{ marginTop:2, flexShrink:0, accentColor:C.accent, width:16, height:16, cursor:"pointer" }}/>
              <div style={{ fontSize:12, lineHeight:1.6 }}>
                <div style={{ color:C.text, fontWeight:600, marginBottom:2 }}>
                  📎 Attach "{fileName}" to all imported steps
                </div>
                <div style={{ color:C.muted }}>
                  Optional — each step keeps its own independent copy of this file and can be
                  replaced or have a different MOS attached later from inside the step itself.
                </div>
              </div>
            </label>
          )}

          <div style={{ maxHeight:380, overflowY:"auto", marginBottom:16 }}>
            {detected.map((s, idx) => (
              <div key={idx} style={{
                display:"flex", alignItems:"flex-start", gap:10,
                background: s.selected ? C.card : C.surface,
                border:`1px solid ${s.selected ? C.border2 : C.border}`,
                borderRadius:8, padding:"10px 12px", marginBottom:6,
                opacity: s.selected ? 1 : 0.5, transition:"all 0.15s",
              }}>
                <input type="checkbox" checked={s.selected} onChange={()=>toggleSelected(idx)}
                  style={{ marginTop:3, flexShrink:0, accentColor:C.accent, width:16, height:16, cursor:"pointer" }}/>
                <span style={{ color:C.dim, fontSize:11, fontFamily:"'JetBrains Mono',monospace", flexShrink:0, marginTop:3, minWidth:20 }}>
                  {String(idx+1).padStart(2,"0")}
                </span>
                <input value={s.title} onChange={e=>editTitle(idx, e.target.value)}
                  style={{...is, flex:1, padding:"5px 8px", fontSize:13}}/>
              </div>
            ))}
          </div>

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <button onClick={()=>setStage("upload")} style={{...bs, fontSize:12}}>← Try Another File</button>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={onClose} style={bs}>Cancel</button>
              <button onClick={handleImport} disabled={selectedCount===0}
                style={{...bp, opacity:selectedCount===0?0.5:1, cursor:selectedCount===0?"default":"pointer"}}>
                + Add {selectedCount} Step{selectedCount!==1?"s":""}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPROVALS TAB
// ═══════════════════════════════════════════════════════════════════════════════
function ApprovalsTab({ items, onUpdate }) {
  items = items||[];
  const setStatus=(id,s)=>onUpdate(items.map(i=>i.id===id?{...i,status:s}:i));
  const setField =(id,k,v)=>onUpdate(items.map(i=>i.id===id?{...i,[k]:v}:i));
  const remove=(id)=>onUpdate(items.filter(i=>i.id!==id));
  const add=({title,issuedBy,dueDate})=>{ if(!title?.trim()) return; onUpdate([...items,{id:uid(),title:title.trim(),status:"pending",issuedBy:issuedBy||"",date:"",dueDate:dueDate||""}]); };
  const is=getInputStyle();
  const todayStr = today();

  return (
    <div>
      <SectionLabel>Approvals & Permits</SectionLabel>
      {items.map(item=>{
        const st = DELIVERY_STATUS[item.status]||DELIVERY_STATUS.pending;
        const isOverdue = item.dueDate && item.status==="pending" && item.dueDate < todayStr;
        const isDueSoon = item.dueDate && item.status==="pending" && !isOverdue &&
          (new Date(item.dueDate) - new Date(todayStr)) <= 3*86400000;
        return (
          <div key={item.id} style={{
            background:C.card,
            border:`1px solid ${isOverdue ? C.red+"66" : st.color+"33"}`,
            borderLeft:`3px solid ${isOverdue ? C.red : st.color}`,
            borderRadius:9,padding:"12px 14px",marginBottom:8 }}>
            <div style={{ display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:6 }}>
              <div style={{ flex:1,minWidth:200 }}>
                <div style={{ color:C.text,fontSize:14 }}>{item.title}</div>
                <div style={{ color:C.muted,fontSize:12,marginTop:2 }}>{item.issuedBy}{item.date?` · ${item.date}`:""}</div>
              </div>
              <select value={item.status} onChange={e=>setStatus(item.id,e.target.value)}
                style={{...is,width:"auto",color:st.color}}>
                {Object.entries(DELIVERY_STATUS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
              </select>
              <button onClick={()=>remove(item.id)} style={{ background:"none",border:"none",color:C.red,cursor:"pointer",fontSize:14 }}>✕</button>
            </div>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <span style={{ color:C.dim,fontSize:11,flexShrink:0 }}>📅 Due:</span>
              <input type="date" value={item.dueDate||""} onChange={e=>setField(item.id,"dueDate",e.target.value)}
                style={{...is,width:"auto",padding:"3px 8px",fontSize:12,
                        color:isOverdue?C.red:isDueSoon?C.amber:C.muted}}/>
              {isOverdue && <Badge color={C.red} label="OVERDUE"/>}
              {isDueSoon && <Badge color={C.amber} label="DUE SOON"/>}
            </div>
          </div>
        );
      })}
      <AddRow fields={[{key:"title",label:"Document / Permit / Approval…",flex:3},{key:"issuedBy",label:"Issued by",flex:1},{key:"dueDate",label:"Due date",flex:1}]} onAdd={add}/>
    </div>
  );
}

// ─── Notes Tab ────────────────────────────────────────────────────────────────
function NotesTab({ notes, onUpdate }) {
  const [val, setVal]     = useState(notes||"");
  const [status, setStatus] = useState("saved"); // "saved" | "saving" | "unsaved"
  const timerRef = useRef(null);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);
  useEffect(() => { setVal(notes||""); }, [notes]);

  const handleChange = (e) => {
    const v = e.target.value;
    setVal(v);
    setStatus("unsaved");
    // Debounce: save 800ms after last keystroke
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onUpdateRef.current(v);
      setStatus("saved");
    }, 800);
  };

  // Save immediately on blur (e.g. user switches tab or presses back)
  const handleBlur = () => {
    clearTimeout(timerRef.current);
    onUpdateRef.current(val);
    setStatus("saved");
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const is = getInputStyle();
  return (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
        <SectionLabel>Site Notes & Remarks</SectionLabel>
        <span style={{ fontSize:11, color: status==="saved" ? C.green : C.amber,
                       fontFamily:"'JetBrains Mono',monospace", letterSpacing:0.5 }}>
          {status==="saved" ? "✓ Saved" : "● Saving…"}
        </span>
      </div>
      <textarea value={val} onChange={handleChange} onBlur={handleBlur}
        placeholder="Add site notes, coordinator remarks, important observations…"
        style={{...is,height:320,resize:"vertical",lineHeight:1.8,padding:"14px"}}/>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// SHUTDOWN WINDOW TRACKER
// ═══════════════════════════════════════════════════════════════════════════════
// Calculates the next occurrence of a daily shutdown window (e.g. 01:00–05:00)
// and returns countdown info. Handles windows that cross midnight.
function getNextShutdown(startHHMM, endHHMM) {
  if (!startHHMM || !endHHMM) return null;
  const now = new Date();
  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);

  const buildDate = (baseDate, h, m) => {
    const d = new Date(baseDate);
    d.setHours(h, m, 0, 0);
    return d;
  };

  let start = buildDate(now, sh, sm);
  let end   = buildDate(now, eh, em);
  // Window crosses midnight (e.g. 01:00 -> 05:00 is fine, but 22:00 -> 02:00 crosses)
  const crossesMidnight = eh < sh || (eh === sh && em <= sm);
  if (crossesMidnight) end.setDate(end.getDate() + 1);

  // Are we currently inside the window?
  if (now >= start && now < end) {
    return { active: true, start, end, msUntilStart: 0, msUntilEnd: end - now };
  }
  // Has tonight's window already passed? -> compute tomorrow's
  if (now >= end) {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);
  }
  return { active: false, start, end, msUntilStart: start - now, msUntilEnd: end - now };
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function ShutdownWindowCard({ project, onUpdate }) {
  const [now, setNow] = useState(Date.now());
  const sw = project.shutdownWindow || { enabled:false, start:"01:00", end:"05:00" };
  const [editing, setEditing] = useState(!sw.enabled && !sw.start);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const info = sw.enabled ? getNextShutdown(sw.start, sw.end) : null;
  const setSW = (patch) => onUpdate({...project, shutdownWindow: {...sw, ...patch}});

  const is = getInputStyle();
  const bp = getBtnPrimary();
  const bs = getBtnSecondary();

  if (!sw.enabled) {
    return (
      <div style={{ background:C.card,border:`1px dashed ${C.border2}`,borderRadius:11,padding:"18px 20px" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom: editing ? 14 : 0 }}>
          <div>
            <div style={{ color:C.muted,fontSize:11,letterSpacing:1,textTransform:"uppercase",marginBottom:4 }}>🌙 Shutdown Window</div>
            <div style={{ color:C.dim,fontSize:13 }}>Not configured for this project</div>
          </div>
          <button onClick={()=>setEditing(v=>!v)} style={{...bs,fontSize:12,padding:"6px 14px"}}>
            {editing ? "Cancel" : "+ Set Window"}
          </button>
        </div>
        {editing && (
          <div style={{ display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap" }}>
            <Field label="Start Time">
              <input type="time" defaultValue={sw.start||"01:00"} id="sw-start" style={is}/>
            </Field>
            <Field label="End Time">
              <input type="time" defaultValue={sw.end||"05:00"} id="sw-end" style={is}/>
            </Field>
            <button onClick={()=>{
              const s = document.getElementById("sw-start").value;
              const e = document.getElementById("sw-end").value;
              setSW({enabled:true, start:s, end:e});
              setEditing(false);
            }} style={{...bp,padding:"9px 18px",marginBottom:14}}>Activate</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      background: info?.active ? `linear-gradient(135deg, ${C.red}18, ${C.accentDim}30)` : C.card,
      border: `1px solid ${info?.active ? C.red+"66" : C.border}`,
      borderRadius:11, padding:"18px 20px",
    }}>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12 }}>
        <div>
          <div style={{ color: info?.active ? C.red : C.muted, fontSize:11,letterSpacing:1,textTransform:"uppercase",marginBottom:4,fontWeight:700 }}>
            🌙 Shutdown Window · {sw.start}–{sw.end}
          </div>
          {info?.active ? (
            <div style={{ color:C.red, fontSize:14, fontWeight:800 }}>🔴 ACTIVE NOW</div>
          ) : (
            <div style={{ color:C.text, fontSize:13 }}>
              Next window: {info.start.toLocaleDateString("en-GB",{weekday:"short",day:"2-digit",month:"short"})}
            </div>
          )}
        </div>
        <button onClick={()=>setEditing(v=>!v)} style={{ background:"none",border:"none",color:C.dim,cursor:"pointer",fontSize:13 }}>⚙</button>
      </div>

      {/* Countdown */}
      <div style={{ display:"flex",alignItems:"center",gap:10 }}>
        <div style={{
          fontFamily:"'JetBrains Mono',monospace", fontSize:28, fontWeight:800,
          color: info?.active ? C.red : C.accent, letterSpacing:1,
        }}>
          {info?.active ? formatCountdown(info.msUntilEnd) : formatCountdown(info.msUntilStart)}
        </div>
        <div style={{ color:C.muted, fontSize:11 }}>
          {info?.active ? "until window closes" : "until shutdown starts"}
        </div>
      </div>

      {/* 1-hour prep warning */}
      {!info?.active && info.msUntilStart < 3600000 && info.msUntilStart > 0 && (
        <div style={{ marginTop:10, background:C.amber+"22", border:`1px solid ${C.amber}55`, borderRadius:7, padding:"8px 12px",
                      color:C.amber, fontSize:12, fontWeight:700, display:"flex", alignItems:"center", gap:6 }}>
          ⚠ Less than 1 hour — prepare equipment & crew now
        </div>
      )}

      {editing && (
        <div style={{ display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap",marginTop:14,paddingTop:14,borderTop:`1px solid ${C.border}` }}>
          <Field label="Start Time">
            <input type="time" defaultValue={sw.start} id="sw-start2" style={is}/>
          </Field>
          <Field label="End Time">
            <input type="time" defaultValue={sw.end} id="sw-end2" style={is}/>
          </Field>
          <button onClick={()=>{
            const s = document.getElementById("sw-start2").value;
            const e = document.getElementById("sw-end2").value;
            setSW({start:s, end:e});
            setEditing(false);
          }} style={{...bp,padding:"9px 18px",marginBottom:14}}>Update</button>
          <button onClick={()=>{setSW({enabled:false}); setEditing(false);}}
            style={{...bs,padding:"9px 14px",marginBottom:14,color:C.red,borderColor:C.red+"55"}}>Disable</button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ═══════════════════════════════════════════════════════════════════════════════
function OverviewTab({ project, onUpdate }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({...project});
  const fileRef      = useRef();
  const coverRef     = useRef();
  const st = getStatus(project.status);
  // Keep form in sync when project prop updates from outside
  useEffect(() => { if (!edit) setForm({...project}); }, [project, edit]);

  const save = () => { onUpdate(form); setEdit(false); };
  // Auto-save any field change immediately (no manual save needed)
  const setField = (k, v) => {
    const updated = {...form, [k]: v};
    setForm(updated);
    onUpdate(updated);   // immediate persist
  };

  const addImages = (e) => {
    const files = Array.from(e.target.files);
    files.forEach(f=>{
      const r = new FileReader();
      // Use file's lastModified if available (closer to capture time), else now
      const timestamp = f.lastModified ? new Date(f.lastModified).toISOString() : new Date().toISOString();
      r.onload = ev => onUpdate({...project, images:[...(project.images||[]),{id:uid(),src:ev.target.result,caption:"",takenAt:timestamp}]});
      r.readAsDataURL(f);
    });
  };

  const setCover = (e) => {
    const f = e.target.files[0]; if(!f) return;
    const r = new FileReader();
    r.onload = ev => onUpdate({...project, coverImage: ev.target.result});
    r.readAsDataURL(f);
  };

  const removeImage = (id) => onUpdate({...project, images:(project.images||[]).filter(i=>i.id!==id)});

  const kpis = [
    { label:"Daily Done",   val:`${(project.tasks.daily||[]).filter(t=>t.done).length}/${(project.tasks.daily||[]).length}`,  color:C.accent },
    { label:"Weekly Done",  val:`${(project.tasks.weekly||[]).filter(t=>t.done).length}/${(project.tasks.weekly||[]).length}`, color:C.blue   },
    { label:"Docs Approved",val:`${(project.approvals||[]).filter(a=>a.status==="approved").length}/${(project.approvals||[]).length}`, color:C.green },
    { label:"Procure OK",   val:`${(project.procurements||[]).filter(p=>p.status==="delivered").length}/${(project.procurements||[]).length}`, color:C.purple },
  ];
  const is=getInputStyle();
  const bp=getBtnPrimary();
  const bs=getBtnSecondary();
  const [statusCopied, setStatusCopied] = useState(false);

  const handleShareStatus = async () => {
    const report = generateProjectStatusReport(project);
    if (navigator.share) {
      try {
        await navigator.share({ title: `${project.name} — Status`, text: report });
        return;
      } catch { /* user cancelled — fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(report);
      setStatusCopied(true);
      setTimeout(()=>setStatusCopied(false), 2000);
    } catch {
      alert(report);
    }
  };

  return (
    <div>
      <div style={{ marginBottom:16, display:"flex", justifyContent:"flex-end" }}>
        <button onClick={handleShareStatus}
          style={{ background: statusCopied ? C.green+"22" : C.accent+"18",
                   border:`1px solid ${statusCopied ? C.green : C.accent}55`,
                   color: statusCopied ? C.green : C.accent,
                   borderRadius:8, padding:"7px 16px", cursor:"pointer", fontSize:12, fontWeight:700,
                   fontFamily:"inherit", transition:"all 0.2s" }}>
          {statusCopied ? "✓ Copied" : "📤 Share Project Status"}
        </button>
      </div>
      <div style={{ marginBottom:16 }}>
        <ShutdownWindowCard project={project} onUpdate={onUpdate}/>
      </div>
      <div style={{ display:"grid",gridTemplateColumns:"auto repeat(4,1fr)",gap:12,marginBottom:24,flexWrap:"wrap" }}>
        <div style={{ background:C.card,border:`1px solid ${C.border}`,borderRadius:11,padding:"16px 20px",display:"flex",alignItems:"center",gap:14 }}>
          <div style={{ position:"relative",display:"inline-flex",alignItems:"center",justifyContent:"center" }}>
            <ProgressRing pct={project.progress} size={68}/>
            <span style={{ position:"absolute",color:C.accent,fontWeight:800,fontSize:13,fontFamily:"'JetBrains Mono',monospace" }}>{project.progress}%</span>
          </div>
          <div>
            <div style={{ color:C.muted,fontSize:11,letterSpacing:1,textTransform:"uppercase",marginBottom:4 }}>Progress</div>
            <input type="range" min={0} max={100} value={project.progress}
              onChange={e=>onUpdate({...project,progress:+e.target.value})}
              style={{ width:90,accentColor:C.accent }}/>
          </div>
        </div>
        {kpis.map(k=>(
          <div key={k.label} style={{ background:C.card,border:`1px solid ${C.border}`,borderRadius:11,padding:"16px 18px" }}>
            <div style={{ color:k.color,fontWeight:800,fontSize:24,fontFamily:"'JetBrains Mono',monospace",lineHeight:1 }}>{k.val}</div>
            <div style={{ color:C.muted,fontSize:11,marginTop:6 }}>{k.label}</div>
          </div>
        ))}
      </div>

      <div style={{ background:C.card,border:`1px solid ${C.border}`,borderRadius:11,padding:"20px",marginBottom:20 }}>
        <div style={{ display:"flex",justifyContent:"space-between",marginBottom:16,alignItems:"center" }}>
          <SectionLabel>Project Info</SectionLabel>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>coverRef.current.click()} style={{...bs,fontSize:12,padding:"6px 12px"}}>🖼 Cover Image</button>
            <input ref={coverRef} type="file" accept="image/*" style={{display:"none"}} onChange={setCover}/>
            <button onClick={()=>edit?save():setEdit(true)}
              style={{...edit?{...bp,background:C.green}:bp,padding:"6px 16px",fontSize:12}}>
              {edit?"✓ Save":"✎ Edit"}
            </button>
          </div>
        </div>
        {edit ? (
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
            {[["name","Project Name"],["client","Client"],["location","Location"],["discipline","Discipline"],["startDate","Start Date"],["endDate","End Date"]].map(([k,lbl])=>(
              <Field key={k} label={lbl}>
                {k==="discipline" ? (
                  <select value={form[k]||""} onChange={e=>setField(k, e.target.value)} style={is}>
                    {DISCIPLINES.map(d=><option key={d} value={d}>{d}</option>)}
                  </select>
                ) : (
                  <input type={k.includes("Date")?"date":"text"} value={form[k]||""}
                    onChange={e=>setField(k, e.target.value)} style={is}/>
                )}
              </Field>
            ))}
            <Field label="Status">
              <select value={form.status} onChange={e=>setField('status', e.target.value)} style={is}>
                {STATUS_OPTS.map(s=><option key={s.value} value={s.value}>{s.en} — {s.label}</option>)}
              </select>
            </Field>
            <div style={{ display:"flex",justifyContent:"flex-end",alignItems:"flex-end" }}>
              <button onClick={()=>setEdit(false)} style={{...bs,fontSize:12}}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px 24px" }}>
            {[["Client",project.client],["Discipline",project.discipline],["Location",project.location],
              ["Status",`${st.en} · ${st.label}`],["Start Date",project.startDate],["End Date",project.endDate]].map(([k,v])=>(
              <div key={k}>
                <div style={{ color:C.dim,fontSize:11,letterSpacing:0.5,textTransform:"uppercase",marginBottom:3 }}>{k}</div>
                <div style={{ color:C.text,fontSize:14 }}>{v||"—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ background:C.card,border:`1px solid ${C.border}`,borderRadius:11,padding:"20px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
          <SectionLabel>Site Photos {(project.images||[]).length>0&&`(${(project.images||[]).length})`}</SectionLabel>
          <button onClick={()=>fileRef.current.click()} style={{...bs,fontSize:12,padding:"6px 14px"}}>📷 Add Photos</button>
          <input ref={fileRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={addImages}/>
        </div>
        {(project.images||[]).length===0 ? (
          <div style={{ color:C.dim,fontSize:13,textAlign:"center",padding:"28px 0",border:`1px dashed ${C.border2}`,borderRadius:8 }}>
            No photos yet — click "Add Photos" to attach site images
          </div>
        ) : (
          <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:12 }}>
            {(project.images||[]).map(img=>{
              const dt = img.takenAt ? new Date(img.takenAt) : null;
              const dateLabel = dt ? dt.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}) : null;
              const timeLabel = dt ? dt.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}) : null;
              return (
              <div key={img.id} style={{ borderRadius:8,overflow:"hidden",border:`1px solid ${C.border}`,position:"relative" }}
                onMouseEnter={e=>e.currentTarget.querySelector(".del-btn").style.opacity="1"}
                onMouseLeave={e=>e.currentTarget.querySelector(".del-btn").style.opacity="0"}>
                <img src={img.src} style={{ width:"100%",height:130,objectFit:"cover",display:"block" }}/>
                {dateLabel && (
                  <div style={{
                    position:"absolute", bottom:0, left:0, right:0,
                    background:"linear-gradient(to top, rgba(0,0,0,0.75), transparent)",
                    padding:"16px 8px 6px 8px",
                    display:"flex", justifyContent:"space-between", alignItems:"baseline",
                  }}>
                    <span style={{ color:"#fff", fontSize:10, fontWeight:700, fontFamily:"'JetBrains Mono',monospace" }}>{dateLabel}</span>
                    <span style={{ color:"#ffffffcc", fontSize:9, fontFamily:"'JetBrains Mono',monospace" }}>{timeLabel}</span>
                  </div>
                )}
                <button className="del-btn" onClick={()=>removeImage(img.id)}
                  style={{ position:"absolute",top:6,right:6,background:"rgba(0,0,0,0.7)",border:"none",color:C.red,
                           borderRadius:6,width:26,height:26,cursor:"pointer",fontSize:12,opacity:0,transition:"opacity 0.2s" }}>✕</button>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT DETAIL
// ═══════════════════════════════════════════════════════════════════════════════
function ProjectDetail({ project, onUpdate, onBack }) {
  // Restore last open tab for this specific project (if remembered), else default to overview
  const [tab,setTab] = useState(() => {
    const nav = loadNavState();
    return (nav?.activeProject === project.id && nav?.tab) ? nav.tab : "overview";
  });
  // Persist tab choice alongside the active project, so closing/reopening the app
  // returns to the exact same screen
  useEffect(() => {
    saveNavState({ activeProject: project.id, tab });
  }, [tab, project.id]);
  // Keep a ref that always points to the latest project so closures never use stale data
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);
  const upd      = useCallback((patch) => {
    const latest = projectRef.current;
    onUpdate({...latest, ...patch});
  }, [onUpdate]);
  const updTasks = useCallback((type,tasks) => upd({tasks:{...projectRef.current.tasks,[type]:tasks}}), [upd]);
  const st = getStatus(project.status);
  const bs = getBtnSecondary();

  const DEFAULT_TABS = [
    {id:"overview",label:"Overview",icon:"◈"},
    {id:"daily",   label:"Daily",   icon:"▸"},
    {id:"weekly",  label:"Weekly",  icon:"▸▸"},
    {id:"procurement", label:"Procurement", icon:"⊞"},
    {id:"sequence",    label:"Execution",   icon:"▶"},
    {id:"approvals",   label:"Approvals",   icon:"✦"},
    {id:"notes",       label:"Notes",       icon:"≡"},
  ];

  // Tab order is global (applies to every project) and persisted across sessions.
  // If the user has a saved custom order, apply it; otherwise fall back to defaults.
  // Any tab IDs not present in the saved order (e.g. after an app update adds a new tab)
  // are appended at the end so nothing is ever silently lost.
  const [tabOrder, setTabOrder] = useState(() => {
    const saved = loadTabOrder();
    if (!saved) return DEFAULT_TABS;
    const byId = Object.fromEntries(DEFAULT_TABS.map(t => [t.id, t]));
    const ordered = saved.filter(id => byId[id]).map(id => byId[id]);
    const missing = DEFAULT_TABS.filter(t => !saved.includes(t.id));
    return [...ordered, ...missing];
  });

  const handleTabReorder = (newOrder) => {
    setTabOrder(newOrder);
    saveTabOrder(newOrder.map(t => t.id));
  };

  const {
    dragIdx: tabDragIdx, overIdx: tabOverIdx, isDragging: isTabDragging,
    onPressStart: onTabPressStart, onPressMove: onTabPressMove, onPressEnd: onTabPressEnd,
  } = useHoldDragReorder(tabOrder, handleTabReorder);

  const tabBarRef = useRef(null);

  return (
    <div style={{ height:"100%",display:"flex",flexDirection:"column" }}>
      <div style={{ padding:"14px 28px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",background:C.surface,flexShrink:0 }}>
        <button onClick={onBack} style={{...bs,fontSize:12,padding:"6px 14px"}}>← Back</button>
        {project.coverImage && (
          <div style={{ width:36,height:36,borderRadius:7,overflow:"hidden",flexShrink:0 }}>
            <img src={project.coverImage} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          </div>
        )}
        <div style={{ flex:1,minWidth:0 }}>
          <div style={{ color:C.text,fontWeight:800,fontSize:17,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.2 }}>{project.name}</div>
          <div style={{ color:C.muted,fontSize:12,marginTop:2 }}>{project.client} · {project.location}</div>
        </div>
        <Badge color={st.color} label={`${st.en} · ${st.label}`}/>
      </div>

      {/* Tab bar — hold (≈320ms) then drag horizontally to reorder. A quick swipe scrolls normally;
          a quick tap switches tabs; only a deliberate long-press-then-move triggers reordering. */}
      <div ref={tabBarRef}
        style={{ display:"flex",gap:1,padding:"0 28px",borderBottom:`1px solid ${C.border}`,overflowX:"auto",background:C.surface,flexShrink:0,WebkitOverflowScrolling:"touch" }}>
        {tabOrder.map((t,idx)=>{
          const isBeingDragged = isTabDragging && tabDragIdx === idx;
          const isDropTarget   = isTabDragging && tabOverIdx === idx && tabDragIdx !== idx;
          return (
            <button key={t.id}
              onClick={()=>{ if(!isTabDragging) setTab(t.id); }}
              // Mouse / desktop drag support via pointer events (no touch-action concerns on desktop)
              onPointerDown={(e)=>{
                if (e.pointerType === "touch") return; // touch is handled by onTouchStart below instead
                onTabPressStart(idx, e.clientX, e.currentTarget.offsetWidth, e.currentTarget);
              }}
              onPointerMove={(e)=>{ if(isTabDragging && e.pointerType !== "touch") onTabPressMove(e.clientX); }}
              onPointerUp={(e)=>{ if(e.pointerType !== "touch") onTabPressEnd(); }}
              onPointerCancel={(e)=>{ if(e.pointerType !== "touch") onTabPressEnd(); }}
              // Mobile: native touch events, so we control preventDefault() timing precisely.
              // Critically, we do NOT call preventDefault() here — only inside onPressMove,
              // and only after the hold has activated. This lets normal swipe-scroll pass through untouched.
              onTouchStart={(e)=>{
                const touch = e.touches[0];
                onTabPressStart(idx, touch.clientX, e.currentTarget.offsetWidth, e.currentTarget);
              }}
              onTouchMove={(e)=>{
                if (!isTabDragging && tabDragIdx === null) {
                  // Not yet activated — let the browser scroll natively, just track movement for cancel-check
                  onTabPressMove(e.touches[0].clientX, null);
                  return;
                }
                onTabPressMove(e.touches[0].clientX, e);
              }}
              onTouchEnd={onTabPressEnd}
              onTouchCancel={onTabPressEnd}
              style={{
                background: isDropTarget ? C.accent+"18" : "transparent",
                border:"none",
                borderBottom:`2px solid ${tab===t.id && !isTabDragging ? C.accent : isDropTarget ? C.accent+"66" : "transparent"}`,
                color:tab===t.id?C.text:C.muted,
                padding:"12px 14px",
                cursor: isTabDragging ? "grabbing" : "pointer",
                fontSize:12,fontWeight:tab===t.id?700:500,letterSpacing:0.4,
                whiteSpace:"nowrap",transition: isBeingDragged ? "none" : "all 0.15s",
                fontFamily:"inherit",
                opacity: isBeingDragged ? 0.4 : 1,
                transform: isBeingDragged ? "scale(0.95)" : "scale(1)",
                // NOTE: no touchAction set here at all — defaults to "auto" so native scroll
                // always works. The hook locks it to "none" dynamically, only on the single
                // element being dragged, only after the hold timer confirms it's a drag.
                userSelect:"none",
                position:"relative",
              }}>
              {t.icon} {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex:1,overflowY:"auto",padding:"22px 28px" }}>
        {tab==="overview"     && <OverviewTab      project={project} onUpdate={upd}/>}
        {tab==="daily"        && <TasksTab tasks={project.tasks.daily}  type="daily"  onUpdate={t=>updTasks("daily",t)}/>}
        {tab==="weekly"       && <TasksTab tasks={project.tasks.weekly} type="weekly" onUpdate={t=>updTasks("weekly",t)}/>}
        {tab==="procurement"  && <ProcurementTab   items={project.procurements} onUpdate={v=>upd({procurements:v})} projectName={project.name}/>}
        {tab==="sequence"     && <ExecutionSequenceTab steps={project.steps}       onUpdate={v=>upd({steps:v})} projectId={project.id}/>}
        {tab==="approvals"    && <ApprovalsTab     items={project.approvals}    onUpdate={v=>upd({approvals:v})}/>}
        {tab==="notes"        && <NotesTab         notes={project.notes}        onUpdate={v=>upd({notes:v})}/>}
      </div>
    </div>
  );
}

// ─── New Project Modal ────────────────────────────────────────────────────────
function NewProjectModal({ onAdd, onClose }) {
  const [form,setForm] = useState({ name:"",client:"",location:"",discipline:"Pump Stations",startDate:today(),endDate:"",status:"active" });
  const set = (k,v) => setForm(p=>({...p,[k]:v}));
  const submit = () => {
    if(!form.name.trim()) return;
    onAdd({ id:uid(),...form,progress:0,notes:"",coverImage:null,images:[],tasks:{daily:[],weekly:[]},deliverables:[],procurements:[],approvals:[],steps:[] });
    onClose();
  };
  const is=getInputStyle();
  const bp=getBtnPrimary();
  const bs=getBtnSecondary();
  return (
    <Modal title="New Project" onClose={onClose}>
      {[["name","Project Name *"],["client","Client / Owner"],["location","Location"]].map(([k,lbl])=>(
        <Field key={k} label={lbl}><input value={form[k]} onChange={e=>set(k,e.target.value)} style={is} placeholder={lbl}/></Field>
      ))}
      <Field label="Discipline">
        <select value={form.discipline} onChange={e=>set("discipline",e.target.value)} style={is}>
          {DISCIPLINES.map(d=><option key={d}>{d}</option>)}
        </select>
      </Field>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
        <Field label="Start Date"><input type="date" value={form.startDate} onChange={e=>set("startDate",e.target.value)} style={is}/></Field>
        <Field label="End Date"><input type="date" value={form.endDate} onChange={e=>set("endDate",e.target.value)} style={is}/></Field>
      </div>
      <Field label="Initial Status">
        <select value={form.status} onChange={e=>set("status",e.target.value)} style={is}>
          {STATUS_OPTS.map(s=><option key={s.value} value={s.value}>{s.en} — {s.label}</option>)}
        </select>
      </Field>
      <div style={{ display:"flex",justifyContent:"flex-end",gap:8,marginTop:20 }}>
        <button onClick={onClose} style={bs}>Cancel</button>
        <button onClick={submit} style={bp}>Create Project</button>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [data,setData]                 = useState(null);
  const dataRef = useRef(null);   // always holds latest data for beforeunload
  const activeProjectRef = useRef(null);   // always holds latest navigation position
  const [profile,setProfile]           = useState(null);
  const [loading,setLoading]           = useState(true);
  const [activeProject,setActiveProject] = useState(null);
  const [showNew,setShowNew]           = useState(false);
  const [showDaily,setShowDaily]       = useState(false);
  const [showPersonalTasks,setShowPersonalTasks] = useState(false);
  const [showProfileEdit,setShowProfileEdit] = useState(false);
  const [showThemePicker,setShowThemePicker] = useState(false);
  const [showDataMgr,setShowDataMgr]         = useState(false);

  // ── Rollover dialog ──────────────────────────────────────────────────────────
  const [rolloverItems, setRolloverItems] = useState([]); // pending overdue tasks to decide on

  const checkRollover = (projects) => {
    const todayStr = today();
    const state = loadRolloverState();
    // Only show once per calendar day
    if (state?.lastChecked === todayStr) return;
    saveRolloverState({ lastChecked: todayStr });

    const items = [];
    (projects||[]).forEach(p => {
      (p.tasks?.daily||[]).forEach(t => {
        if (!t.done && t.date && t.date < todayStr) {
          items.push({
            projectId: p.id,
            projectName: p.name,
            taskId: t.id,
            text: t.text,
            date: t.date,
          });
        }
      });
    });
    if (items.length > 0) setRolloverItems(items);
  };

  const handleRolloverDone = (decisions) => {
    setRolloverItems([]);
    const todayStr = today();
    // Apply decisions to each project
    const updatedProjects = (data.projects||[]).map(p => {
      const affected = rolloverItems.filter(i => i.projectId === p.id);
      if (affected.length === 0) return p;

      let daily = [...(p.tasks?.daily||[])];
      const archived = [...(p.tasks?.archived||[])];

      affected.forEach(item => {
        const dec = decisions[item.taskId];
        if (dec === "rollover") {
          daily = daily.map(t => t.id===item.taskId ? {...t, date:todayStr} : t);
        } else if (dec === "archive") {
          const task = daily.find(t=>t.id===item.taskId);
          if (task) {
            archived.push({...task, archivedAt: new Date().toISOString()});
            daily = daily.filter(t=>t.id!==item.taskId);
          }
        }
        // "skip" = leave as-is
      });

      return {...p, tasks:{...p.tasks, daily, archived}};
    });
    _commit({...data, projects: updatedProjects});
  };
  const [setupDone,setSetupDone]       = useState(false);
  const [themeKey,setThemeKey]         = useState("navy");
  const [notifDismissed,setNotifDismissed] = useState(false);
  const windowWidth = useWindowWidth();

  useEffect(()=>{
    const init = async () => {
      const d   = await loadData();   // async — restores images from IDB
      const p   = loadProf();
      const t   = loadTheme();
      const dismissed = loadDismissed();
      // Defensive default: existing saved data from before this feature won't have
      // personalTasks at all — without this, anything reading data.personalTasks
      // would crash on undefined.
      const initial = d ? { ...d, personalTasks: d.personalTasks || [] } : SEED;
      dataRef.current = initial;
      if (!d) saveData(initial);      // persist seed on first run
      setData(initial);
      setProfile(p||null);
      setSetupDone(!!p);
      setThemeKey(t||"navy");
      const todayStr = today();
      setNotifDismissed(dismissed?.date === todayStr);
      // Restore last navigation position (which project was open)
      // Only restore if that project still exists in the loaded data
      const nav = loadNavState();
      if (nav?.activeProject && initial.projects?.some(pr => pr.id === nav.activeProject)) {
        setActiveProject(nav.activeProject);
      }
      setLoading(false);
      // Check for overdue tasks once per day after data loads
      if (d) checkRollover(d.projects || []);
    };
    init();
  },[]);

  // Update C object whenever theme changes
  useEffect(()=>{
    const theme = THEMES[themeKey] || THEMES.navy;
    Object.assign(C, theme);
    saveTheme(themeKey);
    // Force re-render by updating document style
    document.documentElement.style.setProperty("--accent", theme.accent);
  },[themeKey]);

  // Save on every data change (primary) + on page unload (safety net)
  // (saveData called directly in each mutation — no need for effect here)
  useEffect(()=>{
    // Use ref so handler always saves LATEST data regardless of when it fires.
    // Uses flushPendingSave (not the debounced version) so that if the user is
    // backgrounding the app right after typing, we don't lose the last edit
    // sitting in the debounce window — it's written immediately instead.
    const handler = () => {
      if(dataRef.current) flushPendingSave(dataRef.current);
      // Merge so we don't wipe the tab that ProjectDetail already persisted
      const existing = loadNavState() || {};
      saveNavState({ ...existing, activeProject: activeProjectRef.current });
    };
    // Standard events
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);          // iOS back button
    // visibilitychange is the most reliable on mobile (fires before pagehide)
    const visHandler = () => { if(document.visibilityState==="hidden") handler(); };
    document.addEventListener("visibilitychange", visHandler);
    // Blur fires when user switches app or locks screen on Android
    window.addEventListener("blur", handler);
    return ()=>{
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
      document.removeEventListener("visibilitychange", visHandler);
      window.removeEventListener("blur", handler);
    };
  },[]); // empty deps — always reads from ref

  // ── Mutation helpers ────────────────────────────────────────────────────────
  // Pattern: compute next → write to ref → persist (debounced) → setState (immediate)
  // setState happens synchronously so the UI (including any input the user is
  // actively typing into) always reflects the latest keystroke instantly. The
  // expensive actual persistence to localStorage/IndexedDB is debounced so rapid
  // repeated calls (e.g. one per keystroke) coalesce into a single write instead
  // of running the full image/MOS-file walk on every character typed.
  const _commit = (next) => {
    dataRef.current = next;
    saveDataDebounced(next);   // debounced — coalesces rapid updates (typing)
    setData(next);             // always immediate — UI never lags
  };

  const updateProject = (upd) => {
    const d = dataRef.current;
    if (!d) return;
    _commit({...d, projects: d.projects.map(p => p.id===upd.id ? upd : p)});
  };
  const addProject = (p) => {
    const d = dataRef.current;
    if (!d) return;
    _commit({...d, projects: [...d.projects, p]});
  };
  const deleteProject = (id) => {
    const d = dataRef.current;
    if (!d) return;
    _commit({...d, projects: d.projects.filter(p => p.id !== id)});
    if (activeProject===id) setActiveProject(null);
  };
  const reorderProjects = (arr) => {
    const d = dataRef.current;
    if (!d) return;
    _commit({...d, projects: arr});
  };
  const saveProfile = (p) => { setProfile(p); saveProf(p); setSetupDone(true); setShowProfileEdit(false); };

  const handleDismissNotif = () => {
    const todayStr = today();
    setNotifDismissed(true);
    saveDismissed({ date: todayStr });
  };

  // Keep nav ref + persisted nav state in sync with activeProject at all times.
  // Merge with existing nav state so we don't clobber the "tab" saved by ProjectDetail.
  useEffect(() => {
    activeProjectRef.current = activeProject;
    const existing = loadNavState() || {};
    saveNavState({ ...existing, activeProject, tab: activeProject === existing.activeProject ? existing.tab : "overview" });
  }, [activeProject]);

  // ── Android Back button handler ─────────────────────────────────────────────
  // Push a dummy history state whenever we navigate "deeper" (open a project or
  // modal). When the user presses the hardware Back button, the browser pops this
  // dummy state and fires "popstate" — we intercept it and close the topmost layer
  // instead of letting the browser exit the PWA.
  useEffect(() => {
    // Push a new history entry so "Back" has somewhere to go
    const anyOpen = activeProject || showDaily || showPersonalTasks || showProfileEdit || showThemePicker || showDataMgr;
    if (anyOpen) {
      window.history.pushState({ mpmLayer: true }, "");
    }
  }, [activeProject, showDaily, showPersonalTasks, showProfileEdit, showThemePicker, showDataMgr]);

  useEffect(() => {
    const handlePop = (e) => {
      // Close the topmost layer in priority order (most modal-like first)
      if (showDataMgr)        { setShowDataMgr(false);        window.history.pushState({ mpmLayer: true }, ""); return; }
      if (showThemePicker)    { setShowThemePicker(false);     window.history.pushState({ mpmLayer: true }, ""); return; }
      if (showProfileEdit)    { setShowProfileEdit(false);     window.history.pushState({ mpmLayer: true }, ""); return; }
      if (showPersonalTasks)  { setShowPersonalTasks(false);   window.history.pushState({ mpmLayer: true }, ""); return; }
      if (showDaily)          { setShowDaily(false);           window.history.pushState({ mpmLayer: true }, ""); return; }
      if (activeProject)      { setActiveProject(null);        return; }
      // Nothing open — let the browser handle it naturally (exit PWA on Dashboard)
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [activeProject, showDaily, showPersonalTasks, showProfileEdit, showThemePicker, showDataMgr]);

  if(loading) return (
    <div style={{ height:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center" }}>
      <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:16 }}>
        <GearIcon size={48} color={C.accent}/>
        <div style={{ color:C.accent,fontFamily:"'JetBrains Mono',monospace",letterSpacing:3,fontSize:14 }}>LOADING…</div>
      </div>
    </div>
  );

  if(!setupDone) return <ProfileSetup onDone={saveProfile}/>;
  if(showProfileEdit) return <ProfileSetup initial={profile} onDone={saveProfile}/>;

  const currentProject = data.projects.find(p=>p.id===activeProject);
  const initials = profile?.name?.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()||"?";

  return (
    <div style={{ height:"100vh",background:C.bg,color:C.text,fontFamily:"'Inter',system-ui,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden" }}>

      {/* Top nav — responsive: on narrow screens, breadcrumb + date hide first so profile/name always stays visible */}
      <header style={{ borderBottom:`1px solid ${C.border}`,padding:"0 12px",display:"flex",alignItems:"center",gap:8,height:56,flexShrink:0,background:C.surface,overflow:"hidden" }}>
        {/* Logo with gear — hide text on very small screens, keep icon */}
        <div style={{ display:"flex",alignItems:"center",gap:8,flexShrink:0 }}>
          <GearIcon size={24} color={C.accent}/>
          <div style={{ lineHeight:1.1, display:windowWidth < 480 ? "none" : "block" }}>
            <div style={{ color:C.text,fontWeight:800,fontSize:11,fontFamily:"'JetBrains Mono',monospace",letterSpacing:1,whiteSpace:"nowrap" }}>MECHANICAL</div>
            <div style={{ color:C.accent,fontSize:7,letterSpacing:2,fontFamily:"'JetBrains Mono',monospace",textTransform:"uppercase",whiteSpace:"nowrap" }}>PROJECTS MANAGER</div>
          </div>
        </div>

        {/* Breadcrumb — collapses/truncates on small screens, never pushes profile out */}
        <div style={{ display:"flex",alignItems:"center",gap:6,minWidth:0,overflow:"hidden",flex:"0 1 auto" }}>
          <span style={{ color:activeProject?C.muted:C.accent,fontSize:12,cursor:activeProject?"pointer":"default",transition:"color 0.15s",whiteSpace:"nowrap",flexShrink:0 }}
            onClick={()=>setActiveProject(null)}>Projects</span>
          {currentProject&&(<>
            <span style={{ color:C.dim,flexShrink:0 }}>›</span>
            <span style={{ color:C.accent,fontSize:12,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",minWidth:0 }}>{currentProject.name}</span>
          </>)}
        </div>

        {/* Right-side action cluster — flex-shrink so it never gets clipped; icons stay, labels hide first */}
        <div style={{ marginLeft:"auto",display:"flex",alignItems:"center",gap:6,flexShrink:0 }}>
          {/* Daily tasks shortcut */}
          <button onClick={()=>setShowDaily(true)}
            style={{ background:"transparent",border:`1px solid ${C.border2}`,color:C.muted,
                     borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:11,fontWeight:700,letterSpacing:0.5,
                     display:"flex",alignItems:"center",gap:4,transition:"all 0.15s",fontFamily:"inherit",flexShrink:0 }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;e.currentTarget.style.color=C.accent;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border2;e.currentTarget.style.color=C.muted;}}>
            ☑
          </button>

          {/* Personal tasks shortcut — standalone tasks not tied to any project */}
          <button onClick={()=>setShowPersonalTasks(true)} title="Personal tasks (not project-specific)"
            style={{ background:"transparent",border:`1px solid ${C.border2}`,color:C.muted,
                     borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:13,transition:"all 0.15s",
                     display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",flexShrink:0,
                     position:"relative" }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;e.currentTarget.style.color=C.accent;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border2;e.currentTarget.style.color=C.muted;}}>
            📌
            {(data?.personalTasks||[]).filter(t=>!t.done).length > 0 && (
              <span style={{ position:"absolute", top:-4, right:-4, background:C.accent, color:"#fff",
                             borderRadius:"50%", width:15, height:15, fontSize:9, fontWeight:800,
                             display:"flex", alignItems:"center", justifyContent:"center" }}>
                {(data.personalTasks||[]).filter(t=>!t.done).length}
              </span>
            )}
          </button>

          {/* Theme picker button */}
          <button onClick={()=>setShowThemePicker(true)}
            style={{ background:"transparent",border:`1px solid ${C.border2}`,color:C.muted,
                     borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:13,transition:"all 0.15s",
                     display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",flexShrink:0 }}
            title="Change theme"
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;e.currentTarget.style.color=C.accent;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border2;e.currentTarget.style.color=C.muted;}}>
            🎨
          </button>

          {/* Export / Import */}
          <button onClick={()=>setShowDataMgr(true)}
            style={{ background:"transparent",border:`1px solid ${C.border2}`,color:C.muted,
                     borderRadius:7,padding:"5px 9px",cursor:"pointer",fontSize:13,transition:"all 0.15s",
                     display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit",flexShrink:0 }}
            title="Export / Import data"
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.green;e.currentTarget.style.color=C.green;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border2;e.currentTarget.style.color=C.muted;}}>
            ⇅
          </button>

          {/* Date — hidden on narrow screens, profile takes priority */}
          <span style={{ color:C.dim,fontSize:11,fontFamily:"monospace",whiteSpace:"nowrap",
                         display:windowWidth < 420 ? "none" : "inline" }}>
            {new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}
          </span>

          {/* Profile avatar — ALWAYS visible; name/title hide on very narrow screens but avatar+initials stay */}
          <button onClick={()=>setShowProfileEdit(true)}
            style={{ background:"none",border:"none",cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:7,flexShrink:0,minWidth:0 }}>
            <div style={{ width:32,height:32,borderRadius:"50%",background:`linear-gradient(135deg,${C.accent},${C.accentDim})`,
                          display:"flex",alignItems:"center",justifyContent:"center",
                          overflow:"hidden",border:`2px solid ${C.accentDim}`,flexShrink:0 }}>
              {profile?.avatar
                ? <img src={profile.avatar} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                : <span style={{ color:"#fff",fontWeight:800,fontSize:12 }}>{initials}</span>}
            </div>
            <span style={{ color:C.muted,fontSize:12,display:windowWidth < 360 ? "none" : "flex",
                           flexDirection:"column",alignItems:"flex-start",lineHeight:1.2,minWidth:0,maxWidth:90 }}>
              <span style={{ color:C.text,fontSize:13,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:90 }}>
                {profile?.name?.split(" ")[0]||""}
              </span>
              <span style={{ fontSize:10,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:90 }}>
                {profile?.title||"Engineer"}
              </span>
            </span>
          </button>
        </div>
      </header>

      {/* Body */}
      <main style={{ flex:1,overflowY:"auto" }}>
        {activeProject&&currentProject ? (
          <ProjectDetail project={currentProject} onUpdate={updateProject} onBack={()=>setActiveProject(null)}/>
        ) : (
          <Dashboard
            projects={data.projects}
            data={data}
            profile={profile}
            onSelect={id=>setActiveProject(id)}
            onAddNew={()=>setShowNew(true)}
            onDelete={deleteProject}
            onReorder={reorderProjects}
            onOpenDaily={()=>setShowDaily(true)}
            notifDismissed={notifDismissed}
            onDismissNotif={handleDismissNotif}
          />
        )}
      </main>

      {showNew         && <NewProjectModal onAdd={addProject}  onClose={()=>setShowNew(false)}/>}
      {/* Rollover dialog — appears once per day when there are overdue unfinished tasks */}
      {rolloverItems.length > 0 && (
        <TaskRolloverDialog overdueItems={rolloverItems} onDone={handleRolloverDone}/>
      )}

      {showDaily       && <DailyPanel projects={data.projects} onUpdateProject={updateProject} onClose={()=>setShowDaily(false)} profile={profile}/>}
      {showPersonalTasks && <PersonalTasksPanel tasks={data.personalTasks} onUpdateTasks={(next)=>_commit({...data, personalTasks: next})} onClose={()=>setShowPersonalTasks(false)}/>}
      {showThemePicker && <ThemePickerModal currentTheme={themeKey} onSelect={k=>{setThemeKey(k);}} onClose={()=>setShowThemePicker(false)}/>}
      {showDataMgr     && <DataManagerModal data={data} onImport={d=>{dataRef.current=d;saveData(d);setData(d);setShowDataMgr(false);}} onClose={()=>setShowDataMgr(false)}/>}
    </div>
  );
}
