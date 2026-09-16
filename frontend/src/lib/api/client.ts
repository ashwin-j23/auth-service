import { ApiError } from './types';
import type {
  AuthResult,
  LoginBody,
  MessageResponse,
  PublicUser,
  SignupBody,
  TokenPair,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/auth';

// Endpoints where a 401 means "these exact credentials/token were rejected",
// not "the session expired" — retrying them after a silent refresh would
// either loop pointlessly (refresh itself) or paper over the real error
// (login/signup never return 401 anyway, google/exchange fails on the code
// itself). Only requests OUTSIDE this set get the silent-refresh-then-retry
// treatment below.
const NO_REFRESH_RETRY = new Set(['/login', '/signup', '/refresh', '/logout', '/google/exchange']);

interface Accessors {
  getRefreshToken: () => string | null;
  onTokens: (tokens: TokenPair) => void;
  onAuthExpired: () => void;
}

function parseRetryAfterSeconds(res: Response): number | undefined {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const asInt = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(asInt)) return asInt;
  }
  const resetHeader = res.headers.get('ratelimit-reset');
  if (resetHeader) {
    const asInt = Number.parseInt(resetHeader, 10);
    if (!Number.isNaN(asInt)) return asInt;
  }
  return undefined;
}

class AuthApiClient {
  private accessToken: string | null = null;
  private refreshPromise: Promise<TokenPair | null> | null = null;
  private accessors: Accessors | null = null;

  /** Wired up once by the auth store so this client can read the persisted
   * refresh token and push new tokens back without importing the store
   * directly (that would create a store <-> client import cycle). */
  configure(accessors: Accessors) {
    this.accessors = accessors;
  }

  setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    { allowRefreshRetry = true }: { allowRefreshRetry?: boolean } = {},
  ): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      ...options.headers,
    };

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch {
      throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
    }

    if (res.status === 401 && allowRefreshRetry && !NO_REFRESH_RETRY.has(path)) {
      const newTokens = await this.refreshTokens();
      if (newTokens) {
        this.setAccessToken(newTokens.accessToken);
        this.accessors?.onTokens(newTokens);
        return this.request<T>(path, options, { allowRefreshRetry: false });
      }
      this.accessors?.onAuthExpired();
      throw new ApiError(401, 'Your session has expired. Please log in again.');
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 429) {
        throw new ApiError(
          429,
          'Too many attempts. Please wait before trying again.',
          parseRetryAfterSeconds(res),
        );
      }
      throw new ApiError(res.status, data?.error?.message ?? 'Something went wrong.');
    }

    return data as T;
  }

  async refreshTokens(): Promise<TokenPair | null> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const refreshToken = this.accessors?.getRefreshToken();
      if (!refreshToken) return null;
      try {
        const res = await fetch(`${API_BASE}/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { tokens: TokenPair };
        return data.tokens;
      } catch {
        return null;
      }
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  signup(body: SignupBody) {
    return this.request<AuthResult>('/signup', { method: 'POST', body: JSON.stringify(body) });
  }

  login(body: LoginBody) {
    return this.request<AuthResult>('/login', { method: 'POST', body: JSON.stringify(body) });
  }

  logout(refreshToken: string) {
    return this.request<void>('/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
  }

  me() {
    return this.request<{ user: PublicUser }>('/me');
  }

  googleExchange(code: string) {
    return this.request<AuthResult>(
      '/google/exchange',
      { method: 'POST', body: JSON.stringify({ code }) },
      { allowRefreshRetry: false },
    );
  }

  requestEmailVerification(email: string) {
    return this.request<MessageResponse>('/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  confirmEmailVerification(token: string) {
    return this.request<MessageResponse>('/email/verify/confirm', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  requestPasswordReset(email: string) {
    return this.request<MessageResponse>('/password/reset', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  confirmPasswordReset(token: string, password: string) {
    return this.request<MessageResponse>('/password/reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  /** GET /google is a full-page redirect flow, not a fetch call. */
  getGoogleAuthUrl() {
    return `${API_BASE}/google`;
  }
}

export const api = new AuthApiClient();
