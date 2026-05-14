// Thin wrapper around fetch — all backend calls go through here.

async function jsonFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.ok === false)) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  status: () => jsonFetch("/api/unfollow/status"),
  scanStart: (ownerUsername) =>
    jsonFetch("/api/scan/start", {
      method: "POST",
      body: JSON.stringify(ownerUsername ? { ownerUsername } : {}),
    }),
  scanLatest: () => jsonFetch("/api/scan/latest"),
  scanUpload: ({ owner, followers, following }) =>
    jsonFetch("/api/scan/upload", {
      method: "POST",
      body: JSON.stringify({ owner, followers, following }),
    }),
  importStatus: () => jsonFetch("/api/import/status"),
  unfollowStart: (usernames) =>
    jsonFetch("/api/unfollow/start", {
      method: "POST",
      body: JSON.stringify({ usernames }),
    }),
  followStart: ({ sourceUsername, sourceType, count }) =>
    jsonFetch("/api/follow/start", {
      method: "POST",
      body: JSON.stringify({
        source: { username: sourceUsername, type: sourceType },
        count,
      }),
    }),
  jobStop: () => jsonFetch("/api/job/stop", { method: "POST" }),
};
