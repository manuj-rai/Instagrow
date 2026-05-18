// Parses Instagram's "Download your information" JSON exports.
// Handles the two shapes Instagram has used:
//   - Top-level array: `[{string_list_data:[{value, ...}], title}]`
//   - Object wrapped:  `{relationships_followers: [...]}` / `{relationships_following: [...]}`

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("FileReader error"));
    r.readAsText(file);
  });
}

function extractEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const k of Object.keys(parsed)) {
      if (/^relationships_/.test(k) && Array.isArray(parsed[k])) return parsed[k];
    }
  }
  return [];
}

function entryToUsername(entry) {
  if (!entry || typeof entry !== "object") return null;
  const sld = entry.string_list_data;
  if (Array.isArray(sld) && sld.length > 0) {
    const first = sld[0];
    if (first && first.value) return String(first.value);
    if (first && first.href) {
      const m = String(first.href).match(/instagram\.com\/(?:_u\/)?([^/?#]+)/);
      if (m) return m[1];
    }
  }
  if (entry.title && typeof entry.title === "string") return entry.title;
  return null;
}

// Heuristic: a file containing follower data has "follower" in the filename
// (followers_1.json, followers_2.json, etc.) or its parsed top-level key
// matches `relationships_followers`. Anything else is treated as following.
export async function classifyAndParseFiles(files) {
  const followers = new Set();
  const following = new Set();
  const errors = [];

  for (const file of files) {
    try {
      const text = await readFileAsText(file);
      const parsed = JSON.parse(text);
      const usernames = (() => {
        const entries = extractEntries(parsed);
        const out = [];
        for (const e of entries) {
          const u = entryToUsername(e);
          if (u) out.push(u.replace(/^@/, "").replace(/\/+$/, "").toLowerCase().trim());
        }
        return out.filter(Boolean);
      })();

      const lowerName = file.name.toLowerCase();
      const objectKey = (!Array.isArray(parsed) && parsed && typeof parsed === "object")
        ? Object.keys(parsed).find((k) => /^relationships_/.test(k)) || ""
        : "";

      const isFollowerFile =
        /followers?_?\d*\.json$/i.test(lowerName) ||
        /relationships_followers/i.test(objectKey);
      const isFollowingFile =
        /following\.json$/i.test(lowerName) ||
        /relationships_following/i.test(objectKey);

      const target = isFollowerFile ? followers : isFollowingFile ? following : null;
      if (!target) {
        errors.push(`${file.name}: couldn't tell if this is followers or following`);
        continue;
      }
      for (const u of usernames) target.add(u);
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }

  return {
    followers: Array.from(followers),
    following: Array.from(following),
    errors,
  };
}
