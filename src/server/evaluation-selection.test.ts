import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectEvaluationScenarios, validateEvaluationRuns } from './evaluation/selection.js'

const catalog = [{ id: '01', title: 'First' }, { id: '02', title: 'Second' }]

test('evaluation selection defaults to the complete catalog and preserves requested valid cases', () => {
  assert.deepEqual(selectEvaluationScenarios(catalog), catalog)
  assert.deepEqual(selectEvaluationScenarios(catalog, [' 02 ']), [catalog[1]])
  assert.deepEqual(selectEvaluationScenarios(catalog, ['02', '01']), catalog)
})

test('evaluation selection rejects unknown, empty, duplicate, and mixed invalid IDs', () => {
  for (const ids of [[], [''], ['   '], ['does-not-exist'], ['01', 'does-not-exist'], ['01', '01']]) {
    assert.throws(() => selectEvaluationScenarios(catalog, ids), /non-empty|Unknown|Duplicate/)
  }
  assert.throws(() => selectEvaluationScenarios([]), /catalog is empty/)
  assert.throws(() => selectEvaluationScenarios([{ id: '01' }, { id: '01' }]), /duplicate/)
})

test('evaluation repetition and variant limits reject malformed and out-of-range values', () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1.5, 21]) {
    assert.throws(() => validateEvaluationRuns(invalid, 1), /repeat/)
  }
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 4, 20]) {
    assert.throws(() => validateEvaluationRuns(1, invalid), /variants/)
  }
  assert.doesNotThrow(() => validateEvaluationRuns(1, 1))
  assert.doesNotThrow(() => validateEvaluationRuns(20, 3))
})
