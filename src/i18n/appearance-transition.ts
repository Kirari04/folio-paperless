import type { AppearancePreference } from './core.ts';

type AppearanceSettings = {
  appearance: AppearancePreference;
};

type AppearanceTransition<T extends AppearanceSettings> = {
  previous: T;
  next: T;
  applyNative: (settings: T) => Promise<void>;
  persist: (settings: T) => Promise<void>;
  publish: (settings: T) => void;
};

async function restoreNativeAppearance<T extends AppearanceSettings>(
  previous: T,
  applyNative: AppearanceTransition<T>['applyNative'],
) {
  try {
    await applyNative(previous);
  } catch {
    // Preserve the original transition error. React state is still restored
    // below so the visible preference never claims a successful change.
  }
}

/**
 * Applies an explicit native appearance before React descendants receive the
 * matching setting. If either application or protected persistence fails, the
 * previous native and published state are restored together.
 */
export async function commitNativeAppearanceTransition<T extends AppearanceSettings>({
  previous,
  next,
  applyNative,
  persist,
  publish,
}: AppearanceTransition<T>) {
  try {
    await applyNative(next);
  } catch (error) {
    await restoreNativeAppearance(previous, applyNative);
    throw error;
  }

  publish(next);
  try {
    await persist(next);
  } catch (error) {
    await restoreNativeAppearance(previous, applyNative);
    publish(previous);
    throw error;
  }
}
