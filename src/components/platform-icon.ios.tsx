import { SymbolView, type SFSymbol, type SymbolWeight } from 'expo-symbols';
import type { ReactNode } from 'react';

export function PlatformIcon({ color, iosName, size, weight = 'regular' }: {
  color: string;
  fallback: ReactNode;
  iosName: SFSymbol;
  size: number;
  weight?: SymbolWeight;
}) {
  return <SymbolView name={iosName} size={size} tintColor={color} weight={weight} />;
}
