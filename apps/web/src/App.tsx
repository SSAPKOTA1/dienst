import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, homePathFor, useAuth, type RoleName } from './lib/auth';
import { PlannerShell } from './components/Shell';
import { Login } from './pages/Login';
import { AcceptInvitation, ForgotPassword } from './pages/AccountPages';

function Guard({ roles }: { roles: RoleName[] }) {
  const { ready, me } = useAuth();
  if (!ready) return null;
  if (!me) return <Navigate to="/login" replace />;
  if (!roles.includes(me.role)) return <Navigate to={homePathFor(me.role)} replace />;
  return <Outlet />;
}

function Home() {
  const { ready, me } = useAuth();
  if (!ready) return null;
  return <Navigate to={me ? homePathFor(me.role) : '/login'} replace />;
}

const Placeholder = ({ title }: { title: string }) => {
  const { t } = useTranslation();
  return (
    <main style={{ padding: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 30 }}>{t(title)}</h1>
    </main>
  );
};

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/accept-invitation" element={<AcceptInvitation />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route element={<Guard roles={['superAdmin', 'admin', 'manager']} />}>
          <Route element={<PlannerShell />}>
            <Route path="/planning" element={<Placeholder title="Dienstplan" />} />
            <Route path="/live" element={<Placeholder title="Live" />} />
            <Route path="/requests" element={<Placeholder title="Anträge" />} />
            <Route path="/staff/*" element={<Placeholder title="Mitarbeiter" />} />
            <Route path="/admin/*" element={<Placeholder title="Einrichtung" />} />
          </Route>
        </Route>
        <Route element={<Guard roles={['employee']} />}>
          <Route path="/me/*" element={<Placeholder title="Handy-Portal" />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
