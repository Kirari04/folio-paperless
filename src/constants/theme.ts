import {
  DynamicColorIOS,
  Platform,
  PlatformColor,
} from 'react-native';

import { themeHex } from './theme-colors';

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
    return PlatformColor(`@color/folio_${name.replaceAll('-', '_')}`) as unknown as string;
  }
  if (Platform.OS === 'web') return `var(--folio-${name})`;
  return light;
}

export const palette = {
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
