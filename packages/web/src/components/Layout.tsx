import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { IS_DEMO } from '../api';
import { resetDemoData } from '../demo-backend';
import { useAuth } from '../auth';

export const APP_NAME = (import.meta.env.VITE_APP_NAME as string | undefined) ?? 'File Intake';

export function Layout() {
  const { user, config, signOut } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  return (
    <>
      {IS_DEMO ? (
        <div className="env-banner">
          Browser demo · synthetic test data only · everything you do is stored in this browser only ·{' '}
          <button
            className="link-btn"
            onClick={() => {
              if (confirm('Reset all demo data (rules, organizations, submissions) in this browser?')) {
                resetDemoData();
                location.reload();
              }
            }}
          >
            Reset demo data
          </button>
        </div>
      ) : (
        config?.mode === 'local' && <div className="env-banner">Local demo environment · synthetic test data only · no cloud services in use</div>
      )}
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <img src="/favicon.svg" width={28} height={28} alt="" />
            <span>
              {APP_NAME} <small>· Pre-submission validation</small>
            </span>
          </NavLink>
          <nav className="nav">
            <NavLink to="/validate">Validate a file</NavLink>
            <NavLink to="/submissions">{isAdmin ? 'All submissions' : 'My submissions'}</NavLink>
            <NavLink to="/layouts">File layouts</NavLink>
            {isAdmin && (
              <>
                <span className="sep" />
                <NavLink to="/admin" end>
                  Dashboard
                </NavLink>
                <NavLink to="/admin/rules">Validation rules</NavLink>
                <NavLink to="/admin/lookups">Lookup lists</NavLink>
                <NavLink to="/admin/organizations">Organizations</NavLink>
              </>
            )}
          </nav>
          <div className="userbox">
            <div className="who">
              {user?.name}
              <small>{isAdmin ? 'Administrator' : user?.orgId ? `Submitter · ${user.orgId}` : 'Submitter'}</small>
            </div>
            <button className="btn on-dark small" onClick={() => {
                navigate('/', { replace: true });
                signOut();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
