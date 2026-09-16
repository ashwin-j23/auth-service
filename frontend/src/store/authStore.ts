import { create } from 'zustand';
import { api } from '../lib/api/client';
import type { PublicUser, TokenPair } from '../lib/api/types';

// The backend hands back the refresh token in the JSON response body rather
// than an HttpOnly cookie (see README for the ideal-world alternative), so
// this is the least-bad place to persist it across reloads/tabs: memory
// alone would force a full re-login on every refresh. sessionStorage (not
// localStorage) so a token doesn't outlive the browser tab it was issued to.
const REFRESH_TOKEN_KEY = 'auth.refreshToken';

function readStoredRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredRefreshToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
    else sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Storage disabled/unavailable (private mode, quota) — session simply
    // won't survive a reload, which is a degradation, not a crash.
  }
}

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  refreshToken: string | null;
  accessToken: string | null;
  setSession: (result: { user: PublicUser; tokens: TokenPair }) => void;
  setUser: (user: PublicUser) => void;
  updateTokens: (tokens: TokenPair) => void;
  clear: () => void;
  bootstrap: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'idle',
  user: null,
  refreshToken: readStoredRefreshToken(),
  accessToken: null,

  setSession: ({ user, tokens }) => {
    api.setAccessToken(tokens.accessToken);
    writeStoredRefreshToken(tokens.refreshToken);
    set({ status: 'authenticated', user, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken });
  },

  setUser: (user) => set({ user }),

  updateTokens: (tokens) => {
    api.setAccessToken(tokens.accessToken);
    writeStoredRefreshToken(tokens.refreshToken);
    set({ refreshToken: tokens.refreshToken, accessToken: tokens.accessToken });
  },

  clear: () => {
    api.setAccessToken(null);
    writeStoredRefreshToken(null);
    set({ status: 'unauthenticated', user: null, refreshToken: null, accessToken: null });
  },

  bootstrap: async () => {
    const refreshToken = get().refreshToken;
    if (!refreshToken) {
      set({ status: 'unauthenticated' });
      return;
    }
    set({ status: 'loading' });
    try {
      const tokens = await api.refreshTokens();
      if (!tokens) throw new Error('refresh failed');
      api.setAccessToken(tokens.accessToken);
      writeStoredRefreshToken(tokens.refreshToken);
      set({ refreshToken: tokens.refreshToken, accessToken: tokens.accessToken });
      const { user } = await api.me();
      set({ status: 'authenticated', user });
    } catch {
      get().clear();
    }
  },
}));

api.configure({
  getRefreshToken: () => useAuthStore.getState().refreshToken,
  onTokens: (tokens) => useAuthStore.getState().updateTokens(tokens),
  onAuthExpired: () => useAuthStore.getState().clear(),
});
