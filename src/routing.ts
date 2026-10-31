import { lookupModelTier, type Config, type ModelTierEntry, type SessionSpec } from './config.js';
import { progressTrend, type ProgressTrend } from './progress.js';
import type { TaskState } from './state.js';

/**
 * Signal-driven model routing. The registry (`modelTiers`) states which models are more capable; this
 * module decides when to move a task up one step. The trigger is observable progress, never a timer: a
 * task that kept changing the worktree/metric across attempts but has not finished gets a stronger
 * model for the next attempt. A flat or regressing trend is left to the stall/recovery path.
 */

export interface TierRoute {
  spec: SessionSpec;
  entry: ModelTierEntry;
  from: ModelTierEntry;
  trend: ProgressTrend;
  reason: string;
}

/** The next capability step above `spec`: the lowest higher tier, then registry order. */
export function nextTierEntry(config: Config, spec: SessionSpec): ModelTierEntry | undefined {
  const current = lookupModelTier(config, spec.providerName, spec.model);
  if (!current) return undefined;
  const candidates = config.modelTiers
    .filter((e) => e.tier > current.tier)
    .sort((a, b) => (a.tier - b.tier) || (a.order - b.order));
  return candidates[0];
}

/** Build a task SessionSpec for a registry entry, preserving the run's bounds and permissions. */
export function tierSpec(config: Config, spec: SessionSpec, entry: ModelTierEntry): SessionSpec {
  const provider = config.providers[entry.provider];
  return {
    ...spec,
    providerName: entry.provider,
    bin: provider.bin,
    model: entry.id,
    variant: entry.provider === spec.providerName ? spec.variant : provider.variant,
    extraArgs: [...provider.extraArgs],
    readOnly: false,
    sources: {
      provider: 'tier routing',
      model: 'tier routing',
      modelProvider: 'tier routing',
      variant: 'tier routing',
    },
  };
}

function explicitModelChoice(spec: SessionSpec): boolean {
  const source = spec.sources.model;
  return source === '--model' || source === 'env SYMPHONY_MODEL' || source === 'task front matter';
}

/**
 * Decide whether this attempt should run on a stronger registry model. Returns undefined when routing
 * is off, the model is untiered, a cap is spent, the task pinned its own model, or there is not enough
 * observable progress to justify a step up.
 */
export function routeTier(config: Config, spec: SessionSpec, st: TaskState): TierRoute | undefined {
  const routing = config.tierRouting;
  if (!routing.enabled) return undefined;
  if ((st.tierPromotions ?? 0) >= routing.maxPromotions) return undefined;
  if (routing.respectTaskOverride && explicitModelChoice(spec)) return undefined;
  const deltas = st.deltas ?? [];
  if (deltas.length < routing.promoteAfterProgress) return undefined;
  const trend = progressTrend(deltas, config.metric.direction);
  if (trend !== 'improving') return undefined;
  const from = lookupModelTier(config, spec.providerName, spec.model);
  const entry = nextTierEntry(config, spec);
  if (!from || !entry) return undefined;
  return {
    spec: tierSpec(config, spec, entry),
    entry,
    from,
    trend,
    reason: `${deltas.length} observable-progress attempts at tier ${from.tier} without finishing`,
  };
}
