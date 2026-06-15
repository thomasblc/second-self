// Persistent per-user app config for Second Self.
// Lives at ~/.second-self/config.json (outside the repo, survives a repo move/clone).
// Holds the list of known vaults, the current one, and small UI/automation prefs.
// Everything is local; nothing here ever leaves the machine.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Config dir is overridable (SECOND_SELF_CONFIG_DIR) so tests can isolate from the real one.
export const CONFIG_DIR = process.env.SECOND_SELF_CONFIG_DIR || path.join(os.homedir(), ".second-self");
const FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  vaults: [],                 // [{ path, name }] known vaults, most-recent first
  current: null,              // absolute path of the active vault
  agentName: "Second Self",   // what the assistant calls itself (user-renamable); flows into the system prompt + chat label
  autoRetrain: { enabled: false, intervalDays: 7, baseKey: "1.7b", lastRun: null },
  autoSync: { enabled: false, intervalHours: 24, lastRun: null }, // re-index context sources on a schedule (near-live)
  ui: {},                     // misc client prefs we want to persist server-side
};

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // coerce shape: a hand-edited or corrupt file must never crash boot
    return {
      ...DEFAULTS, ...raw,
      vaults: Array.isArray(raw.vaults) ? raw.vaults.filter((v) => v && typeof v.path === "string") : [],
      current: typeof raw.current === "string" ? raw.current : null,
      agentName: (typeof raw.agentName === "string" && raw.agentName.trim()) ? raw.agentName.trim().slice(0, 40) : DEFAULTS.agentName,
      ui: raw.ui && typeof raw.ui === "object" ? raw.ui : {},
      autoRetrain: { ...DEFAULTS.autoRetrain, ...(raw.autoRetrain && typeof raw.autoRetrain === "object" ? raw.autoRetrain : {}) },
      autoSync: { ...DEFAULTS.autoSync, ...(raw.autoSync && typeof raw.autoSync === "object" ? raw.autoSync : {}) },
    };
  } catch { return { ...DEFAULTS }; }
}

function write(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), "utf8"); // small file, atomic-enough for a single local writer
  } catch { /* non-fatal: app still works, just won't remember across restarts */ }
}

let cache = read();

export function getConfig() { return cache; }

export function saveConfig(patch) {
  cache = { ...cache, ...patch, autoRetrain: { ...cache.autoRetrain, ...(patch.autoRetrain || {}) }, autoSync: { ...cache.autoSync, ...(patch.autoSync || {}) }, ui: { ...cache.ui, ...(patch.ui || {}) } };
  write(cache);
  return cache;
}

// Record a vault as known + make it current. Dedupes by resolved path, most-recent first.
export function rememberVault(absPath, name) {
  const p = path.resolve(absPath);
  const label = name || path.basename(p) || p;
  const vaults = [{ path: p, name: label }, ...cache.vaults.filter((v) => path.resolve(v.path) !== p)]
    .filter((v) => { try { return fs.statSync(v.path).isDirectory(); } catch { return false; } })
    .slice(0, 12);
  return saveConfig({ vaults, current: p });
}

export function forgetVault(absPath) {
  const p = path.resolve(absPath);
  const vaults = cache.vaults.filter((v) => path.resolve(v.path) !== p);
  const current = path.resolve(cache.current || "") === p ? (vaults[0]?.path || null) : cache.current;
  return saveConfig({ vaults, current });
}
