import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setCompanies([]);
  }, []);

  // โหลดข้อมูลตัวเอง + พื้นที่ที่ใช้ + บริษัทที่อยู่ (เรียกซ้ำหลังมีการเปลี่ยนแปลง)
  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try {
      const data = await api('GET', '/me');
      setUser(data.user);
      setCompanies(data.companies);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    refresh().catch(() => logout());
  }, [refresh, logout]);

  const signIn = useCallback(
    async (path, body) => {
      const data = await api('POST', path, body);
      setToken(data.token);
      setUser(data.user);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ user, companies, loading, refresh, logout, signIn }),
    [user, companies, loading, refresh, logout, signIn],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
