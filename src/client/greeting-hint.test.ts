import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The client sources use JSX but this test runs without a bundler, so the
// classic runtime needs a React global before App.tsx is evaluated.
;(globalThis as Record<string, unknown>).React = React

async function renderHome() {
  const { App } = await import('./App')
  return renderToStaticMarkup(React.createElement(App))
}

test('the name field shows visible guidance connected with aria-describedby', async () => {
  const html = await renderHome()
  assert.match(html, /id="name-hint"[^>]*>Use 1–40 characters\.</)
  assert.match(html, /<input[^>]*id="name"[^>]*aria-describedby="name-hint"/)
})

test('the name field keeps its 40-character limit and required state', async () => {
  const html = await renderHome()
  assert.match(html, /<input[^>]*id="name"[^>]*maxlength="40"/i)
  assert.match(html, /<input[^>]*id="name"[^>]*required/)
})
