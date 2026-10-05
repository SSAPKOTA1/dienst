import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, onAuthChange, setToken, tryRestoreSession, getToken } from './api';

export type RoleName = 'superAdmin' | 'admin' | 'manager' | 'employee';
export interface AvailableRole {
  role: RoleName;
  employeeId?: number;
  companyName?: string;
  companyIds?: number[];
  hotelNames?: string[];
}
export interface Me {
  userId: number;
  email: string | null;
  username: string | null;
  role: RoleName;
  displayName: string;
  employeeId: number | null;
  companyIds: number[];
  hotelIds: number[];
  availableRoles: AvailableRole[];
  personnelNumber?: string;
  homeHotel?: string;
  companyName?: string;
}

interface AuthState {
  ready: boolean;
  me: Me | null;
  logout: () => Promise<void>;
  setSession: (token: string) => void;
  switchRole: (role: RoleName, employeeId?: number) => Promise<void>;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const [hasToken, setHasToken] = useState(!!getToken());

  useEffect(() => {
    const off = onAuthChange(() => setHasToken(!!getToken()));
    void tryRestoreSession().finally(() => setReady(true));
    return off;
  }, []);

  const meQ = useQuery({
    queryKey: ['me', hasToken],
    queryFn: () => api<Me>('/me'),
    enabled: hasToken && ready,
  });

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {}, noRetry: true }).catch(() => undefined);
    setToken(null);
    qc.clear();
  }, [qc]);

  const setSession = useCallback((t: string) => setToken(t), []);
  const switchRole = useCallback(
    async (role: RoleName, employeeId?: number) => {
      const r = await api<{ accessToken: string }>('/auth/switch-role', { body: { role, employeeId } });
      setToken(r.accessToken);
      qc.clear();
    },
    [qc],
  );

  const value = useMemo<AuthState>(
    () => ({
      ready: ready && (!hasToken || !meQ.isLoading),
      me: hasToken ? (meQ.data ?? null) : null,
      logout,
      setSession,
      switchRole,
    }),
    [ready, hasToken, meQ.isLoading, meQ.data, logout, setSession, switchRole],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const homePathFor = (role: RoleName) => (role === 'employee' ? '/me' : '/planning');
