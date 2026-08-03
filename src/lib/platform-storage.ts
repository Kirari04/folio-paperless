import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { AsyncStringStore } from './auth/profile-store';
import { getFolioProtectedStorageNativeModule } from './folio-platform-native';
import {
  SizeSafeStringStore,
  type PhysicalStringStore,
  type StringStoreExclusiveCoordinator,
} from './size-safe-string-store';

const PROTECTED_STORAGE_LEASE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class NativeProtectedStorageExclusiveCoordinator implements StringStoreExclusiveCoordinator {
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const nativeModule = getFolioProtectedStorageNativeModule();
    if (
      !nativeModule
      || typeof nativeModule.acquireProtectedStorageLeaseAsync !== 'function'
      || typeof nativeModule.releaseProtectedStorageLeaseAsync !== 'function'
    ) {
      throw new Error('The native protected-storage coordinator is unavailable.');
    }

    const leaseId = await nativeModule.acquireProtectedStorageLeaseAsync();
    if (!PROTECTED_STORAGE_LEASE_PATTERN.test(leaseId)) {
      throw new Error('The native protected-storage coordinator returned an invalid lease.');
    }

    try {
      return await operation();
    } finally {
      // A rejected release makes lock ownership ambiguous. Propagate it even if
      // the protected operation succeeded so production fails closed.
      await nativeModule.releaseProtectedStorageLeaseAsync(leaseId);
    }
  }
}

class WebStringStore implements AsyncStringStore {
  async getItem(key: string) {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  }

  async setItem(key: string, value: string) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, value);
  }

  async deleteItem(key: string) {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(key);
  }
}

class NativeSecureStoreBackend implements PhysicalStringStore {
  async getItem(key: string) {
    return SecureStore.getItemAsync(key);
  }

  async setItem(key: string, value: string) {
    await SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  async deleteItem(key: string) {
    await SecureStore.deleteItemAsync(key);
  }
}

const nativeSecureStringStore = new SizeSafeStringStore(
  new NativeSecureStoreBackend(),
  new NativeProtectedStorageExclusiveCoordinator(),
);

/**
 * Native values use the crash-consistent, size-bounded adapter over
 * Keychain/Keystore. Expo SecureStore has no web target, so the explicitly
 * development/demo-only browser build persists token-only profiles directly in
 * localStorage and warns that this is not OS-protected storage.
 */
export function createPlatformStringStore(): AsyncStringStore {
  return Platform.OS === 'web' ? new WebStringStore() : nativeSecureStringStore;
}
