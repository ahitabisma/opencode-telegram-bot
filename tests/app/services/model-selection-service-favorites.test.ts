import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConfigDefaultModel,
  getFileFavoriteModels,
  toggleFavoriteModel,
} from "../../../src/app/services/model-selection-service.js";

function statePath(home: string): string {
  return path.join(home, ".local", "state", "opencode", "model.json");
}

function writeState(home: string, value: unknown): void {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf-8");
}

function readState(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statePath(home), "utf-8")) as Record<string, unknown>;
}

describe("model-selection-service favorites", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "model-state-"));
    vi.stubEnv("XDG_STATE_HOME", "");
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("creates the state file when toggling with no file present", async () => {
    await expect(toggleFavoriteModel("prov", "model-a")).resolves.toEqual({ favorited: true });
    expect(readState(home)).toEqual({
      favorite: [{ providerID: "prov", modelID: "model-a" }],
    });
  });

  it("adds and removes a favorite, preserving other keys", async () => {
    writeState(home, {
      recent: [{ providerID: "prov", modelID: "model-old" }],
      favorite: [],
      variant: { "prov/model-old": "default" },
    });

    await expect(toggleFavoriteModel("prov", "model-a")).resolves.toEqual({ favorited: true });
    expect(readState(home)).toEqual({
      recent: [{ providerID: "prov", modelID: "model-old" }],
      favorite: [{ providerID: "prov", modelID: "model-a" }],
      variant: { "prov/model-old": "default" },
    });

    await expect(toggleFavoriteModel("prov", "model-a")).resolves.toEqual({ favorited: false });
    expect(readState(home).favorite).toEqual([]);
    expect(readState(home).recent).toEqual([{ providerID: "prov", modelID: "model-old" }]);
    expect(readState(home).variant).toEqual({ "prov/model-old": "default" });
  });

  it("removes duplicate entries together", async () => {
    writeState(home, {
      favorite: [
        { providerID: "prov", modelID: "model-a" },
        { providerID: "prov", modelID: "model-a" },
        { providerID: "prov", modelID: "model-b" },
      ],
    });

    await expect(toggleFavoriteModel("prov", "model-a")).resolves.toEqual({ favorited: false });
    expect(readState(home).favorite).toEqual([{ providerID: "prov", modelID: "model-b" }]);
  });

  it("keeps invalid entries untouched", async () => {
    writeState(home, {
      favorite: [{ providerID: "prov" }, "junk", { providerID: "prov", modelID: "model-a" }],
    });

    await expect(toggleFavoriteModel("prov", "model-b")).resolves.toEqual({ favorited: true });
    expect(readState(home).favorite).toEqual([
      { providerID: "prov" },
      "junk",
      { providerID: "prov", modelID: "model-a" },
      { providerID: "prov", modelID: "model-b" },
    ]);

    await expect(toggleFavoriteModel("prov", "model-a")).resolves.toEqual({ favorited: false });
    expect(readState(home).favorite).toEqual([
      { providerID: "prov" },
      "junk",
      { providerID: "prov", modelID: "model-b" },
    ]);
  });

  it("refuses malformed JSON instead of overwriting it", async () => {
    writeState(home, "{not json");
    await expect(toggleFavoriteModel("prov", "model-a")).rejects.toThrow();
    expect(fs.readFileSync(statePath(home), "utf-8")).toBe("{not json");
  });

  it("rejects empty provider or model", async () => {
    await expect(toggleFavoriteModel("", "model-a")).rejects.toThrow();
    await expect(toggleFavoriteModel("prov", "  ")).rejects.toThrow();
    expect(fs.existsSync(statePath(home))).toBe(false);
  });

  it("serializes concurrent toggles without corrupting the file", async () => {
    writeState(home, { favorite: [] });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => toggleFavoriteModel("prov", "model-a")),
    );
    expect(results.filter((r) => r.favorited)).toHaveLength(5);
    expect(readState(home).favorite).toEqual([]);
  });

  it("getFileFavoriteModels normalizes and tolerates a missing file", async () => {
    await expect(getFileFavoriteModels()).resolves.toEqual([]);
    writeState(home, {
      favorite: [{ providerID: "prov", modelID: "model-a" }, { providerID: "prov" }],
    });
    await expect(getFileFavoriteModels()).resolves.toEqual([
      { providerID: "prov", modelID: "model-a" },
    ]);
  });

  it("getConfigDefaultModel returns the configured model", () => {
    const configModel = getConfigDefaultModel();
    expect(configModel).not.toBeNull();
    expect(configModel?.providerID.length).toBeGreaterThan(0);
    expect(configModel?.modelID.length).toBeGreaterThan(0);
  });
});
