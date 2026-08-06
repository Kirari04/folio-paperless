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
  yieldToPresentation?: () => Promise<void>;
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
 * Publishes the selected appearance immediately, then gives React one frame to
 * start presentation work before Android performs its AppCompat configuration
 * change. If native application or protected persistence fails, the previous
 * native and published state are restored together.
 */
export async function commitNativeAppearanceTransition<T extends AppearanceSettings>({
  previous,
  next,
  applyNative,
  persist,
  publish,
  yieldToPresentation,
}: AppearanceTransition<T>) {
  publish(next);
  try {
    await yieldToPresentation?.();
    await applyNative(next);
  } catch (error) {
    await restoreNativeAppearance(previous, applyNative);
    publish(previous);
    throw error;
  }

  try {
    await persist(next);
  } catch (error) {
    await restoreNativeAppearance(previous, applyNative);
    publish(previous);
    throw error;
  }
}
