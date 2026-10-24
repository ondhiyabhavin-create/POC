import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { LayoutsPage } from './pages/LayoutsPage';
import { LoginPage } from './pages/LoginPage';
import { SubmissionPage } from './pages/SubmissionPage';
import { SubmissionsPage } from './pages/SubmissionsPage';
import { ValidatePage } from './pages/ValidatePage';
import { OrganizationsPage } from './pages/admin/OrganizationsPage';
import { DashboardPage } from './pages/admin/DashboardPage';
import { LookupsPage } from './pages/admin/LookupsPage';
import { RuleEditorPage } from './pages/admin/RuleEditorPage';
import { RulesPage } from './pages/admin/RulesPage';
import type { ReactNode } from 'react';

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />;
}

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <Loading text="Starting…" />;
  if (!user) return <LoginPage />;
  const home = user.role === 'admin' ? '/admin' : '/validate';
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to={home} replace />} />
        <Route path="validate" element={<ValidatePage />} />
        <Route path="submissions" element={<SubmissionsPage />} />
        <Route path="submissions/:id" element={<SubmissionPage />} />
        <Route path="layouts" element={<LayoutsPage />} />
        <Route path="admin" element={<AdminOnly><DashboardPage /></AdminOnly>} />
        <Route path="admin/rules" element={<AdminOnly><RulesPage /></AdminOnly>} />
        <Route path="admin/rules/:id" element={<AdminOnly><RuleEditorPage /></AdminOnly>} />
        <Route path="admin/lookups" element={<AdminOnly><LookupsPage /></AdminOnly>} />
        <Route path="admin/organizations" element={<AdminOnly><OrganizationsPage /></AdminOnly>} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Route>
    </Routes>
  );
}
