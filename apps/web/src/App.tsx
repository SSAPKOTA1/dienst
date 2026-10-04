import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, homePathFor, useAuth, type RoleName } from './lib/auth';
import { ToastProvider } from './components/ui';
import { PlannerShell } from './components/Shell';
import { Login } from './pages/Login';
import { AcceptInvitation, ForgotPassword } from './pages/AccountPages';
import { Planning } from './pages/planning/Planning';
import { Kiosk } from './pages/Kiosk';
import { Live } from './pages/Live';
import { Requests } from './pages/Requests';
import { OpenShifts } from './pages/OpenShifts';
import { Announcements } from './pages/Announcements';
import { PortalTeam } from './pages/PortalTeam';
import { MonthOverview } from './pages/MonthOverview';
import { Compliance } from './pages/Compliance';
import { Analytics } from './pages/Analytics';
import { VacationRoutes } from './pages/Vacation';
import {
  PortalAccount,
  PortalAttendance,
  PortalHome,
  PortalSchedule,
  PortalShell,
  PortalVacation,
} from './pages/Portal';
import { AdminAudit, AdminRules, AdminTablets } from './pages/AdminMore';
import { Staff } from './pages/Staff';
import { StaffNew } from './pages/StaffNew';
import { StaffImport } from './pages/StaffImport';
import {
  AdminCompanies,
  AdminHotels,
  AdminIndex,
  AdminLayout,
  AdminOverview,
  AdminUsers,
} from './pages/Admin';

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
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
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
      </ToastProvider>
    </AuthProvider>
  );
}
