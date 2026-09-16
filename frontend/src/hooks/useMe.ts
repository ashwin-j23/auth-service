import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api/client';
import { useAuthStore } from '../store/authStore';

export function useMe() {
  const status = useAuthStore((s) => s.status);
  const setUser = useAuthStore((s) => s.setUser);

  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    enabled: status === 'authenticated',
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (query.data) setUser(query.data.user);
  }, [query.data, setUser]);

  return query;
}
