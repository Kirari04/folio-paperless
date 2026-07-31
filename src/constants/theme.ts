import { Platform } from 'react-native';

export const palette = {
  canvas: '#F3F0E8',
  paper: '#FFFDF8',
  paperStrong: '#FFFFFF',
  ink: '#17231B',
  inkSoft: '#354139',
  muted: '#737A73',
  faint: '#A9ADA7',
  line: '#E3DED2',
  lineStrong: '#D4CEC0',
  lime: '#D8F678',
  limeDark: '#78982F',
  mint: '#CDE8D4',
  apricot: '#F2B486',
  lavender: '#D8D2F1',
  sky: '#C9E1EB',
  rose: '#EDC7C1',
  danger: '#A94E41',
  black: '#111713',
} as const;

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
      shadowColor: '#17231B',
      shadowOpacity: 0.08,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 3 },
    web: { boxShadow: '0 10px 34px rgba(23,35,27,0.08)' },
  }),
  lift: Platform.select({
    ios: {
      shadowColor: '#17231B',
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
