/** Reject mistyped filters instead of reporting an empty suite as successful. */
export function selectEvaluationScenarios<T extends { id: string }>(catalog: readonly T[], ids?: readonly string[]): T[] {
  if (catalog.length === 0) throw new Error('The evaluation scenario catalog is empty.')
  if (new Set(catalog.map((scenario) => scenario.id)).size !== catalog.length) throw new Error('The evaluation scenario catalog contains duplicate IDs.')
  if (ids === undefined) return [...catalog]
  if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('Specify at least one non-empty evaluation scenario ID.')
  const requested = ids.map((id) => id.trim())
  if (new Set(requested).size !== requested.length) throw new Error('Duplicate evaluation scenario IDs are not allowed.')
  const available = new Set(catalog.map((scenario) => scenario.id))
  const unknown = requested.filter((id) => !available.has(id))
  if (unknown.length) throw new Error(`Unknown evaluation scenario IDs: ${unknown.join(', ')}. Available IDs: ${[...available].join(', ')}.`)
  const selection = new Set(requested)
  return catalog.filter((scenario) => selection.has(scenario.id))
}

export function validateEvaluationRuns(repeat: number, variants: number): void {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('repeat must be an integer from 1 to 20.')
  if (!Number.isInteger(variants) || variants < 1 || variants > 3) throw new Error('variants must be an integer from 1 to 3.')
}
