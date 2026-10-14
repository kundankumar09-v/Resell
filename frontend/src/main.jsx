import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App.jsx';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { SocketProvider } from './contexts/SocketContext.jsx';
import { CurrencyProvider } from './contexts/CurrencyContext.jsx';
import { ThemeProvider, useTheme } from './contexts/ThemeContext.jsx';
import './styles/index.css';
import './styles/responsive-design.scss';

function ThemedToaster() {
  const { isDark } = useTheme();
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 3500,
        style: isDark
          ? {
              background: 'linear-gradient(158deg, rgba(28, 39, 84, 0.95), rgba(9, 14, 34, 0.98))',
              color: '#f1f4ff',
              borderRadius: '14px',
              padding: '12px 18px',
              fontSize: '14px',
              border: '1px solid rgba(148, 163, 255, 0.25)',
              boxShadow: '0 12px 36px -8px rgba(2, 4, 14, 0.9), 0 0 28px -6px rgba(129, 140, 248, 0.35)',
              backdropFilter: 'blur(16px)',
            }
          : {
              background: '#ffffff',
              color: '#0f172a',
              borderRadius: '14px',
              padding: '12px 18px',
              fontSize: '14px',
              border: '1px solid rgba(226, 232, 240, 0.8)',
              boxShadow: '0 12px 36px -8px rgba(15, 23, 42, 0.12)',
            },
        success: {
          iconTheme: { primary: isDark ? '#818cf8' : '#4f4af0', secondary: '#fff' },
          style: isDark
            ? { background: 'linear-gradient(158deg, rgba(28,39,84,0.95), rgba(9,14,34,0.98))', border: '1px solid rgba(148,163,255,0.25)', color: '#f1f4ff', borderLeft: '3px solid #818cf8', borderRadius: '14px', boxShadow: '0 12px 36px -8px rgba(2,4,14,0.9), 0 0 28px -6px rgba(129,140,248,0.35)' }
            : { background: '#ffffff', color: '#0f172a', border: '1px solid rgba(226,232,240,0.8)', borderLeft: '3px solid #4f46e5', borderRadius: '14px', boxShadow: '0 12px 36px -8px rgba(15,23,42,0.12)' }
        },
        error: {
          iconTheme: { primary: '#f43f5e', secondary: '#fff' },
          style: isDark
            ? { background: 'linear-gradient(158deg, rgba(84,20,40,0.95), rgba(34,9,16,0.98))', border: '1px solid rgba(251,113,133,0.25)', color: '#fef2f2', borderLeft: '3px solid #fb7185', borderRadius: '14px', boxShadow: '0 12px 36px -8px rgba(14,2,6,0.9), 0 0 28px -6px rgba(251,113,133,0.35)' }
            : { background: '#ffffff', color: '#0f172a', border: '1px solid rgba(254,202,202,0.8)', borderLeft: '3px solid #fb7185', borderRadius: '14px', boxShadow: '0 12px 36px -8px rgba(15,23,42,0.12)' }
        },
      }}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ThemeProvider>
        <AuthProvider>
          <CurrencyProvider>
            <SocketProvider>
              <App />
              <ThemedToaster />
            </SocketProvider>
          </CurrencyProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
