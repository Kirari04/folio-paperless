import { getFolioPlatformNativeModule } from '../folio-platform-native';
import {
  verifyNativeOidcRs256,
  type NativeOidcRs256Input,
} from '../os-search-native-adapter';

export function isNativeOidcRs256Available(): boolean {
  return typeof getFolioPlatformNativeModule()?.verifyOidcRs256Async === 'function';
}

export async function verifyOidcRs256Natively(
  input: NativeOidcRs256Input,
): Promise<boolean> {
  return verifyNativeOidcRs256(getFolioPlatformNativeModule(), input);
}
