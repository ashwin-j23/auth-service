import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api/client';
import { getJwtExpiryMs } from '../lib/utils/jwt';

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5min before expiry (~10min into a 15min token)
const FALLBACK_INTERVAL_MS = 10 * 60 * 1000;
const MAX_RETRIES = 3;

/** Proactively rotates the access token before it expires, and again on a
 * hard 401 the API client couldn't recover from — clearing the session and
 * bouncing to /login only after retries are exhausted. */
export function useSilentRefresh() {
  const status = useAuthStore((s) => s.status);
  const accessToken = useAuthStore((s) => s.accessToken);
  const updateTokens = useAuthStore((s) => s.updateTokens);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();

  useEffect(() => {
    if (status !== 'authenticated') return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    async function refreshWithRetry(attempt = 0): Promise<void> {
      const tokens = await api.refreshTokens();
      if (cancelled) return;
      if (tokens) {
        updateTokens(tokens);
        scheduleNext(tokens.accessToken);
        return;
      }
      if (attempt < MAX_RETRIES) {
        const backoffMs = 1000 * 2 ** attempt;
        timeoutId = setTimeout(() => refreshWithRetry(attempt + 1), backoffMs);
        return;
      }
      clear();
      toast.error('Your session has expired. Please log in again.');
      navigate('/login?session=expired');
    }

    function scheduleNext(token: string) {
      const expiryMs = getJwtExpiryMs(token);
      const delay = expiryMs ? Math.max(expiryMs - Date.now() - REFRESH_BUFFER_MS, 15_000) : FALLBACK_INTERVAL_MS;
      timeoutId = setTimeout(() => refreshWithRetry(), delay);
    }

    scheduleNext(accessToken ?? '');

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [status]);
}
