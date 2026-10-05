import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, homePathFor, useAuth, type RoleName } from './lib/auth';
import { ToastProvider } from './components/ui';
import { PlannerShell } from './components/Shell';

/** Every page is its own chunk: a phone loads only the portal, a planner only the planning screens. */
const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })));
const SsoCallback = lazy(() => import('./pages/Login').then((m) => ({ default: m.SsoCallback })));
const AcceptInvitation = lazy(() =>
  import('./pages/AccountPages').then((m) => ({ default: m.AcceptInvitation })),
);
const ForgotPassword = lazy(() =>
  import('./pages/AccountPages').then((m) => ({ default: m.ForgotPassword })),
);
const Planning = lazy(() => import('./pages/planning/Planning').then((m) => ({ default: m.Planning })));
const Kiosk = lazy(() => import('./pages/Kiosk').then((m) => ({ default: m.Kiosk })));
const Live = lazy(() => import('./pages/Live').then((m) => ({ default: m.Live })));
const Requests = lazy(() => import('./pages/Requests').then((m) => ({ default: m.Requests })));
const OpenShifts = lazy(() => import('./pages/OpenShifts').then((m) => ({ default: m.OpenShifts })));
const Announcements = lazy(() => import('./pages/Announcements').then((m) => ({ default: m.Announcements })));
const PortalTeam = lazy(() => import('./pages/PortalTeam').then((m) => ({ default: m.PortalTeam })));
const MonthOverview = lazy(() => import('./pages/MonthOverview').then((m) => ({ default: m.MonthOverview })));
const Compliance = lazy(() => import('./pages/Compliance').then((m) => ({ default: m.Compliance })));
const Analytics = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.Analytics })));
const VacationRoutes = lazy(() => import('./pages/Vacation').then((m) => ({ default: m.VacationRoutes })));
const PortalAccount = lazy(() => import('./pages/Portal').then((m) => ({ default: m.PortalAccount })));
const PortalAttendance = lazy(() => import('./pages/Portal').then((m) => ({ default: m.PortalAttendance })));
const PortalHome = lazy(() => import('./pages/Portal').then((m) => ({ default: m.PortalHome })));
const PortalSchedule = lazy(() => import('./pages/Portal').then((m) => ({ default: m.PortalSchedule })));
const PortalShell = lazy(() => import('./pages/Portal').then((m) => ({ default: m.PortalShell })));
const PortalVacation = lazy(() => import('./pages/Portal').then((m) => ({ default: m.PortalVacation })));
const AdminAudit = lazy(() => import('./pages/AdminMore').then((m) => ({ default: m.AdminAudit })));
const AdminRules = lazy(() => import('./pages/AdminMore').then((m) => ({ default: m.AdminRules })));
const AdminTablets = lazy(() => import('./pages/AdminMore').then((m) => ({ default: m.AdminTablets })));
const AdminIntegrations = lazy(() =>
  import('./pages/AdminPlatform').then((m) => ({ default: m.AdminIntegrations })),
);
const Staffing = lazy(() => import('./pages/Staffing').then((m) => ({ default: m.Staffing })));
const Staff = lazy(() => import('./pages/Staff').then((m) => ({ default: m.Staff })));
const StaffNew = lazy(() => import('./pages/StaffNew').then((m) => ({ default: m.StaffNew })));
const StaffImport = lazy(() => import('./pages/StaffImport').then((m) => ({ default: m.StaffImport })));
const AdminCompanies = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminCompanies })));
const AdminHotels = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminHotels })));
const AdminIndex = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminIndex })));
const AdminLayout = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminLayout })));
const AdminOverview = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminOverview })));
const AdminUsers = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminUsers })));

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
      <ToastProvider>
        <Suspense fallback={<div role="status" aria-busy="true" style={{ padding: 'var(--space-4)' }} />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/login/sso" element={<SsoCallback />} />
            <Route path="/accept-invitation" element={<AcceptInvitation />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/kiosk" element={<Kiosk />} />
            <Route element={<Guard roles={['superAdmin', 'admin', 'manager']} />}>
              <Route element={<PlannerShell />}>
                <Route path="/planning" element={<Planning />} />
                <Route path="/month" element={<MonthOverview />} />
                <Route path="/vacation/*" element={<VacationRoutes />} />
                <Route path="/live" element={<Live />} />
                <Route path="/open-shifts" element={<OpenShifts />} />
                <Route path="/staffing" element={<Staffing />} />
                <Route path="/announcements" element={<Announcements />} />
                <Route path="/compliance" element={<Compliance />} />
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/requests" element={<Requests />} />
                <Route path="/staff" element={<Staff />} />
                <Route path="/staff/new" element={<StaffNew />} />
                <Route path="/staff/import" element={<StaffImport />} />
                <Route path="/staff/:id" element={<Staff />} />
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<AdminIndex />} />
                  <Route path="overview" element={<AdminOverview />} />
                  <Route path="hotels" element={<AdminHotels />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="tablets" element={<AdminTablets />} />
                  <Route path="integrations" element={<AdminIntegrations />} />
                  <Route path="rules" element={<AdminRules />} />
                  <Route path="audit" element={<AdminAudit />} />
                  <Route path="companies" element={<AdminCompanies />} />
                  <Route path="*" element={<Placeholder title="Einrichtung" />} />
                </Route>
              </Route>
            </Route>
            <Route element={<Guard roles={['employee']} />}>
              <Route path="/me" element={<PortalShell />}>
                <Route index element={<PortalHome />} />
                <Route path="schedule" element={<PortalSchedule />} />
                <Route path="attendance" element={<PortalAttendance />} />
                <Route path="vacation" element={<PortalVacation />} />
                <Route path="team" element={<PortalTeam />} />
                <Route path="account" element={<PortalAccount />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </ToastProvider>
    </AuthProvider>
  );
}
