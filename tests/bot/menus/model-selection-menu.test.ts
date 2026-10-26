import { describe, expect, it } from "vitest";

import {
  buildModelFavoriteCallback,
  buildModelSelectionMenu,
  buildProviderModelsMenuView,
  parseModelFavoriteCallback,
} from "../../../src/bot/menus/model-selection-menu.js";
import type {
  FavoriteModel,
  ModelSelectionLists,
  ProviderInfo,
} from "../../../src/app/types/model.js";

function getCallbackData(button: unknown): string | undefined {
  if (typeof button === "object" && button !== null && "callback_data" in button) {
    const value = (button as { callback_data: unknown }).callback_data;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function configModel(): FavoriteModel {
  return {
    providerID: process.env.OPENCODE_MODEL_PROVIDER ?? "test-provider",
    modelID: process.env.OPENCODE_MODEL_ID ?? "test-model",
  };
}

describe("model-selection-menu favorite toggles", () => {
  it("builds and parses favorite callbacks", () => {
    expect(buildModelFavoriteCallback("page", 3)).toBe("model:fav:page:3");
    expect(buildModelFavoriteCallback("favorites", 0)).toBe("model:fav:favorites:0");
    expect(parseModelFavoriteCallback("model:fav:page:3")).toEqual({ kind: "page", index: 3 });
    expect(parseModelFavoriteCallback("model:fav:result:0")).toEqual({
      kind: "result",
      index: 0,
    });
    expect(parseModelFavoriteCallback("model:fav:unknown:0")).toBeNull();
    expect(parseModelFavoriteCallback("model:fav:page:x")).toBeNull();
    expect(parseModelFavoriteCallback("model:fav:page")).toBeNull();
    expect(parseModelFavoriteCallback("model:pick:0")).toBeNull();
  });

  it("adds star toggles to provider models, except the config model", () => {
    const provider: ProviderInfo = { id: "prov", name: "Prov", modelCount: 3 };
    const cfg = configModel();
    const models: FavoriteModel[] = [
      { providerID: "prov", modelID: "model-a" },
      { providerID: "prov", modelID: "model-b" },
      cfg,
    ];
    const view = buildProviderModelsMenuView(
      provider,
      0,
      models,
      0,
      0,
      undefined,
      new Set(["prov/model-a"]),
      `${cfg.providerID}/${cfg.modelID}`,
    );
    const rows = view.keyboard.inline_keyboard;

    expect(rows[0]?.map((b) => b.text)).toEqual(["model-a", "⭐"]);
    expect(getCallbackData(rows[0]?.[1])).toBe("model:fav:page:0");
    expect(rows[1]?.map((b) => b.text)).toEqual(["model-b", "☆"]);
    expect(getCallbackData(rows[1]?.[1])).toBe("model:fav:page:1");
    expect(rows[2]?.map((b) => b.text)).toEqual([cfg.modelID]);
    expect(getCallbackData(rows[2]?.[0])).toBe("model:pick:2");
    expect(view.pageModels).toEqual(models);
  });

  it("adds star toggles to root favorites and recent, except the config model", async () => {
    const cfg = configModel();
    const lists: ModelSelectionLists = {
      favorites: [{ providerID: "prov", modelID: "model-a" }, cfg],
      recent: [{ providerID: "prov", modelID: "model-c" }],
    };
    const keyboard = await buildModelSelectionMenu(undefined, lists);
    const rows = keyboard.inline_keyboard;

    expect(rows[0]).toHaveLength(2); // search + providers
    expect(rows[1]?.map((b) => b.text)).toEqual(["⭐ prov/model-a", "⭐"]);
    expect(getCallbackData(rows[1]?.[1])).toBe("model:fav:favorites:0");
    expect(rows[2]?.map((b) => b.text)).toEqual([`⭐ ${cfg.providerID}/${cfg.modelID}`]);
    expect(rows[3]?.map((b) => b.text)).toEqual(["🕘 prov/model-c", "☆"]);
    expect(getCallbackData(rows[3]?.[1])).toBe("model:fav:recent:0");
  });
});
