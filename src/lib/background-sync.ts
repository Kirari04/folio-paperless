import type { SyncNetworkState } from './offline-sync.ts';
import { translateRuntime } from '../i18n/runtime.ts';

export const MINIMUM_BACKGROUND_INTERVAL_MINUTES = 15;

export type BackgroundAvailability = 'available' | 'restricted' | 'unavailable';

export type BackgroundRunConstraints = {
  availability: BackgroundAvailability;
  network: SyncNetworkState;
  availableDiskBytes: number | null;
  reserveBytes: number;
  deadlineAt?: number;
};

export type BackgroundDeferralReason =
  | 'platform-restricted'
  | 'offline'
  | 'storage-pressure'
  | 'deadline-expired';

export type BackgroundConstraintResult =
  | { runnable: true }
  | { runnable: false; reason: BackgroundDeferralReason; detail: string };

export type BackgroundProfileResult = {
  profileId: string;
  outcome: 'completed' | 'busy' | 'failed';
  error?: string;
};

export type BackgroundCycleResult =
  | {
      kind: 'deferred';
      reason: BackgroundDeferralReason;
      detail: string;
      profiles?: BackgroundProfileResult[];
    }
  | { kind: 'completed'; profiles: BackgroundProfileResult[] }
  | { kind: 'failed'; profiles: BackgroundProfileResult[] };

export interface BackgroundRegistrationPort {
  availability(): Promise<BackgroundAvailability>;
  isDefined(taskName: string): boolean;
  isRegistered(taskName: string): Promise<boolean>;
  register(taskName: string, minimumIntervalMinutes: number): Promise<void>;
  unregister(taskName: string): Promise<void>;
}

export type BackgroundRegistrationResult =
  | { kind: 'registered' | 'already-registered'; minimumIntervalMinutes: number; exactSchedule: false }
  | { kind: 'unavailable'; detail: string; exactSchedule: false }
  | { kind: 'not-defined'; detail: string; exactSchedule: false };

export function evaluateBackgroundConstraints(
  constraints: BackgroundRunConstraints,
  now = Date.now(),
): BackgroundConstraintResult {
  if (constraints.availability !== 'available') {
    return {
      runnable: false,
      reason: 'platform-restricted',
      detail: translateRuntime('backgroundRuntime.unavailable'),
    };
  }
  if (constraints.network.isConnected === false || constraints.network.isInternetReachable === false) {
    return {
      runnable: false,
      reason: 'offline',
      detail: translateRuntime('backgroundRuntime.network'),
    };
  }
  if (
    constraints.availableDiskBytes !== null
    && constraints.availableDiskBytes < Math.max(0, constraints.reserveBytes)
  ) {
    return {
      runnable: false,
      reason: 'storage-pressure',
      detail: translateRuntime('backgroundRuntime.storageReserve'),
    };
  }
  if (constraints.deadlineAt !== undefined && constraints.deadlineAt <= now) {
    return {
      runnable: false,
      reason: 'deadline-expired',
      detail: translateRuntime('backgroundRuntime.expired'),
    };
  }
  return { runnable: true };
}

export async function configureBestEffortBackgroundSync(input: {
  port: BackgroundRegistrationPort;
  taskName: string;
  minimumIntervalMinutes?: number;
}): Promise<BackgroundRegistrationResult> {
  if (!input.taskName.trim()) throw new Error('A background task name is required.');
  const availability = await input.port.availability();
  if (availability !== 'available') {
    return {
      kind: 'unavailable',
      detail: translateRuntime('backgroundRuntime.restricted'),
      exactSchedule: false,
    };
  }
  if (!input.port.isDefined(input.taskName)) {
    return {
      kind: 'not-defined',
      detail: translateRuntime('backgroundRuntime.globalScope'),
      exactSchedule: false,
    };
  }
  const minimumIntervalMinutes = Math.max(
    MINIMUM_BACKGROUND_INTERVAL_MINUTES,
    Math.floor(input.minimumIntervalMinutes ?? 12 * 60),
  );
  if (await input.port.isRegistered(input.taskName)) {
    return { kind: 'already-registered', minimumIntervalMinutes, exactSchedule: false };
  }
  await input.port.register(input.taskName, minimumIntervalMinutes);
  return { kind: 'registered', minimumIntervalMinutes, exactSchedule: false };
}

export async function runBestEffortBackgroundCycle(input: {
  constraints: BackgroundRunConstraints;
  profileIds: string[];
  runProfile(profileId: string): Promise<Omit<BackgroundProfileResult, 'profileId'>>;
  now?: () => number;
}): Promise<BackgroundCycleResult> {
  const now = input.now ?? Date.now;
  const eligibility = evaluateBackgroundConstraints(input.constraints, now());
  if (!eligibility.runnable) return { kind: 'deferred', reason: eligibility.reason, detail: eligibility.detail };

  const profiles: BackgroundProfileResult[] = [];
  for (const profileId of [...new Set(input.profileIds)]) {
    if (input.constraints.deadlineAt !== undefined && now() >= input.constraints.deadlineAt) {
      return {
        kind: 'deferred',
        reason: 'deadline-expired',
        detail: translateRuntime('backgroundRuntime.profilesExpired'),
        profiles,
      };
    }
    try {
      profiles.push({ profileId, ...await input.runProfile(profileId) });
    } catch (error) {
      profiles.push({
        profileId,
        outcome: 'failed',
        error: error instanceof Error ? error.message : translateRuntime('backgroundRuntime.profileFailed'),
      });
    }
  }
  return profiles.some((profile) => profile.outcome === 'failed')
    ? { kind: 'failed', profiles }
    : { kind: 'completed', profiles };
}
