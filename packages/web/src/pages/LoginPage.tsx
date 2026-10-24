import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { Spinner } from '../components/ui';
import { APP_NAME } from '../components/Layout';

const DEMO_USERS = [
  { email: 'user@ccsv.local', label: 'Submitter — City Court of Somewhereville' },
  { email: 'user@bpu.local', label: 'Submitter — Bayou Parish Utilities' },
  { email: 'anyone@demo.local', label: 'Submitter — no organization' },
  { email: 'admin@demo.local', label: 'Administrator (rules & dashboard)' },
];
const DEMO_PASSWORD = 'Password1!';

export function LoginPage() {
  const { signIn, config } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [completeNew, setCompleteNew] = useState<((p: string) => Promise<void>) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent, em = email, pw = password) => {
    e.preventDefault();
    void run(async () => {
      const next = await signIn(em, pw);
      if (next) setCompleteNew(() => next);
    });
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="row" style={{ marginBottom: 18 }}>
          <img src="/favicon.svg" width={40} height={40} alt="" />
          <div>
            <h1 style={{ margin: 0 }}>{APP_NAME}</h1>
            <div className="muted small">Validate files against configurable rules before you submit them</div>
          </div>
        </div>

        {error && <div className="alert err">{error}</div>}

        {completeNew ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => completeNew(newPassword));
            }}
            className="grid"
          >
            <div className="alert info">Please choose a new password to finish setting up your account.</div>
            <label className="field">
              New password
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required />
            </label>
            <button className="btn primary" disabled={busy}>
              {busy && <Spinner />} Set password and sign in
            </button>
          </form>
        ) : (
          <form onSubmit={submit} className="grid">
            <label className="field">
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
            </label>
            <label className="field">
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
            <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>
              {busy && <Spinner />} Sign in
            </button>
          </form>
        )}

        {config?.mode === 'local' && !completeNew && (
          <div className="demo-users">
            <div className="muted small" style={{ marginBottom: 8 }}>
              Local demo accounts (password <code>{DEMO_PASSWORD}</code>):
            </div>
            {DEMO_USERS.map((u) => (
              <button
                key={u.email}
                className="btn"
                disabled={busy}
                onClick={(e) => {
                  setEmail(u.email);
                  setPassword(DEMO_PASSWORD);
                  submit(e, u.email, DEMO_PASSWORD);
                }}
              >
                <span>{u.label}</span>
                <span className="muted small">{u.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
