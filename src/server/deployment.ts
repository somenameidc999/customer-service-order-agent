export interface DeploymentConfig {
  publicOrigin?: string
  credentials?: { username: string; password: string }
}

/** Validate deployment settings before accepting any requests. */
export function loadDeploymentConfig(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const required = env.DEMO_AUTH_REQUIRED
  if (required !== undefined && required !== 'true' && required !== 'false') {
    throw new Error('DEMO_AUTH_REQUIRED must be true or false.')
  }
  const password = env.DEMO_PASSWORD
  if (required === 'true' && !password?.trim()) {
    throw new Error('Set DEMO_PASSWORD before starting the shared demo.')
  }
  const username = env.DEMO_USERNAME ?? 'demo'
  if (!username.trim() || /[:\r\n]/.test(username)) {
    throw new Error('DEMO_USERNAME must be nonempty and contain no colon or newline.')
  }

  let publicOrigin: string | undefined
  if (env.PUBLIC_ORIGIN) {
    const value = env.PUBLIC_ORIGIN
    let url: URL
    try { url = new URL(value) } catch { throw new Error('PUBLIC_ORIGIN must be an HTTPS origin, such as https://your-app.fly.dev.') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin, such as https://your-app.fly.dev.')
    }
    publicOrigin = url.origin
  }
  if (required === 'true' && !publicOrigin) {
    throw new Error('Set PUBLIC_ORIGIN to the shared demo HTTPS origin.')
  }
  return { publicOrigin, credentials: password?.trim() ? { username, password } : undefined }
}
