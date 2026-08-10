'use client';

import { useActionState } from 'react';
import { login, redeemPartyLink, type ActionResult } from '../actions';
import { Notice } from '@/components/ui';
import { useState } from 'react';

const initial: ActionResult = {};

export default function LoginPage() {
  const [mode, setMode] = useState<'password' | 'link'>('password');
  const [loginState, loginAction, loginPending] = useActionState(login, initial);
  const [linkState, linkAction, linkPending] = useActionState(redeemPartyLink, initial);

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand-lg">
          <strong>GTIDS Agreement Portal</strong>
          <span>Gramtarang Inclusive Development Services</span>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 18, gap: 6 }}>
            <button
              type="button"
              className={mode === 'password' ? 'btn-sm' : 'btn-ghost btn-sm'}
              onClick={() => setMode('password')}
            >
              Staff sign-in
            </button>
            <button
              type="button"
              className={mode === 'link' ? 'btn-sm' : 'btn-ghost btn-sm'}
              onClick={() => setMode('link')}
            >
              I have an access link
            </button>
          </div>

          {mode === 'password' ? (
            <form action={loginAction}>
              {loginState.error && <Notice tone="error">{loginState.error}</Notice>}
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </div>
              <button type="submit" style={{ width: '100%' }} disabled={loginPending}>
                {loginPending ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          ) : (
            <form action={linkAction}>
              {linkState.error && <Notice tone="error">{linkState.error}</Notice>}
              <p className="faint" style={{ marginTop: 0 }}>
                External parties receive a single-use link by email. It is valid for 72 hours,
                works once, and opens only the agreement it was issued for.
              </p>
              <div className="field">
                <label htmlFor="token">Access token</label>
                <input id="token" name="token" required autoFocus className="mono" />
              </div>
              <button type="submit" style={{ width: '100%' }} disabled={linkPending}>
                {linkPending ? 'Opening…' : 'Open my agreement'}
              </button>
            </form>
          )}
        </div>

        <p className="faint" style={{ textAlign: 'center', marginTop: 16 }}>
          Signing is performed by a licensed eSign provider using Aadhaar OTP.
          <br />
          GTIDS never stores your Aadhaar number or the OTP.
        </p>
      </div>
    </main>
  );
}
