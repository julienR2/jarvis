import type { FastifyInstance } from 'fastify'
import { defaultModel } from '../models.js'
import {
  ANTHROPIC_MODELS,
  gatewayConfig,
  gatewayModels,
  readSecretsSafe,
} from '../catalogue.js'
import type { ModelOption } from '../catalogue.js'

export async function modelRoutes(app: FastifyInstance) {
  app.get('/api/models', { onRequest: [app.authenticate] }, async () => {
    const secrets = readSecretsSafe()
    const hasAnthropic = !!(secrets.claudeOauthToken || process.env.CLAUDE_CODE_OAUTH_TOKEN)
    const cfg = gatewayConfig()

    // Both catalogues when both are configured. They are distinguishable by id
    // shape — Anthropic's are bare, a gateway's are namespaced — which is the
    // same rule the engine uses to decide where to send a turn, so what the
    // picker offers and what actually runs can't disagree.
    const anthropic = hasAnthropic ? ANTHROPIC_MODELS : []
    let gateway: ModelOption[] = []
    let error: string | undefined

    if (cfg) {
      try {
        gateway = await gatewayModels(cfg)
      } catch (err: any) {
        error = `Couldn't list models from the gateway: ${err?.message ?? err}`
      }
    }

    return {
      // Kept for callers that just want to know what is available at all.
      provider: gateway.length && anthropic.length
        ? 'both'
        : gateway.length
          ? 'gateway'
          : 'anthropic',
      anthropic,
      gateway,
      gatewayBaseUrl: cfg?.baseUrl ?? '',
      // Flat list of everything selectable, for lookups by id.
      models: [...anthropic, ...gateway],
      // Follows the configured providers, so a gateway-only instance
      // defaults to the gateway's route rather than a bare id it can't reach.
      default: defaultModel(),
      allowCustom: !!cfg,
      error,
    }
  })
}
