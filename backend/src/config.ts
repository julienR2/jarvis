export const config = {
  port: parseInt(process.env.PORT || '3005'),
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  internalSecret: process.env.INTERNAL_SECRET || 'internal',
  dbPath: process.env.DB_PATH || '/jarvis/data/jarvis.db',
  workspaceDir: process.env.WORKSPACE_DIR || '/jarvis/workspace',
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent',
  whisperUrl: process.env.WHISPER_URL || 'http://whisper:9000',
  // URL that external containers (session-manager / claude) use to reach us.
  // Baked into prompts and skills so claude's curl calls resolve.
  internalUrl: process.env.BACKEND_URL || 'http://backend:3005',
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  tz: process.env.TZ || 'Europe/Lisbon',
} as const
