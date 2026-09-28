import { createRoot } from 'react-dom/client'
import MailApp from './MailApp'
import '../renderer/src/assets/main.css'

createRoot(document.getElementById('root')!).render(<MailApp />)
