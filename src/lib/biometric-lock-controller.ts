export type BiometricAppState =
  | 'active'
  | 'background'
  | 'inactive'
  | 'unknown'
  | 'extension'
  | null;

export type BiometricLockSnapshot = Readonly<{
  enabled: boolean;
  appState: BiometricAppState;
  locked: boolean;
  unlocking: boolean;
  generation: number;
}>;

export type BiometricUnlockAttempt = Readonly<{
  id: number;
  generation: number;
}>;

type UnlockAttemptMode = 'automatic' | 'manual';

/**
 * Owns the biometric lock lifecycle independently of React render timing.
 * Native AppState changes update this controller synchronously before a new
 * snapshot is published to the UI, so stale React state cannot start a prompt
 * while the app is already leaving the foreground.
 */
export class BiometricLockController {
  private enabled: boolean;
  private appState: BiometricAppState;
  private locked: boolean;
  private unlocking = false;
  private generation = 0;
  private nextAttemptId = 0;
  private activeAttempt: BiometricUnlockAttempt | null = null;
  private automaticAttemptGeneration: number | null = null;

  constructor(input: { enabled: boolean; appState: BiometricAppState }) {
    this.enabled = input.enabled;
    this.appState = input.appState;
    this.locked = input.enabled;
  }

  snapshot(): BiometricLockSnapshot {
    return {
      enabled: this.enabled,
      appState: this.appState,
      locked: this.locked,
      unlocking: this.unlocking,
      generation: this.generation,
    };
  }

  setEnabled(enabled: boolean): BiometricLockSnapshot {
    if (enabled === this.enabled) return this.snapshot();
    this.enabled = enabled;
    this.invalidateAttempt();
    this.locked = enabled;
    return this.snapshot();
  }

  transitionAppState(appState: BiometricAppState): BiometricLockSnapshot {
    if (appState === this.appState) return this.snapshot();
    const wasActive = this.appState === 'active';
    this.appState = appState;

    if (this.enabled && appState !== 'active') {
      if (wasActive) this.invalidateAttempt();
      this.locked = true;
      this.unlocking = false;
    }
    return this.snapshot();
  }

  beginAttempt(mode: UnlockAttemptMode): BiometricUnlockAttempt | null {
    if (
      !this.enabled
      || this.appState !== 'active'
      || !this.locked
      || this.activeAttempt
    ) {
      return null;
    }
    if (
      mode === 'automatic'
      && this.automaticAttemptGeneration === this.generation
    ) {
      return null;
    }

    const attempt = {
      id: ++this.nextAttemptId,
      generation: this.generation,
    };
    this.activeAttempt = attempt;
    this.unlocking = true;
    if (mode === 'automatic') this.automaticAttemptGeneration = this.generation;
    return attempt;
  }

  completeAttempt(
    attempt: BiometricUnlockAttempt,
    succeeded: boolean,
  ): boolean {
    if (
      !this.activeAttempt
      || this.activeAttempt.id !== attempt.id
      || this.activeAttempt.generation !== attempt.generation
      || attempt.generation !== this.generation
    ) {
      return false;
    }

    this.activeAttempt = null;
    this.unlocking = false;
    if (succeeded && this.enabled && this.appState === 'active') {
      this.locked = false;
      return true;
    }
    return false;
  }

  private invalidateAttempt(): void {
    this.generation += 1;
    this.activeAttempt = null;
    this.automaticAttemptGeneration = null;
    this.unlocking = false;
  }
}

export async function performBiometricUnlockAttempt(input: {
  controller: BiometricLockController;
  mode: UnlockAttemptMode;
  currentAppState: BiometricAppState;
  authenticate(): Promise<boolean>;
  onStateChange(snapshot: BiometricLockSnapshot): void;
}): Promise<boolean> {
  input.controller.transitionAppState(input.currentAppState);
  const attempt = input.controller.beginAttempt(input.mode);
  input.onStateChange(input.controller.snapshot());
  if (!attempt) return false;

  let succeeded = false;
  try {
    succeeded = await input.authenticate();
  } catch {
    succeeded = false;
  }
  const unlocked = input.controller.completeAttempt(attempt, succeeded);
  input.onStateChange(input.controller.snapshot());
  return unlocked;
}
