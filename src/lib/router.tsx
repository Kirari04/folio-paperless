import {
  CommonActions,
  DefaultTheme,
  NavigationContainer,
  StackActions,
  useNavigationContainerRef,
} from '@react-navigation/native';
import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { palette } from '@/constants/theme';

export type RoutePath =
  | '/'
  | '/documents'
  | '/inbox'
  | '/settings'
  | '/trash'
  | '/scan'
  | '/intake'
  | '/tasks'
  | '/saved-views'
  | '/paperless-metadata'
  | '/document/[id]';

export type TabRoutePath = Extract<RoutePath, '/' | '/documents' | '/inbox' | '/settings'>;

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

export type RootStackParamList = {
  Tabs: undefined;
  Document: { id: string; from?: string };
  Scan: undefined;
  Trash: undefined;
  Intake: { batchId?: string } | undefined;
  Tasks: undefined;
  SavedViews: { id?: string } | undefined;
  PaperlessMetadata: undefined;
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

const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: palette.ink,
    background: palette.canvas,
    card: palette.canvas,
    text: palette.ink,
    border: palette.line,
    notification: palette.limeDark,
  },
};

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

function isTabPath(pathname: RoutePath): pathname is TabRoutePath {
  return ['/', '/documents', '/inbox', '/settings'].includes(pathname);
}

function nativeRouteFor(route: NavigationRoute) {
  switch (route.pathname) {
    case '/document/[id]':
      return {
        name: 'Document' as const,
        params: { id: route.params.id, from: route.params.from },
      };
    case '/scan':
      return { name: 'Scan' as const, params: undefined };
    case '/trash':
      return { name: 'Trash' as const, params: undefined };
    case '/intake':
      return { name: 'Intake' as const, params: { batchId: route.params.batchId } };
    case '/tasks':
      return { name: 'Tasks' as const, params: undefined };
    case '/saved-views':
      return { name: 'SavedViews' as const, params: { id: route.params.id } };
    case '/paperless-metadata':
      return { name: 'PaperlessMetadata' as const, params: undefined };
    default:
      return null;
  }
}

export function NavigationProvider({ children }: PropsWithChildren) {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const initialRoute = useMemo<NavigationRoute>(() => ({ key: 0, pathname: '/', params: {} }), []);
  const [route, setRoute] = useState(initialRoute);
  const [tabRoute, setTabRoute] = useState(initialRoute);
  const [lastDocument, setLastDocument] = useState<NavigationRoute | null>(null);
  const tabRouteRef = useRef(tabRoute);

  const updateTab = useCallback((nextRoute: NavigationRoute) => {
    tabRouteRef.current = nextRoute;
    setTabRoute(nextRoute);
    setRoute(nextRoute);

    if (navigationRef.isReady() && navigationRef.getCurrentRoute()?.name !== 'Tabs') {
      navigationRef.dispatch(StackActions.popToTop());
    }
  }, [navigationRef]);

  const navigateNative = useCallback((target: RouteTarget, action: 'push' | 'navigate' | 'replace') => {
    const nextRoute = createRoute(target);
    if (isTabPath(nextRoute.pathname)) {
      updateTab(nextRoute);
      return;
    }

    const nativeRoute = nativeRouteFor(nextRoute);
    if (!nativeRoute || !navigationRef.isReady()) return;
    if (nextRoute.pathname === '/document/[id]') setLastDocument(nextRoute);

    if (action === 'push') {
      navigationRef.dispatch(StackActions.push(nativeRoute.name, nativeRoute.params));
    } else if (action === 'replace') {
      navigationRef.dispatch(StackActions.replace(nativeRoute.name, nativeRoute.params));
    } else {
      navigationRef.dispatch(CommonActions.navigate(nativeRoute));
    }
  }, [navigationRef, updateTab]);

  const preload = useCallback((target: RouteTarget) => {
    const nextRoute = createRoute(target);
    const nativeRoute = nativeRouteFor(nextRoute);
    if (!nativeRoute || !navigationRef.isReady()) return;
    if (nextRoute.pathname === '/document/[id]') setLastDocument(nextRoute);
    switch (nativeRoute.name) {
      case 'Document':
        navigationRef.preload('Document', nativeRoute.params);
        break;
      case 'Intake':
        navigationRef.preload('Intake', nativeRoute.params);
        break;
      case 'SavedViews':
        navigationRef.preload('SavedViews', nativeRoute.params);
        break;
      default:
        navigationRef.preload(nativeRoute.name);
    }
  }, [navigationRef]);

  const syncCurrentRoute = useCallback(() => {
    const nativeRoute = navigationRef.getCurrentRoute();
    if (!nativeRoute || nativeRoute.name === 'Tabs') {
      setRoute(tabRouteRef.current);
      return;
    }

    const params = (nativeRoute.params ?? {}) as Record<string, string | number | undefined>;
    const pathname: RoutePath = ({
      Document: '/document/[id]',
      Scan: '/scan',
      Trash: '/trash',
      Intake: '/intake',
      Tasks: '/tasks',
      SavedViews: '/saved-views',
      PaperlessMetadata: '/paperless-metadata',
    } as const)[nativeRoute.name];
    setRoute(createRoute({ pathname, params }));
  }, [navigationRef]);

  const router = useMemo<Router>(() => ({
    push: (target) => navigateNative(target, 'push'),
    preload,
    navigate: (target) => navigateNative(target, 'navigate'),
    replace: (target) => navigateNative(target, 'replace'),
    back: () => {
      if (navigationRef.isReady() && navigationRef.canGoBack()) navigationRef.goBack();
    },
  }), [navigateNative, navigationRef, preload]);

  const lastTab = tabRoute.pathname as TabRoutePath;

  return (
    <NavigationContainer
      onReady={syncCurrentRoute}
      onStateChange={syncCurrentRoute}
      ref={navigationRef}
      theme={navigationTheme}>
      <RouterContext.Provider value={router}>
        <NavigationMotionContext.Provider value={{ lastDocument, lastTab }}>
          <RouteContext.Provider value={route}>{children}</RouteContext.Provider>
        </NavigationMotionContext.Provider>
      </RouterContext.Provider>
    </NavigationContainer>
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
