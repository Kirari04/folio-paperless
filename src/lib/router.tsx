import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BackHandler, Platform } from 'react-native';

export type RoutePath =
  | '/'
  | '/documents'
  | '/inbox'
  | '/settings'
  | '/trash'
  | '/scan'
  | '/document/[id]';

type TabRoutePath = Extract<RoutePath, '/' | '/documents' | '/inbox' | '/settings'>;

type RouteParams = Record<string, string>;

type RouteTarget =
  | RoutePath
  | {
      pathname: RoutePath;
      params?: Record<string, string | number | undefined>;
    };

export type NavigationRoute = {
  key: number;
  pathname: RoutePath;
  params: RouteParams;
};

type Router = {
  push: (target: RouteTarget) => void;
  preload: (target: RouteTarget) => void;
  navigate: (target: RouteTarget) => void;
  replace: (target: RouteTarget) => void;
  back: () => void;
};

const RouteContext = createContext<NavigationRoute | null>(null);
const RouterContext = createContext<Router | null>(null);
const NavigationMotionContext = createContext<{
  lastDocument: NavigationRoute | null;
  lastTab: TabRoutePath;
}>({ lastDocument: null, lastTab: '/' });

let nextRouteKey = 1;

function createRoute(target: RouteTarget): NavigationRoute {
  if (typeof target === 'string') {
    return { key: nextRouteKey++, pathname: target, params: {} };
  }

  return {
    key: nextRouteKey++,
    pathname: target.pathname,
    params: Object.fromEntries(
      Object.entries(target.params ?? {})
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ),
  };
}

export function NavigationProvider({ children }: PropsWithChildren) {
  const [history, setHistory] = useState<NavigationRoute[]>([
    { key: 0, pathname: '/', params: {} },
  ]);
  const [lastDocument, setLastDocument] = useState<NavigationRoute | null>(null);
  const historyLength = useRef(1);
  const currentPath = useRef<RoutePath>('/');

  useEffect(() => {
    historyLength.current = history.length;
    currentPath.current = history[history.length - 1].pathname;
  }, [history]);

  const push = useCallback((target: RouteTarget) => {
    const route = createRoute(target);
    if (route.pathname === '/document/[id]') {
      setLastDocument((current) =>
        current?.params.id === route.params.id ? { ...route, key: current.key } : route,
      );
    }
    setHistory((current) => [...current, route]);
  }, []);

  const preload = useCallback((target: RouteTarget) => {
    if (currentPath.current === '/document/[id]') return;
    const route = createRoute(target);
    if (route.pathname !== '/document/[id]') return;
    setLastDocument((current) =>
      current?.params.id === route.params.id ? { ...route, key: current.key } : route,
    );
  }, []);

  const navigate = useCallback((target: RouteTarget) => {
    const route = createRoute(target);
    if (route.pathname === '/document/[id]') {
      setLastDocument((current) =>
        current?.params.id === route.params.id ? { ...route, key: current.key } : route,
      );
    }
    setHistory((current) => {
      const existingIndex = current.findLastIndex(
        (entry) => entry.pathname === route.pathname && !Object.keys(route.params).length,
      );
      if (existingIndex >= 0) return [...current.slice(0, existingIndex), route];
      return [...current, route];
    });
  }, []);

  const replace = useCallback((target: RouteTarget) => {
    const route = createRoute(target);
    if (route.pathname === '/document/[id]') {
      setLastDocument((current) =>
        current?.params.id === route.params.id ? { ...route, key: current.key } : route,
      );
    }
    setHistory((current) => [...current.slice(0, -1), route]);
  }, []);

  const goBack = useCallback(() => {
    if (historyLength.current <= 1) return false;
    historyLength.current = Math.max(1, historyLength.current - 1);
    setHistory((current) => (current.length <= 1 ? current : current.slice(0, -1)));
    return true;
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', goBack);
    return () => subscription.remove();
  }, [goBack]);

  const router = useMemo<Router>(
    () => ({ push, preload, navigate, replace, back: () => void goBack() }),
    [goBack, navigate, preload, push, replace],
  );
  const route = history[history.length - 1];
  const lastTabEntry = history.findLast((entry) =>
    ['/', '/documents', '/inbox', '/settings'].includes(entry.pathname),
  );
  const lastTab = lastTabEntry && ['/', '/documents', '/inbox', '/settings'].includes(
    lastTabEntry.pathname,
  )
    ? (lastTabEntry.pathname as TabRoutePath)
    : '/';

  return (
    <RouterContext.Provider value={router}>
      <NavigationMotionContext.Provider value={{ lastDocument, lastTab }}>
        <RouteContext.Provider value={route}>{children}</RouteContext.Provider>
      </NavigationMotionContext.Provider>
    </RouterContext.Provider>
  );
}

export function useRouter() {
  const router = useContext(RouterContext);
  if (!router) throw new Error('useRouter must be used inside NavigationProvider');
  return router;
}

export function usePathname() {
  return useNavigationRoute().pathname;
}

export function useLocalSearchParams<T extends object = RouteParams>() {
  return useNavigationRoute().params as T;
}

export function useNavigationRoute() {
  const route = useContext(RouteContext);
  if (!route) throw new Error('Navigation route hooks must be used inside NavigationProvider');
  return route;
}

export function useNavigationMotion() {
  return useContext(NavigationMotionContext);
}
