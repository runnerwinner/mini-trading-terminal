import { Suspense, lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'

const NetworkPage = lazy(() => import('./pages/NetworkPage'))
const TokenPage = lazy(() => import('./pages/TokenPage'))

function App() {
  return (
    <>
      <Toaster position="top-center" />
      <Layout>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center text-muted-foreground">
              Loading...
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/networks/:networkId" element={<NetworkPage />} />
            <Route path="/networks/:networkId/tokens/:tokenId" element={<TokenPage />} />
          </Routes>
        </Suspense>
      </Layout>
    </>
  )
}

export default App