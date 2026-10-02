import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { NavplanTesterPage } from './NavplanTesterPage'

// Its own root, not App.jsx: this page is reached by URL only and must not appear in the
// dashboard's footer. It therefore owns its own /quadruped_main_status subscription, since
// there is no App-level provider handing one down.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <NavplanTesterPage />
  </StrictMode>,
)
