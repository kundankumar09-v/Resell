import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { authService } from '../services/services';
import { clearApiCache } from '../services/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const loadUser = useCallback(async () => {
    const request = ++requestRef.current;
    const isCurrent = () => mountedRef.current && request === requestRef.current;
    try {
      const { data } = await authService.me();
      if (isCurrent()) setUser(data.user);
    } catch (err) {
      if (!isCurrent()) return;
      console.error('[Auth] Load user failed:', err);
      setUser(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadUser();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [loadUser]);

  const login = async (credentials) => {
    const request = ++requestRef.current;
    // Drop cached GET responses from any previous session so a different
    // user on the same browser never sees stale protected data.
    clearApiCache();
    try {
      const { data } = await authService.login(credentials);
      if (mountedRef.current && request === requestRef.current) setUser(data.user);
      return data.user;
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  };

  const register = async (userData) => {
    const request = ++requestRef.current;
    clearApiCache();
    try {
      const { data } = await authService.register(userData);
      if (mountedRef.current && request === requestRef.current) setUser(data.user);
      return data.user;
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  };

  const logout = async () => {
    const request = ++requestRef.current;
    clearApiCache();
    try {
      await authService.logout();
    } catch {
    } finally {
      clearApiCache();
      if (mountedRef.current && request === requestRef.current) {
        setUser(null);
        setLoading(false);
      }
    }
  };

  const updateUser = (updates) => {
    setUser((prev) => ({ ...prev, ...updates }));
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser, refresh: loadUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
