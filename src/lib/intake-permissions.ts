import type { PaperlessCreationCapabilities } from '../types/document.ts';

export function intakePermissionState(capabilities: PaperlessCreationCapabilities) {
  const canUpload = capabilities.uploadDocument !== false;
  return {
    canUpload,
    canAssignOwner: canUpload && capabilities.assignOwner !== false,
    canQuickCreate: {
      tag: canUpload && capabilities.tag === true,
      correspondent: canUpload && capabilities.correspondent === true,
      documentType: canUpload && capabilities.documentType === true,
    },
  };
}
