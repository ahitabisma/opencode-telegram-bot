import { opencodeClient } from "../../opencode/client.js";
import { config } from "../../config.js";
import { getCurrentAgent, getCurrentProject, setCurrentAgent } from "../stores/settings-store.js";
import { getCurrentSession } from "./session-service.js";
import { getStoredModel, resolveModelToAdopt, selectModel } from "./model-selection-service.js";
import { setCurrentVariant } from "./variant-selection-service.js";
import { logger } from "../../utils/logger.js";
import type { AgentInfo } from "../types/agent.js";

/**
 * Get list of available agents from OpenCode API
 * @returns Array of available agents (filtered by mode and hidden flag)
 */
// Muse patch (2026-10-26, ported from the VPS dist patch): the bundled SDK's
// agent query hits /agent, which this OpenCode V2 server does not serve (SPA
// fallback), so it always comes back empty and the agent menu shows no
// options. Ask the server's agent endpoint directly with the project
// directory header — the form it answers with data. Same approach as the
// 2026-10-24 skills catalog patch.
export async function getAvailableAgents(): Promise<AgentInfo[]> {
  try {
    const project = getCurrentProject();
    const directory = project ? project.worktree : undefined;
    const baseUrl = config.opencode.apiUrl.endsWith("/")
      ? config.opencode.apiUrl
      : `${config.opencode.apiUrl}/`;
    const headers: Record<string, string> = {};
    if (directory) {
      headers["x-opencode-directory"] = directory;
    }
    if (config.opencode.password) {
      const credentials = `${config.opencode.username}:${config.opencode.password}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }
    let response = await fetch(new URL("api/agent", baseUrl), { headers });
    if (!response.ok) {
      logger.error("[AgentManager] Failed to fetch agents:", response.status);
      return [];
    }
    let payload: unknown = await response.json();
    let items = Array.isArray(payload) ? payload : ((payload as { data?: unknown[] } | null)?.data ?? []);
    if (items.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      response = await fetch(new URL("api/agent", baseUrl), { headers });
      if (!response.ok) {
        logger.error("[AgentManager] Failed to fetch agents:", response.status);
        return [];
      }
      payload = await response.json();
      items = Array.isArray(payload) ? payload : ((payload as { data?: unknown[] } | null)?.data ?? []);
    }
    // The server returns id (e.g. 'plan', the identifier OpenCode accepts)
    // and a display name (e.g. 'Plan'). The bot stores `name` and sends it
    // to OpenCode, so `name` must carry the id.
    const agents: AgentInfo[] = (items as Record<string, unknown>[])
      .filter((item) => item && typeof (item.id ?? item.name) === "string" && String(item.id ?? item.name).length > 0)
      .map((item) => {
        const agent: AgentInfo = {
          name: String(item.id ?? item.name),
          mode: (item.mode as AgentInfo["mode"]) ?? "primary",
        };
        if (typeof item.description === "string") {
          agent.description = item.description;
        }
        if (typeof item.hidden === "boolean") {
          agent.hidden = item.hidden;
        }
        if (item.model && typeof item.model === "object") {
          const model = item.model as { modelID: unknown; providerID: unknown };
          if (typeof model.modelID === "string" && typeof model.providerID === "string") {
            agent.model = { modelID: model.modelID, providerID: model.providerID };
          }
        }
        if (typeof item.variant === "string") {
          agent.variant = item.variant;
        }
        return agent;
      });
    // Filter out hidden agents and subagents (only show primary and all)
    const filtered = agents.filter(
      (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
    );
    logger.debug(`[AgentManager] Fetched ${filtered.length} available agents`);
    return filtered;
  } catch (err) {
    logger.error("[AgentManager] Error fetching agents:", err);
    return [];
  }
}

const DEFAULT_AGENT = "build";

function pickFallbackAgent(agents: AgentInfo[]): string {
  const defaultAgent = agents.find((agent) => agent.name === DEFAULT_AGENT);
  if (defaultAgent) {
    return defaultAgent.name;
  }

  return agents[0]?.name ?? DEFAULT_AGENT;
}

export async function resolveProjectAgent(preferredAgent?: string): Promise<string> {
  const rawRequested = preferredAgent ?? getCurrentAgent() ?? DEFAULT_AGENT;
  // Heal selections stored before the id mapping (display names 'Plan'
  // and 'Build' instead of ids 'plan' and 'build').
  const requestedAgent =
    rawRequested === "Plan" ? "plan" : rawRequested === "Build" ? "build" : rawRequested;
  const project = getCurrentProject();

  if (!project) {
    return requestedAgent;
  }

  const agents = await getAvailableAgents();
  if (agents.length === 0) {
    return requestedAgent;
  }

  if (agents.some((agent) => agent.name === requestedAgent)) {
    return requestedAgent;
  }

  const fallbackAgent = pickFallbackAgent(agents);
  logger.warn(
    `[AgentManager] Agent "${requestedAgent}" is not available for project ${project.worktree}. Falling back to "${fallbackAgent}".`,
  );
  setCurrentAgent(fallbackAgent);
  return fallbackAgent;
}

/**
 * Get current agent from last session message or settings.
 * Falls back to "build" if nothing is stored.
 * @returns Current agent name
 */
export async function fetchCurrentAgent(): Promise<string> {
  const storedAgent = getCurrentAgent();
  const session = getCurrentSession();
  const project = getCurrentProject();

  if (!project) {
    // No active project, return stored agent from settings
    return storedAgent ?? DEFAULT_AGENT;
  }

  if (!session) {
    return resolveProjectAgent(storedAgent ?? DEFAULT_AGENT);
  }

  try {
    const { data: messages, error } = await opencodeClient.session.messages({
      sessionID: session.id,
      directory: project.worktree,
      limit: 1,
    });

    if (error || !messages || messages.length === 0) {
      logger.debug("[AgentManager] No messages found, using stored agent");
      return resolveProjectAgent(storedAgent ?? DEFAULT_AGENT);
    }

    const lastMessage = messages[0];
    if (!lastMessage) {
      logger.debug("[AgentManager] No messages found, using stored agent");
      return resolveProjectAgent(storedAgent ?? DEFAULT_AGENT);
    }
    const lastAgent = lastMessage.info.agent;
    logger.debug(`[AgentManager] Current agent from session: ${lastAgent}`);

    // If user explicitly selected an agent in bot settings, prefer it.
    // Session messages may contain stale agent until next prompt is sent.
    if (storedAgent && lastAgent !== storedAgent) {
      logger.debug(
        `[AgentManager] Using stored agent "${storedAgent}" instead of session agent "${lastAgent}"`,
      );
      return resolveProjectAgent(storedAgent);
    }

    // No stored agent yet: sync from session history
    if (lastAgent && lastAgent !== storedAgent) {
      setCurrentAgent(lastAgent);
    }

    return resolveProjectAgent(lastAgent || storedAgent || DEFAULT_AGENT);
  } catch (err) {
    logger.error("[AgentManager] Error fetching current agent:", err);
    return resolveProjectAgent(storedAgent ?? DEFAULT_AGENT);
  }
}

/**
 * Select agent and persist to settings
 * @param agentName Name of the agent to select
 */
export function selectAgent(agentName: string): void {
  logger.info(`[AgentManager] Selected agent: ${agentName}`);
  setCurrentAgent(agentName);
}

function configuredField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Apply the listed agent's configured model and/or variant to current settings.
 * Independent fields: a missing or empty one is left as it is. Used only by the
 * agent picker — selectAgent itself stays a name write. A configured model OpenCode no
 * longer offers is replaced by the config model, or not applied at all.
 * @returns true when a model or variant was written (so the pinned dashboard can follow)
 */
export async function applyAgentConfiguredSettings(agentName: string): Promise<boolean> {
  try {
    const agents = await getAvailableAgents();
    const agent = agents.find((entry) => entry.name === agentName);
    if (!agent) {
      logger.warn(
        `[AgentManager] Could not read configured model/variant for agent "${agentName}"; leaving them unchanged`,
      );
      return false;
    }

    const providerID = configuredField(agent.model?.providerID);
    const modelID = configuredField(agent.model?.modelID);
    const variant = configuredField(agent.variant);
    const hasModel = Boolean(providerID && modelID);

    if (hasModel && providerID && modelID) {
      const adoptedModel = await resolveModelToAdopt({ providerID, modelID });
      if (!adoptedModel) {
        return false;
      }

      // The configured variant belongs to the configured model, not to the config model.
      const isAgentModel =
        adoptedModel.providerID === providerID && adoptedModel.modelID === modelID;
      const storedVariant = isAgentModel
        ? (variant ?? getStoredModel().variant ?? "default")
        : "default";
      selectModel({
        providerID: adoptedModel.providerID,
        modelID: adoptedModel.modelID,
        variant: storedVariant,
      });
      logger.info(
        `[AgentManager] Applied agent "${agentName}" model ${adoptedModel.providerID}/${adoptedModel.modelID} (${storedVariant})`,
      );
      return true;
    }

    if (variant) {
      setCurrentVariant(variant);
      logger.info(`[AgentManager] Applied agent "${agentName}" variant ${variant}`);
      return true;
    }

    return false;
  } catch (err) {
    logger.warn(
      `[AgentManager] Failed to apply configured model/variant for agent "${agentName}"; leaving them unchanged`,
      err,
    );
    return false;
  }
}

/**
 * Get stored agent from settings (synchronous)
 * @returns Current agent name or default "build"
 */
export function getStoredAgent(): string {
  return getCurrentAgent() ?? "build";
}
