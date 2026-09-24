import { useSearchParams } from 'react-router-dom'
import ContentLayout from '../components/ContentLayout'
import ConnectorsPanel from '../components/ConnectorsPage'
import SkillsPanel from '../components/SkillsPanel'
import { ProviderConnections } from '../components/ConnectionPage'

/**
 * Settings › Customize: what Jarvis thinks with and works with — the model
 * providers, the connectors it holds credentials for, the skills it knows.
 * The tab lives in the URL so a link can open the right one.
 */
type Tab = 'models' | 'connectors' | 'skills'

const TABS: { id: Tab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'skills', label: 'Skills' },
]

export default function CustomizePage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : 'models'
  const setTab = (t: Tab) =>
    setParams((p) => { if (t === 'models') p.delete('tab'); else p.set('tab', t); return p }, { replace: true })

  return (
    <ContentLayout title='Customize'>
      <div>
        <div
          className='flex gap-1 border-b border-border mb-5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
          role='tablist'
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role='tab'
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 whitespace-nowrap transition-colors ${
                tab === t.id ? 'border-text-primary text-text-primary font-medium' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'models' && <ProviderConnections />}
        {tab === 'connectors' && <ConnectorsPanel />}
        {tab === 'skills' && <SkillsPanel />}
      </div>
    </ContentLayout>
  )
}
