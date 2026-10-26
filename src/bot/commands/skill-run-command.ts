import type { Context } from "grammy";
import { config } from "../../config.js";
import { loadSkillsCatalog } from "../../app/services/skills-catalog-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { buildSkillsListKeyboard, formatSkillsSelectText } from "../menus/skills-catalog-menu.js";
import { executeSkill } from "../callbacks/skills-catalog-callback-handler.js";
import type { ProcessPromptDeps } from "../handlers/prompt.js";

export type SkillCommandDeps = ProcessPromptDeps;

function normalize(text: string): string {
  return String(text || "").trim().toLowerCase();
}

function getCommandArgs(ctx: Context & { match?: unknown }): string {
  if (typeof ctx.match === "string" && ctx.match.trim()) {
    return ctx.match.trim().replace(/^[:\s]+/, "");
  }
  const text = ctx.message && typeof ctx.message.text === "string" ? ctx.message.text : "";
  return text.replace(/^\/skill(@[A-Za-z0-9_]+)?[:\s]+/, "").trim();
}

// /skill <name> [args]: run a skill directly by name without browsing the
// catalog. An exact name match executes immediately; a single substring
// match on name/description executes it; multiple matches show the short
// filtered list. The colon form (/skill:name) is routed here by the message
// router's hears handler, since it is not a registered command.
export async function skillCommand(
  ctx: Context & { match?: unknown },
  deps: SkillCommandDeps,
): Promise<void> {
  try {
    const raw = getCommandArgs(ctx);
    if (!raw) {
      await ctx.reply("Pakai: /skill nama [argumen]\nContoh: /skill supabase");
      return;
    }
    const parts = raw.split(/\s+/);
    const query = parts[0] ?? "";
    const args = parts.slice(1).join(" ");
    const currentProject = getCurrentProject();
    if (!currentProject) {
      await ctx.reply(t("bot.project_not_selected"));
      return;
    }
    let skills;
    try {
      skills = await loadSkillsCatalog(currentProject.worktree);
    } catch (loadError) {
      logger.error("[Skill] Error loading skills list:", loadError);
      await ctx.reply(t("skills.fetch_error"));
      return;
    }
    if (skills.length === 0) {
      await ctx.reply(t("skills.empty"));
      return;
    }
    const runSkill = async (skillName: string): Promise<void> => {
      try {
        await executeSkill(ctx, deps, {
          projectDirectory: currentProject.worktree,
          skillName,
          argumentsText: args,
        });
      } catch (runError) {
        logger.error("[Skill] Error executing skill:", runError);
        await ctx.reply(`🔴 Gagal menjalankan skill ${skillName}.`);
      }
    };
    const q = normalize(query);
    const exact = skills.find((s) => normalize(s.name) === q);
    if (exact) {
      await runSkill(exact.name);
      return;
    }
    const matches = skills.filter(
      (s) => normalize(s.name).includes(q) || (s.description && normalize(s.description).includes(q)),
    );
    if (matches.length === 0) {
      await ctx.reply(
        `Tidak ada skill yang cocok dengan "${query}". Coba kata kunci lebih pendek, atau /skills untuk melihat semua.`,
      );
      return;
    }
    if (matches.length === 1) {
      const only = matches[0];
      if (only) {
        await runSkill(only.name);
      }
      return;
    }
    const pageSize = config.bot.commandsListLimit;
    const keyboard = buildSkillsListKeyboard(matches, 0, pageSize);
    const message = await ctx.reply(formatSkillsSelectText(0), { reply_markup: keyboard });
    deps.interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "skills",
        stage: "list",
        messageId: message.message_id,
        projectDirectory: currentProject.worktree,
        skills: matches,
        page: 0,
      },
    });
  } catch (error) {
    logger.error("[Skill] Error running skill by name:", error);
    await ctx.reply(t("skills.fetch_error"));
  }
}
