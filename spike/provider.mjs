#!/usr/bin/env node
// Second Self remote-inference PROVIDER (host side). Run this on the machine whose GPU you
// want to lend (e.g. a Mac mini at home). It exposes QVAC delegated inference over the P2P
// DHT: another machine's Second Self connects with the printed public key and its chat /
// agent completions then run HERE. Models load on demand. The vault stays on the consumer;
// only LLM completions are remote.
//
//   node spike/provider.mjs
//
// For a STABLE public key across restarts, set a 64-hex seed first:
//   export QVAC_HYPERSWARM_SEED=$(openssl rand -hex 32)   # save it; same key every boot
// Optionally restrict who can connect (comma-separated consumer public keys):
//   export SS_ALLOWED_KEYS=<key1>,<key2>
import { startQVACProvider, stopQVACProvider } from "@qvac/sdk";

const allowed = (process.env.SS_ALLOWED_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
const line = "-".repeat(66);
try {
  const res = await startQVACProvider(allowed.length ? { firewall: { mode: "allow", publicKeys: allowed } } : {});
  console.log(line);
  console.log("  Second Self provider is running. This machine now serves its GPU.");
  console.log(line);
  console.log("  PAIRING CODE (this machine's public key):");
  console.log("    " + res.publicKey);
  console.log(line);
  console.log("  On your other machine: Settings -> Connect to a remote machine -> paste it.");
  console.log("  Firewall: " + (allowed.length ? `${allowed.length} allowed key(s)` : "open (any peer with the code)"));
  console.log("  Leave this running. Ctrl+C to stop.");
  console.log(line);
} catch (e) {
  console.error("Failed to start provider:", e?.message ?? e);
  process.exit(1);
}
const bye = async () => { try { await stopQVACProvider(); } catch { /* */ } process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
process.stdin.resume();
