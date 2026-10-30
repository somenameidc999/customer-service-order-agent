export interface HealthResponse {
  status: 'ok'
  service: 'hono'
  timestamp: string
}

export interface HelloResponse {
  message: string
  source: 'Hono API'
}

export interface ErrorResponse {
  error: string
}
