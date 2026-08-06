import {
  DynamicColorIOS,
  Platform,
  PlatformColor,
  StyleSheet,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { themeHex } from './theme-colors';

type AndroidPlatformColorValue = {
  readonly resource_paths?: string[];
};

let androidSemanticColorScheme: 'light' | 'dark' = 'light';
const androidSemanticColorCache = new WeakMap<
  object,
  Partial<Record<'light' | 'dark', AndroidPlatformColorValue>>
>();

function getAndroidSemanticResource(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const paths = (value as AndroidPlatformColorValue).resource_paths;
  if (!Array.isArray(paths)) return null;
  return paths.find((path) => /^@color\/folio_(?!light_|dark_)[a-z0-9_]+$/.test(path)) ?? null;
}

function androidSemanticColor(resource: string): AndroidPlatformColorValue {
  return PlatformColor(
    resource.replace('@color/folio_', '@color/folio_light_'),
    resource,
  ) as unknown as AndroidPlatformColorValue;
}

function resolveAndroidSemanticColor(
  value: unknown,
  colorScheme = androidSemanticColorScheme,
) {
  const resource = getAndroidSemanticResource(value);
  if (!resource) return value;

  const color = value as object;
  const cached = androidSemanticColorCache.get(color) ?? {};
  if (!cached[colorScheme]) {
    cached[colorScheme] = PlatformColor(
      resource.replace('@color/folio_', `@color/folio_${colorScheme}_`),
      resource,
    ) as unknown as AndroidPlatformColorValue;
    androidSemanticColorCache.set(color, cached);
  }
  return cached[colorScheme];
}

function semanticColor(
  name: string,
  light: string,
  dark: string,
): string {
  // react-native-svg and a few Expo-facing props still type colors as strings,
  // even though React Native accepts dynamic platform colors at runtime.
  if (Platform.OS === 'ios') {
    return DynamicColorIOS({
      light,
      dark,
      highContrastLight: light,
      highContrastDark: dark,
    }) as unknown as string;
  }
  if (Platform.OS === 'android') {
    const resource = `@color/folio_${name.replaceAll('-', '_')}`;
    return androidSemanticColor(resource) as unknown as string;
  }
  if (Platform.OS === 'web') return `var(--folio-${name})`;
  return light;
}

/**
 * Fabric's surface context can retain the previous uiMode after an in-process
 * AppCompat change. Resolve explicit light/dark resources during the next
 * React render so semantic colors never depend on that stale context.
 */
export function prepareAndroidSemanticColors(colorScheme: 'light' | 'dark') {
  if (Platform.OS !== 'android') return;
  androidSemanticColorScheme = colorScheme;
}

const semanticPalette = {
  canvas: semanticColor('canvas', themeHex.light.canvas, themeHex.dark.canvas),
  paper: semanticColor('paper', themeHex.light.paper, themeHex.dark.paper),
  paperStrong: semanticColor('paper-strong', themeHex.light.paperStrong, themeHex.dark.paperStrong),
  ink: semanticColor('ink', themeHex.light.ink, themeHex.dark.ink),
  inkSoft: semanticColor('ink-soft', themeHex.light.inkSoft, themeHex.dark.inkSoft),
  muted: semanticColor('muted', themeHex.light.muted, themeHex.dark.muted),
  faint: semanticColor('faint', themeHex.light.faint, themeHex.dark.faint),
  line: semanticColor('line', themeHex.light.line, themeHex.dark.line),
  lineStrong: semanticColor('line-strong', themeHex.light.lineStrong, themeHex.dark.lineStrong),
  lime: semanticColor('lime', themeHex.light.lime, themeHex.dark.lime),
  limeSurface: semanticColor('lime-surface', themeHex.light.limeSurface, themeHex.dark.limeSurface),
  limeDark: semanticColor('lime-dark', themeHex.light.limeDark, themeHex.dark.limeDark),
  mint: semanticColor('mint', themeHex.light.mint, themeHex.dark.mint),
  apricot: semanticColor('apricot', themeHex.light.apricot, themeHex.dark.apricot),
  lavender: semanticColor('lavender', themeHex.light.lavender, themeHex.dark.lavender),
  sky: semanticColor('sky', themeHex.light.sky, themeHex.dark.sky),
  rose: semanticColor('rose', themeHex.light.rose, themeHex.dark.rose),
  danger: semanticColor('danger', themeHex.light.danger, themeHex.dark.danger),
  dangerSurface: semanticColor('danger-surface', themeHex.light.dangerSurface, themeHex.dark.dangerSurface),
  scrim: 'rgba(11,15,12,0.62)',
  inverseScrim: 'rgba(11,15,12,0.92)',
  paperScrim: 'rgba(255,253,248,0.52)',
  accentBorder: 'rgba(216,246,120,0.24)',
  cameraScrimTop: 'rgba(5,10,7,0.48)',
  cameraScrimBottom: 'rgba(5,10,7,0.58)',
  cameraChrome: 'rgba(17,23,19,0.72)',
  cameraTextMuted: 'rgba(255,253,248,0.72)',
  cameraControl: 'rgba(255,255,255,0.12)',
  mediaScrim: 'rgba(17,23,19,0.82)',
  onDarkMuted: '#A9ADA7',
  black: '#111713',
  accentInk: '#111713',
  onDark: '#FFFDF8',
  inverseSurface: '#2B3A30',
  viewerSurface: semanticColor('viewer-surface', themeHex.light.viewerSurface, themeHex.dark.viewerSurface),
};

export const palette: typeof semanticPalette = Platform.OS === 'android'
  ? new Proxy(semanticPalette, {
      get(target, property, receiver) {
        return resolveAndroidSemanticColor(Reflect.get(target, property, receiver));
      },
    })
  : semanticPalette;

const androidPaletteCache: Partial<Record<'light' | 'dark', typeof semanticPalette>> = {};

/** Returns immutable Android color values for an explicitly resolved scheme. */
export function resolveThemedPalette(colorScheme: 'light' | 'dark'): typeof semanticPalette {
  if (Platform.OS !== 'android') return palette;
  if (!androidPaletteCache[colorScheme]) {
    androidPaletteCache[colorScheme] = Object.fromEntries(
      Object.entries(semanticPalette).map(([name, color]) => [
        name,
        resolveAndroidSemanticColor(color, colorScheme),
      ]),
    ) as typeof semanticPalette;
  }
  return androidPaletteCache[colorScheme];
}

type FolioNamedStyles<T> = {
  [P in keyof T]: ViewStyle | TextStyle | ImageStyle;
};

const androidStyleCache = new WeakMap<
  object,
  Partial<Record<'light' | 'dark', ViewStyle | TextStyle | ImageStyle>>
>();
const androidStyleSheetCache = new WeakMap<
  object,
  Record<'light' | 'dark', object>
>();

function resolveAndroidStyle<T extends ViewStyle | TextStyle | ImageStyle>(
  style: T,
  colorScheme = androidSemanticColorScheme,
): T {
  const cached = androidStyleCache.get(style) ?? {};
  if (!cached[colorScheme]) {
    cached[colorScheme] = Object.fromEntries(
      Object.entries(style).map(([property, value]) => [
        property,
        resolveAndroidSemanticColor(value, colorScheme),
      ]),
    ) as unknown as T;
    androidStyleCache.set(style, cached);
  }
  return cached[colorScheme] as T;
}

/**
 * Keeps module-level styles allocation-free during normal renders while giving
 * Fabric a new immutable color value only when Android's resolved scheme
 * changes. This refreshes mounted views without remounting navigation or screen
 * state.
 */
export function createThemedStyleSheet<
  T extends FolioNamedStyles<T> | FolioNamedStyles<Record<string, unknown>>,
>(styles: T & FolioNamedStyles<Record<string, unknown>>): T {
  const created = StyleSheet.create(styles);
  if (Platform.OS !== 'android') return created;
  const themed = Object.fromEntries(
    (['light', 'dark'] as const).map((colorScheme) => [
      colorScheme,
      Object.fromEntries(
        Object.entries(created).map(([name, style]) => [
          name,
          resolveAndroidStyle(
            style as ViewStyle | TextStyle | ImageStyle,
            colorScheme,
          ),
        ]),
      ),
    ]),
  ) as Record<'light' | 'dark', object>;
  const proxied = new Proxy(created, {
    get(_target, property) {
      return Reflect.get(themed[androidSemanticColorScheme], property);
    },
  });
  androidStyleSheetCache.set(proxied, themed);
  return proxied;
}

/**
 * Materializes an Android sheet for the resolved context scheme. Passing the
 * scheme explicitly keeps compiler-memoized child components reactive without
 * remounting their state.
 */
export function useThemedStyles<T extends FolioNamedStyles<T>>(
  styles: T,
  colorScheme: 'light' | 'dark',
): T {
  if (Platform.OS !== 'android') return styles;
  return androidStyleSheetCache.get(styles)?.[colorScheme] as T ?? styles;
}

export const fonts = Platform.select({
  ios: {
    sans: 'System',
    serif: 'New York',
    mono: 'SF Mono',
  },
  android: {
    sans: 'sans-serif',
    serif: 'serif',
    mono: 'monospace',
  },
  default: {
    sans: 'system-ui',
    serif: 'Georgia',
    mono: 'monospace',
  },
})!;

export const radii = {
  sm: 12,
  md: 18,
  lg: 26,
  xl: 34,
  pill: 999,
} as const;

export const shadows = {
  card: Platform.select({
    ios: {
      shadowColor: palette.ink,
      shadowOpacity: 0.08,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 3 },
    web: { boxShadow: '0 10px 34px rgba(23,35,27,0.08)' },
  }),
  lift: Platform.select({
    ios: {
      shadowColor: palette.ink,
      shadowOpacity: 0.16,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 12 },
    },
    android: { elevation: 8 },
    web: { boxShadow: '0 16px 38px rgba(23,35,27,0.16)' },
  }),
} as const;

export const maxContentWidth = 760;
export const bottomNavHeight = 88;
