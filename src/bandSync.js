const endpoint = import.meta.env.VITE_ZONG_SYNC_URL;

async function call(payload, key) {
  if (!endpoint) throw new Error("Sync is not configured yet.");
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...payload, key }) });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(json.error || "Sync failed.");
  return json;
}

// A whole-library revision makes each write atomic: a stale device is rejected
// instead of silently replacing a bandmate's update.
export async function syncLibrary({ key, state, revision = 0, changed }) {
  const remote = await call({ action: "pull" }, key);
  if (remote.revision > revision && !changed) return { revision: remote.revision, state: remote.state, pulled: true };
  if (!changed) return { revision: remote.revision, state, pulled: false };
  // Send the revision this device last synchronized, not the revision just
  // observed. That lets the server detect a bandmate’s intervening write.
  const pushed = await call({ action: "push", baseRevision: revision, state }, key);
  if (pushed.conflict) return { revision: pushed.revision, state: pushed.state, conflict: true };
  return { revision: pushed.revision, state, pushed: true };
}
