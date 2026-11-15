// Routes (React Router, browser history; the web server falls back to index.html for every path).
import { type ReactNode, Suspense, lazy } from 'react';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router';

import { Shell } from './Shell';
import { RouteError } from './components/ErrorBoundary';
import { Toasts } from './components/Feedback';
import { ChangePasswordPage, LoginPage } from './features/auth/AuthScreen';
import { SECTIONS, type SectionKey, legacyRedirect } from './lib/routes';
import { SessionProvider } from './state/session';

const Overview = lazy(() => import('./features/overview/Overview'));
const Sheet = lazy(() => import('./features/sheets/Sheet'));
const Forward = lazy(() => import('./features/forward/Forward'));
const Batches = lazy(() => import('./features/health/Batches'));
const Exports = lazy(() => import('./features/health/Exports'));
const Access = lazy(() => import('./features/telegram/Access'));
const Users = lazy(() => import('./features/users/Users'));
const Account = lazy(() => import('./features/account/Account'));
const CoinPage = lazy(() => import('./features/coin/CoinPage'));

/** Root: the session, plus redirects from the old hash URLs (#queue, ?coin=123). */
function Root() {
  const loc = useLocation();
  const legacy = legacyRedirect(loc);
  if (legacy && legacy !== loc.pathname + loc.search) return <Navigate to={legacy} replace />;
  return (
    <SessionProvider>
      <Outlet />
      <Toasts />
    </SessionProvider>
  );
}

const page = (node: ReactNode) => (
  <Suspense
    fallback={
      <div className="skeleton">
        <i />
        <i />
        <i />
      </div>
    }
  >
    {node}
  </Suspense>
);

const ELEMENTS: Record<SectionKey, ReactNode> = {
  overview: <Overview />,
  queue: <Sheet sheet="queue" key="queue" />,
  eligible: <Sheet sheet="eligible" key="eligible" />,
  needs_review: <Sheet sheet="needs_review" key="needs_review" />,
  excluded: <Sheet sheet="excluded" key="excluded" />,
  forward: <Forward />,
  batches: <Batches />,
  exports: <Exports />,
  access: <Access />,
  users: <Users />,
  account: <Account />,
};

const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'change-password', element: <ChangePasswordPage /> },
      {
        element: <Shell />,
        errorElement: <RouteError />,
        children: [
          ...SECTIONS.map((s) => ({
            ...(s.path === '/' ? { index: true } : { path: s.path.slice(1) }),
            element: page(ELEMENTS[s.key]),
            errorElement: <RouteError />,
            handle: { section: s.key, permission: s.permission },
          })),
          { path: 'coins/:cmcId', element: page(<CoinPage />), errorElement: <RouteError /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

function NotFound() {
  return (
    <div className="panel">
      <h2>Page not found</h2>
      <p className="muted small">This address does not match any page of the dashboard.</p>
    </div>
  );
}

export default function App() {
  return <RouterProvider router={router} />;
}
