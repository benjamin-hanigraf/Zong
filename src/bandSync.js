const endpoint = import.meta.env.VITE_ZONG_SYNC_URL;

async function call(payload, key) {
  if (!endpoint) throw new Error("Sync is not configured yet.");
  const body = key ? { ...payload, key } : payload;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(json.error || "Sync failed.");
  return json;
}

// Synchronizes the library against the central Google Sheet database.
// - If `key` is provided, syncs Songs, Spelling Chart, and Team Shared Setlists.
// - If `key` is omitted, syncs Songs and Spelling Chart publicly and freely.
export async function syncLibrary({ key, state, revision = 0, changed }) {
  const isTeam = Boolean(key && key.trim());
  const pullAction = isTeam ? "team_pull" : "public_pull";
  const pushAction = isTeam ? "team_push" : "public_push";

  const remote = await call({ action: pullAction }, isTeam ? key : undefined);

  if (remote.revision > revision && !changed) {
    return { revision: remote.revision, state: remote.state, pulled: true };
  }
  if (!changed) {
    return { revision: remote.revision, state, pulled: false };
  }

  // Send the revision this device last synchronized
  const pushed = await call(
    { action: pushAction, baseRevision: revision, state },
    isTeam ? key : undefined
  );

  if (pushed.conflict) {
    return { revision: pushed.revision, state: pushed.state, conflict: true };
  }
  return { revision: pushed.revision, state: pushed.state || state, pushed: true };
}
