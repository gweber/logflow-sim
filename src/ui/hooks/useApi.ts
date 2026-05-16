import { useEffect, useState, useCallback } from 'preact/hooks';
import { apiGet } from '../lib/api';

export function useApi<T>(path: string | null, deps: unknown[] = []): {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    apiGet<T>(path)
      .then((d) => {
        if (alive) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  return { data, loading, error, reload };
}
