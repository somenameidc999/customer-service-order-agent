import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'pixel-retroui/dist/index.css'
import 'pixel-retroui/dist/fonts.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
