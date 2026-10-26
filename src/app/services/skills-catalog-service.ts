import { config } from "../../config.js";

export interface SkillCatalogItem {
  name: string;
  description?: string | undefined;
}

function normalizeDirectoryForCommandApi(directory: string): string {
  return directory.replace(/\\/g, "/");
}

// Muse patch (2026-10-24, ported from the VPS dist patch): the bundled SDK's
// skill query returns an empty list from this OpenCode V2 server, so ask the
// server's skill endpoint directly with the project directory header — the
// form it answers with data.
export async function loadSkillsCatalog(projectDirectory: string): Promise<SkillCatalogItem[]> {
  const directory = normalizeDirectoryForCommandApi(projectDirectory);
  const baseUrl = config.opencode.apiUrl.endsWith("/")
    ? config.opencode.apiUrl
    : `${config.opencode.apiUrl}/`;
  const headers: Record<string, string> = { "x-opencode-directory": directory };
  if (config.opencode.password) {
    const credentials = `${config.opencode.username}:${config.opencode.password}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  let response = await fetch(new URL("api/skill", baseUrl), { headers });
  if (!response.ok) {
    throw new Error(`Skill list request failed with HTTP ${response.status}`);
  }
  let payload: unknown = await response.json();
  const firstItems = Array.isArray(payload) ? payload : ((payload as { data?: unknown[] } | null)?.data ?? []);
  if (firstItems.length === 0) {
    // The server cold-misses a directory's first skill query (HTTP 200 with
    // an empty list while the location activates); one retry covers it.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    response = await fetch(new URL("api/skill", baseUrl), { headers });
    if (!response.ok) {
      throw new Error(`Skill list request failed with HTTP ${response.status}`);
    }
    payload = await response.json();
  }
  const items = Array.isArray(payload) ? payload : ((payload as { data?: unknown[] } | null)?.data ?? []);
  const seen = new Set<string>();
  return items
    .filter(
      (skill): skill is { id: string; description?: string } =>
        !!skill &&
        typeof (skill as { id?: unknown }).id === "string" &&
        (skill as { id: string }).id.trim().length > 0,
    )
    .map((skill) => ({
      name: skill.id,
      description: skill.description,
    }))
    .filter((skill) => {
      if (seen.has(skill.name)) {
        return false;
      }
      seen.add(skill.name);
      return true;
    });
}
