import type { SFSymbol } from 'expo-symbols';
import { Fragment, type ReactNode } from 'react';

export function PlatformIcon({ fallback }: {
  color: string;
  fallback: ReactNode;
  iosName: SFSymbol;
  size: number;
  weight?: 'regular' | 'semibold' | 'bold';
}) {
  return <Fragment>{fallback}</Fragment>;
}
