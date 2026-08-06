import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CopyCheck,
  FileStack,
  LockKeyhole,
  RotateCw,
  ShieldCheck,
  Tags,
  Users,
  X,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { DocumentPdfPageEditor } from '@/components/document-pdf-page-editor';
import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n } from '@/i18n';
import { presentRuntimeError, presentRuntimeMessage } from '@/i18n/error-presentation';
import {
  buildAcceptedAiPatch,
  emptyAiCustomFieldSuggestionDecisions,
  emptyAiSuggestionDecisions,
  parseDocumentSecurity,
  scopeAiSuggestionsToVisibleCatalog,
  type AiCustomFieldSuggestionDecisions,
  type AiSuggestionDecision,
  type AiSuggestionDecisions,
  type AiSuggestionField,
  type DocumentSecuritySnapshot,
} from '@/lib/document-production';
import {
  extractDuplicateSummaries,
  normalizeNestedTags,
  selectVisibleNestedTags,
} from '@/lib/paperless-advanced';
import { usePaperlessAdvanced } from '@/lib/use-paperless-advanced';
import type { PaperlessClient } from '@/lib/paperless-client';
import type { DocumentItem, PaperlessCatalog } from '@/types/document';
import type {
  PaperlessAiSuggestions,
  PaperlessAsyncOperationResult,
  PaperlessDuplicateSummary,
  PaperlessPermissionSet,
  PaperlessTagHierarchy,
} from '@/types/paperless-advanced';

type WorkspaceTab = 'tags' | 'access' | 'duplicates' | 'suggestions' | 'pdf';
type Principal = { id: number; name: string };
type PdfAccessSnapshot = { ownerId: number | null; canChange: boolean };

type DocumentPaperless3WorkspaceProps = {
  catalog: PaperlessCatalog;
  document: DocumentItem;
  onClose: () => void;
  onNavigateDocument: (remoteId: number) => void;
  onOpenTasks: () => void;
  onRefresh: () => Promise<void>;
  onToast: (message: string, error?: boolean) => void;
  visible: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageResults(value: unknown) {
  if (Array.isArray(value)) return value;
  return isRecord(value) && Array.isArray(value.results) ? value.results : [];
}

function parsePrincipals(value: unknown): Principal[] {
  return pageResults(value).flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id)) return [];
    const name = [entry.first_name, entry.last_name]
      .filter((part): part is string => typeof part === 'string' && !!part.trim())
      .join(' ')
      || (typeof entry.name === 'string' ? entry.name : null)
      || (typeof entry.username === 'string' ? entry.username : null)
      || `ID ${entry.id}`;
    return [{ id: entry.id, name }];
  });
}

function parsePdfAccess(value: unknown, expectedDocumentId: number): PdfAccessSnapshot | null {
  if (
    !isRecord(value)
    || value.id !== expectedDocumentId
    || typeof value.user_can_change !== 'boolean'
    || (value.owner !== null && (
      typeof value.owner !== 'number'
      || !Number.isSafeInteger(value.owner)
      || value.owner <= 0
    ))
  ) {
    return null;
  }
  return { ownerId: value.owner, canChange: value.user_can_change };
}

async function listAllPrincipals(
  client: PaperlessClient,
  path: '/api/users/' | '/api/groups/',
  ordering: 'username' | 'name',
  signal: AbortSignal,
  errors: { invalid: string; pagination: string },
) {
  const collected: unknown[] = [];
  for (let page = 1; page <= 25; page += 1) {
    const response = await client.get<unknown>(
      `${path}?page_size=250&ordering=${ordering}&page=${page}`,
      signal,
    );
    if (!isRecord(response.data) || !Array.isArray(response.data.results)) {
      throw new Error(errors.invalid);
    }
    collected.push(...response.data.results);
    const total = typeof response.data.count === 'number' && Number.isSafeInteger(response.data.count)
      ? response.data.count
      : null;
    if (!response.data.next || total !== null && collected.length >= total) return parsePrincipals(collected);
  }
  throw new Error(errors.pagination);
}

function permissionClone(value: PaperlessPermissionSet): PaperlessPermissionSet {
  return {
    view: { users: [...value.view.users], groups: [...value.view.groups] },
    change: { users: [...value.change.users], groups: [...value.change.groups] },
  };
}

function toggleId(values: number[], id: number) {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

function readableError(error: unknown, fallback: string) {
  return presentRuntimeError(error, fallback);
}

function formatCustomFieldSuggestionValue(value: unknown, notSet: string) {
  if (value === null) return notSet;
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

export function DocumentPaperless3Workspace({
  catalog,
  document,
  onClose,
  onNavigateDocument,
  onOpenTasks,
  onRefresh,
  onToast,
  visible,
}: DocumentPaperless3WorkspaceProps) {
  const reducedMotion = useReducedMotion();
  const { formatList, formatNumber, t } = useI18n();
  const { credentials, documents, trackPaperlessPdfOperation } = useApp();
  const advanced = usePaperlessAdvanced();
  const controller = useRef<AbortController | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('tags');
  const [loading, setLoading] = useState(false);
  const [tagHierarchy, setTagHierarchy] = useState<PaperlessTagHierarchy | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [tagQuery, setTagQuery] = useState('');
  const [expandedTags, setExpandedTags] = useState<Set<number>>(new Set());
  const [security, setSecurity] = useState<DocumentSecuritySnapshot | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<PaperlessPermissionSet | null>(null);
  const [permissionMode, setPermissionMode] = useState<'merge' | 'replace'>('merge');
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [users, setUsers] = useState<Principal[]>([]);
  const [groups, setGroups] = useState<Principal[]>([]);
  const [duplicates, setDuplicates] = useState<PaperlessDuplicateSummary[]>([]);
  const [keptDuplicates, setKeptDuplicates] = useState<Set<number>>(new Set());
  const [suggestions, setSuggestions] = useState<PaperlessAiSuggestions | null>(null);
  const [suggestionWarnings, setSuggestionWarnings] = useState<string[]>([]);
  const [suggestionLabels, setSuggestionLabels] = useState<Partial<Record<AiSuggestionField, string>>>({});
  const [suggestionAcceptableFields, setSuggestionAcceptableFields] = useState<AiSuggestionField[]>([]);
  const [suggestionAcceptableCustomFieldIds, setSuggestionAcceptableCustomFieldIds] = useState<string[]>([]);
  const [suggestionDecisions, setSuggestionDecisions] = useState<AiSuggestionDecisions>(emptyAiSuggestionDecisions);
  const [customFieldSuggestionDecisions, setCustomFieldSuggestionDecisions] = useState<AiCustomFieldSuggestionDecisions>({});
  const [suggestedTitle, setSuggestedTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [operationResult, setOperationResult] = useState<PaperlessAsyncOperationResult | null>(null);
  const [pdfAccess, setPdfAccess] = useState<PdfAccessSnapshot | null>(null);

  const capabilities = advanced.phase === 'ready' ? advanced.capabilities : null;
  const advancedApi = advanced.phase === 'ready' ? advanced.api : null;
  const remoteId = document.remoteId;
  const pdfMimeType = document.mimeType?.split(';', 1)[0].trim().toLocaleLowerCase();
  const pdfSourceEligible = document.source === 'remote'
    && !!remoteId
    && pdfMimeType === 'application/pdf'
    && document.status !== 'processing'
    && document.pageCount > 0;
  const pdfChangeAuthorized = pdfSourceEligible
    && capabilities?.permissions.document.change === true
    && pdfAccess?.canChange === true;
  const pdfOwnerAuthorized = capabilities?.permissions.isSuperuser === true
    || !!pdfAccess && (
      pdfAccess.ownerId === null
      || pdfAccess.ownerId === capabilities?.permissions.currentUserId
    );
  const pdfSourceMutationAuthorized = pdfChangeAuthorized && pdfOwnerAuthorized;
  const pdfRotateEnabled = pdfSourceMutationAuthorized
    && capabilities?.features.pdf.rotate.supported === true;
  const pdfEditEnabled = pdfSourceMutationAuthorized
    && capabilities?.features.pdf.edit.supported === true;
  const pdfSplitEnabled = pdfEditEnabled
    && capabilities?.permissions.document.add === true;
  const pdfMergeEnabled = pdfChangeAuthorized
    && capabilities?.permissions.document.add === true
    && capabilities?.features.pdf.merge.supported === true;
  const pdfPasswordEnabled = pdfSourceMutationAuthorized
    && capabilities?.features.pdf.removePassword.supported === true;

  const loadWorkspace = useCallback(async () => {
    if (!advancedApi || !capabilities || !remoteId) return;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setPdfAccess(null);
    try {
      const fullPermissions = capabilities.features.fullPermissions.supported;
      const detail = await advancedApi.client.get<unknown>(
        `/api/documents/${remoteId}/${fullPermissions ? '?full_perms=true' : ''}`,
        nextController.signal,
      );
      let nextPdfAccess = parsePdfAccess(detail.data, remoteId);
      if (!nextPdfAccess && fullPermissions) {
        const accessDetail = await advancedApi.client.get<unknown>(
          `/api/documents/${remoteId}/`,
          nextController.signal,
        );
        nextPdfAccess = parsePdfAccess(accessDetail.data, remoteId);
      }
      setPdfAccess(nextPdfAccess);
      setDuplicates(extractDuplicateSummaries(detail.data));
      if (fullPermissions) {
        try {
          const parsed = parseDocumentSecurity(detail.data);
          setSecurity(parsed);
          setSecurityError(null);
          setPermissionDraft(permissionClone(parsed.permissions));
          setOwnerId(parsed.ownerId);
        } catch (error) {
          setSecurity(null);
          setPermissionDraft(null);
          setSecurityError(readableError(error, t('paperless3.actionFailed')));
        }
      }

      if (capabilities.features.nestedTags.supported) {
        const tagsResult = await advancedApi.listCatalog('tags', 'page_size=1000&ordering=name', nextController.signal);
        if (tagsResult.supported) {
          const hierarchy = normalizeNestedTags(tagsResult.value.results);
          if (hierarchy.valid) {
            setTagHierarchy(hierarchy.value);
            setTagError(null);
            const remoteTagIds = isRecord(detail.data) && Array.isArray(detail.data.tags)
              ? detail.data.tags.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id))
              : document.tagIds.flatMap((id) => {
                  const option = catalog.tags.find((tag) => tag.id === id);
                  return option?.remoteId ? [option.remoteId] : [];
                });
            setSelectedTagIds(remoteTagIds);
          } else {
            setTagHierarchy(null);
            setTagError(t('paperless3.unsafeHierarchy', {
              reason: hierarchy.errors[0]
                ? presentRuntimeMessage(hierarchy.errors[0].message)
                : t('paperless3.invalidHierarchy'),
            }));
          }
        }
      }

      const principalRequests: Promise<void>[] = [];
      if (capabilities.permissions.user.view === true) {
        principalRequests.push(
          listAllPrincipals(advancedApi.client, '/api/users/', 'username', nextController.signal, { invalid: t('paperless3.invalidPrincipals'), pagination: t('paperless3.principalLimit') })
            .then(setUsers),
        );
      }
      if (capabilities.permissions.group.view === true) {
        principalRequests.push(
          listAllPrincipals(advancedApi.client, '/api/groups/', 'name', nextController.signal, { invalid: t('paperless3.invalidPrincipals'), pagination: t('paperless3.principalLimit') })
            .then(setGroups),
        );
      }
      await Promise.all(principalRequests);
    } catch (error) {
      if (!nextController.signal.aborted) onToast(readableError(error, t('paperless3.actionFailed')), true);
    } finally {
      if (!nextController.signal.aborted) setLoading(false);
    }
  }, [advancedApi, capabilities, catalog.tags, document.tagIds, onToast, remoteId, t]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => void loadWorkspace());
    return () => {
      cancelAnimationFrame(frame);
      controller.current?.abort();
    };
  }, [loadWorkspace, visible]);

  const visibleTags = useMemo(() => {
    if (!tagHierarchy) return [];
    return selectVisibleNestedTags(tagHierarchy, tagQuery, expandedTags);
  }, [expandedTags, tagHierarchy, tagQuery]);

  const visibleDuplicates = useMemo(() => {
    const merged = new Map(duplicates.map((duplicate) => [duplicate.id, duplicate]));
    for (const duplicateId of document.duplicateDocumentIds ?? []) {
      if (!Number.isSafeInteger(duplicateId) || duplicateId <= 0 || duplicateId === remoteId || merged.has(duplicateId)) continue;
      merged.set(duplicateId, {
        id: duplicateId,
        title: documents.find((item) => item.remoteId === duplicateId)?.title || t('paperless3.existingDocument'),
        deletedAt: null,
        source: 'task',
      });
    }
    return [...merged.values()];
  }, [document.duplicateDocumentIds, documents, duplicates, remoteId, t]);

  async function saveTags() {
    if (advanced.phase !== 'ready' || !remoteId) return;
    setBusy('tags');
    try {
      await advanced.api.client.patch(`/api/documents/${remoteId}/`, { tags: selectedTagIds });
      const verified = await advanced.api.client.get<unknown>(`/api/documents/${remoteId}/`);
      const actual = isRecord(verified.data) && Array.isArray(verified.data.tags)
        ? verified.data.tags.filter((id): id is number => typeof id === 'number')
        : null;
      if (!actual || actual.length !== selectedTagIds.length || selectedTagIds.some((id) => !actual.includes(id))) {
        throw new Error(t('paperless3.tagVerificationFailed'));
      }
      onToast(t('paperless3.tagsSaved'));
      await onRefresh();
    } catch (error) {
      onToast(readableError(error, t('paperless3.actionFailed')), true);
    } finally {
      setBusy(null);
    }
  }

  async function savePermissions(confirmSelfLockout = false) {
    if (advanced.phase !== 'ready' || !remoteId || !security || !permissionDraft) return;
    setBusy('permissions');
    try {
      const result = await advanced.api.updateObjectPermissions('document', remoteId, {
        ownerId: security.ownerId,
        permissions: security.permissions,
        userCanChange: security.canChange,
      }, {
        ownerId,
        permissions: permissionDraft,
        mode: permissionMode,
        confirmSelfLockout,
      });
      if (!result.supported) {
        if (result.reason === 'self-lockout' && !confirmSelfLockout) {
          Alert.alert(
            t('paperless3.selfLockoutTitle'),
            t('paperless3.selfLockoutBody'),
            [
              { text: t('common.cancel'), style: 'cancel' },
              { text: t('paperless3.replaceAnyway'), style: 'destructive', onPress: () => void savePermissions(true) },
            ],
          );
          return;
        }
        throw new Error(result.detail ?? t('paperless3.permissionUnavailable', { reason: result.reason }));
      }
      setSecurity({ ownerId: result.value.ownerId, permissions: result.value.permissions, canChange: true });
      setPermissionDraft(permissionClone(result.value.permissions));
      onToast(t('paperless3.permissionsSaved'));
      await onRefresh();
    } catch (error) {
      onToast(readableError(error, t('paperless3.actionFailed')), true);
    } finally {
      setBusy(null);
    }
  }

  async function loadSuggestions() {
    if (advanced.phase !== 'ready' || !remoteId) return;
    setBusy('suggestions-load');
    try {
      const result = await advanced.api.getAiSuggestions(remoteId);
      if (!result.supported) throw new Error(result.detail ?? t('paperless3.suggestionsUnavailable', { reason: result.reason }));
      if (!result.value.valid) {
        throw new Error(result.value.errors[0]
          ? presentRuntimeMessage(result.value.errors[0].message)
          : t('paperless3.invalidSuggestions'));
      }
      const scoped = scopeAiSuggestionsToVisibleCatalog(
        result.value.value,
        catalog,
        document.canEdit !== false && capabilities?.permissions.document.change === true,
        remoteId,
      );
      setSuggestions(scoped.value);
      setSuggestedTitle(scoped.value.title ?? '');
      setSuggestionLabels(scoped.labels);
      setSuggestionAcceptableFields(scoped.acceptableFields);
      setSuggestionAcceptableCustomFieldIds(scoped.acceptableCustomFieldIds);
      setSuggestionWarnings([
        ...result.value.warnings.map((warning) => presentRuntimeMessage(warning.message)),
        ...scoped.warnings.map((warning) => presentRuntimeMessage(warning)),
      ]);
      setSuggestionDecisions(emptyAiSuggestionDecisions());
      setCustomFieldSuggestionDecisions(emptyAiCustomFieldSuggestionDecisions(scoped.value));
    } catch (error) {
      onToast(readableError(error, t('paperless3.actionFailed')), true);
    } finally {
      setBusy(null);
    }
  }

  async function applySuggestions() {
    if (advanced.phase !== 'ready' || !remoteId || !suggestions) return;
    setBusy('suggestions-save');
    try {
      const rescoped = scopeAiSuggestionsToVisibleCatalog(
        suggestions,
        catalog,
        document.canEdit !== false && advanced.capabilities.permissions.document.change === true,
        remoteId,
      );
      const disallowedAccepted = Object.entries(suggestionDecisions).flatMap(([field, decision]) => (
        decision === 'accepted' && !rescoped.acceptableFields.includes(field as AiSuggestionField)
          ? [field]
          : []
      ));
      if (disallowedAccepted.length) {
        throw new Error(t('paperless3.cannotApply', { fields: formatList(disallowedAccepted) }));
      }
      const acceptableCustomFields = new Set(rescoped.acceptableCustomFieldIds);
      const disallowedCustomFields = Object.entries(customFieldSuggestionDecisions).flatMap(([field, decision]) => (
        decision === 'accepted' && !acceptableCustomFields.has(field) ? [field] : []
      ));
      if (disallowedCustomFields.length) {
        throw new Error(t('paperless3.cannotApply', { fields: formatList(disallowedCustomFields) }));
      }
      const patch = buildAcceptedAiPatch(
        rescoped.value,
        suggestionDecisions,
        suggestedTitle,
        customFieldSuggestionDecisions,
      );
      await advanced.api.client.patch(`/api/documents/${remoteId}/`, patch);
      onToast(t('paperless3.suggestionsSaved'));
      await onRefresh();
    } catch (error) {
      onToast(readableError(error, t('paperless3.actionFailed')), true);
    } finally {
      setBusy(null);
    }
  }

  function setDecision(field: AiSuggestionField, decision: 'accepted' | 'dismissed') {
    setSuggestionDecisions((current) => ({ ...current, [field]: decision }));
  }

  function setCustomFieldDecision(field: string, decision: 'accepted' | 'dismissed') {
    setCustomFieldSuggestionDecisions((current) => ({ ...current, [field]: decision }));
  }

  async function runPdf(label: string, operation: () => Promise<{ supported: boolean; value?: PaperlessAsyncOperationResult; reason?: string; detail?: string }>) {
    if (!remoteId) return;
    setBusy(label);
    setOperationResult(null);
    try {
      const result = await operation();
      if (!result.supported || !result.value) throw new Error(result.detail ?? t('paperless3.operationUnavailable', { reason: result.reason ?? t('paperless3.unsupported') }));
      setOperationResult(result.value);
      try {
        // API v10 endpoints often return only `{"result":"OK"}`. The API
        // bridge correlates those requests against the authenticated task feed;
        // an unavailable correlation remains an explicit attention item.
        await trackPaperlessPdfOperation({
          documentId: remoteId,
          operation: label.replace(/-/g, ' '),
          paperlessTaskIds: result.value.taskIds,
        });
      } catch (trackingError) {
        onToast(
          t('paperless3.trackingFailed', { error: readableError(trackingError, t('paperless3.actionFailed')) }),
          true,
        );
        return;
      }
      onToast(result.value.taskCorrelation !== 'unavailable'
        ? t('paperless3.tracked', { count: formatNumber(result.value.taskIds.length) })
        : t('paperless3.untracked'));
    } catch (error) {
      onToast(readableError(error, t('paperless3.actionFailed')), true);
    } finally {
      setBusy(null);
    }
  }

  if (!remoteId) return null;

  const tabs: { id: WorkspaceTab; label: string; icon: typeof Tags }[] = [
    { id: 'tags', label: t('paperless3.tagsTab'), icon: Tags },
    { id: 'access', label: t('paperless3.accessTab'), icon: Users },
    { id: 'duplicates', label: t('paperless3.duplicatesTab'), icon: CopyCheck },
    { id: 'suggestions', label: t('paperless3.suggestionsTab'), icon: Bot },
    { id: 'pdf', label: t('paperless3.pdfTab'), icon: FileStack },
  ];

  return (
    <Modal animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <SafeAreaView edges={['top']} style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>{t('paperless3.title')}</Text>
            <Text numberOfLines={1} style={styles.subtitle}>{document.title}</Text>
          </View>
          <Pressable accessibilityLabel={t('paperless3.close')} onPress={onClose} style={styles.close}>
            <X color={palette.ink} size={20} />
          </Pressable>
        </View>
        <ScrollView
          accessibilityRole="tablist"
          horizontal
          contentContainerStyle={styles.tabs}
          showsHorizontalScrollIndicator={false}
          style={styles.tabScroller}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === id }}
              key={id}
              onPress={() => setTab(id)}
              style={[styles.tab, tab === id && styles.tabActive]}>
              <Icon color={tab === id ? palette.accentInk : palette.ink} size={16} />
              <Text style={[styles.tabText, tab === id && styles.tabTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {advanced.phase === 'loading' || loading ? (
            <CenterState copy={t('paperless3.loading')} loading />
          ) : advanced.phase !== 'ready' ? (
            <CenterState copy={advanced.error ? presentRuntimeMessage(advanced.error) : t('paperless3.connect')} />
          ) : tab === 'tags' ? (
            <>
              <SectionIntro title={t('paperless3.nestedTags')} copy={t('paperless3.nestedTagsCopy')} />
              {!capabilities?.features.nestedTags.supported ? <Unsupported status={capabilities?.features.nestedTags.detail} /> : tagError ? <Unsupported status={tagError} /> : !tagHierarchy ? <Unsupported status={t('paperless3.noHierarchy')} /> : (
                <>
                  <TextInput onChangeText={setTagQuery} placeholder={t('paperless3.searchTags')} placeholderTextColor={palette.faint} style={styles.input} value={tagQuery} />
                  <View style={styles.tree}>
                    {visibleTags.map((tag) => (
                      <View key={tag.id} style={[styles.tagRow, { paddingLeft: 12 + Math.min(tag.depth, 12) * 16 }]}>
                        {!!tag.childIds.length && (
                          <Pressable accessibilityLabel={t(expandedTags.has(tag.id) ? 'paperless3.collapseTag' : 'paperless3.expandTag', { name: tag.name })} onPress={() => setExpandedTags((current) => { const next = new Set(current); if (next.has(tag.id)) next.delete(tag.id); else next.add(tag.id); return next; })} style={styles.disclosure}>
                            {expandedTags.has(tag.id) || tagQuery ? <ChevronDown color={palette.muted} size={15} /> : <ChevronRight color={palette.muted} size={15} />}
                          </Pressable>
                        )}
                        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedTagIds.includes(tag.id) }} onPress={() => setSelectedTagIds((current) => toggleId(current, tag.id))} style={styles.tagChoice}>
                          <View style={[styles.checkbox, selectedTagIds.includes(tag.id) && styles.checkboxActive]}>{selectedTagIds.includes(tag.id) && <Check color={palette.accentInk} size={13} />}</View>
                          <View style={styles.flexCopy}>
                            <Text style={styles.rowTitle}>{tag.name}</Text>
                            <Text numberOfLines={1} style={styles.rowMeta}>{tag.pathLabel}{tag.isInboxTag ? ` · ${t('paperless3.inboxTag')}` : ''}</Text>
                          </View>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                  <PrimaryButton label={t('paperless3.saveTags')} loading={busy === 'tags'} onPress={() => void saveTags()} />
                </>
              )}
            </>
          ) : tab === 'access' ? (
            <>
              <SectionIntro title={t('paperless3.permissions')} copy={t('paperless3.permissionsCopy')} />
              {!capabilities?.features.fullPermissions.supported ? <Unsupported status={capabilities?.features.fullPermissions.detail} /> : !security || !permissionDraft ? <Unsupported status={securityError || t('paperless3.permissionsHidden')} /> : (
                <>
                  <Text style={styles.fieldLabel}>{t('paperless3.updateMode')}</Text>
                  <View style={styles.segmented}>
                    {(['merge', 'replace'] as const).map((mode) => <Pressable key={mode} onPress={() => setPermissionMode(mode)} style={[styles.segment, permissionMode === mode && styles.segmentActive]}><Text style={[styles.segmentText, permissionMode === mode && styles.segmentTextActive]}>{mode === 'merge' ? t('paperless3.mergeExisting') : t('paperless3.replacePermissions')}</Text></Pressable>)}
                  </View>
                  <Text style={styles.fieldLabel}>{t('paperless3.owner')}</Text>
                  <ScrollView horizontal contentContainerStyle={styles.choiceRow} showsHorizontalScrollIndicator={false}>
                    <ChoiceChip active={ownerId === null} label={t('paperless3.noOwner')} onPress={() => setOwnerId(null)} />
                    {catalog.owners.flatMap((owner) => owner.remoteId ? [<ChoiceChip active={ownerId === owner.remoteId} key={owner.id} label={owner.name} onPress={() => setOwnerId(owner.remoteId!)} />] : [])}
                  </ScrollView>
                  <PermissionPrincipals draft={permissionDraft} groups={groups} onChange={setPermissionDraft} users={users} />
                  {!users.length && !groups.length && <Text style={styles.notice}>{t('paperless3.principalsHidden')}</Text>}
                  <PrimaryButton label={permissionMode === 'merge' ? t('paperless3.mergeOwner') : t('paperless3.replaceOwner')} loading={busy === 'permissions'} onPress={() => void savePermissions()} />
                </>
              )}
            </>
          ) : tab === 'duplicates' ? (
            <>
              <SectionIntro title={t('paperless3.duplicateReview')} copy={t('paperless3.duplicateCopy')} />
              {!capabilities?.features.duplicateDocuments.supported && !visibleDuplicates.length ? <Unsupported status={capabilities?.features.duplicateDocuments.detail} /> : !visibleDuplicates.length ? <Empty copy={t('paperless3.noDuplicates')} /> : visibleDuplicates.map((duplicate) => {
                const candidate = documents.find((item) => item.remoteId === duplicate.id);
                return (
                  <View key={duplicate.id} style={styles.duplicateRow}>
                    <Text style={styles.rowMeta}>{t('paperless3.duplicateMeta', { id: duplicate.id, source: duplicate.source === 'task' ? t('paperless3.taskSignal') : t('paperless3.relationship'), deleted: duplicate.deletedAt ? ` · ${t('paperless3.deleted')}` : '' })}</Text>
                    <View style={styles.comparisonRow}>
                      <DuplicateComparisonCard document={document} label={t('paperless3.currentRecord')} />
                      <DuplicateComparisonCard document={candidate} fallbackTitle={duplicate.title} label={t('paperless3.possibleDuplicate')} />
                    </View>
                    <View style={styles.duplicateActions}>
                      <Pressable disabled={!!duplicate.deletedAt} onPress={() => onNavigateDocument(duplicate.id)} style={styles.smallButton}><Text style={styles.smallButtonText}>{t('paperless3.open')}</Text></Pressable>
                      <Pressable onPress={() => setKeptDuplicates((current) => new Set(current).add(duplicate.id))} style={styles.smallButton}><Text style={styles.smallButtonText}>{keptDuplicates.has(duplicate.id) ? t('paperless3.kept') : t('paperless3.keepBoth')}</Text></Pressable>
                    </View>
                  </View>
                );
              })}
            </>
          ) : tab === 'suggestions' ? (
            <>
              <SectionIntro title={t('paperless3.serverSuggestions')} copy={t('paperless3.serverSuggestionsCopy')} />
              {!capabilities?.features.aiSuggestions.supported ? <Unsupported status={capabilities?.features.aiSuggestions.detail} /> : !suggestions ? <PrimaryButton label={t('paperless3.loadSuggestions')} loading={busy === 'suggestions-load'} onPress={() => void loadSuggestions()} /> : (
                <>
                  {!!suggestionWarnings.length && <View style={styles.warning}><Text style={styles.warningText}>{suggestionWarnings.join(' ')}</Text></View>}
                  <SuggestionRow canAccept={suggestionAcceptableFields.includes('title')} decision={suggestionDecisions.title} field="title" label={t('paperless3.suggestionTitle')} onDecision={setDecision}>
                    <TextInput maxLength={128} onChangeText={setSuggestedTitle} style={styles.input} value={suggestedTitle} />
                  </SuggestionRow>
                  <SuggestionRow canAccept={suggestionAcceptableFields.includes('tags')} decision={suggestionDecisions.tags} field="tags" label={t('paperless3.existingTags')} onDecision={setDecision} value={suggestionLabels.tags || t('paperless3.noVisibleTag')} proposed={suggestions.proposedTags} />
                  <SuggestionRow canAccept={suggestionAcceptableFields.includes('correspondent')} decision={suggestionDecisions.correspondent} field="correspondent" label={t('paperless3.existingCorrespondent')} onDecision={setDecision} value={suggestionLabels.correspondent || t('paperless3.noVisibleCorrespondent')} proposed={suggestions.proposedCorrespondents} />
                  <SuggestionRow canAccept={suggestionAcceptableFields.includes('documentType')} decision={suggestionDecisions.documentType} field="documentType" label={t('paperless3.existingDocumentType')} onDecision={setDecision} value={suggestionLabels.documentType || t('paperless3.noVisibleDocumentType')} proposed={suggestions.proposedDocumentTypes} />
                  <SuggestionRow canAccept={suggestionAcceptableFields.includes('storagePath')} decision={suggestionDecisions.storagePath} field="storagePath" label={t('paperless3.existingStoragePath')} onDecision={setDecision} value={suggestionLabels.storagePath || t('paperless3.noVisibleStoragePath')} proposed={suggestions.proposedStoragePaths} />
                  <SuggestionRow canAccept={suggestionAcceptableFields.includes('date')} decision={suggestionDecisions.date} field="date" label={t('paperless3.createdDate')} onDecision={setDecision} value={suggestions.dates[0] || t('common.notAvailable')} />
                  {Object.entries(suggestions.customFields).map(([fieldId, value]) => {
                    const definition = catalog.customFields.find((field) => String(field.remoteId) === fieldId);
                    return (
                      <SuggestionRow
                        canAccept={suggestionAcceptableCustomFieldIds.includes(fieldId)}
                        decision={customFieldSuggestionDecisions[fieldId] ?? 'pending'}
                        field={fieldId}
                        key={fieldId}
                        label={`${t('paperless3.customFields')} · ${definition?.name ?? fieldId}`}
                        onDecision={setCustomFieldDecision}
                        value={formatCustomFieldSuggestionValue(value, t('metadata.notSet'))}
                      />
                    );
                  })}
                  <Text style={styles.notice}>{t('paperless3.proposedNotice')}</Text>
                  <PrimaryButton label={t('paperless3.saveAccepted')} loading={busy === 'suggestions-save'} onPress={() => void applySuggestions()} />
                </>
              )}
            </>
          ) : (
            <>
              <SectionIntro title={t('paperless3.pdfOperations')} copy={t('paperless3.pdfOperationsCopy')} />
              <PdfCapability label={t('paperless3.rotate90')} supported={pdfRotateEnabled} detail={capabilities?.features.pdf.rotate.detail}>
                <PrimaryButton compact icon={RotateCw} label={t('paperless3.rotateDocument')} loading={busy === 'rotate'} onPress={() => void runPdf('rotate', () => advanced.api.rotateDocuments({ documentIds: [remoteId], degrees: 90 }))} />
              </PdfCapability>
              <PdfCapability
                label={t('paperless3.pageEditorTitle')}
                supported={pdfEditEnabled || pdfMergeEnabled}
                detail={capabilities?.features.pdf.edit.detail || capabilities?.features.pdf.merge.detail}>
                {credentials ? (
                  <DocumentPdfPageEditor
                    busy={busy === 'page-edit' || busy === 'split' || busy === 'merge'}
                    credentials={credentials}
                    document={document}
                    documents={documents}
                    editEnabled={pdfEditEnabled}
                    editUnavailableDetail={capabilities?.features.pdf.edit.detail || t('paperless3.notAdvertisedPdf')}
                    mergeEnabled={pdfMergeEnabled}
                    onApply={(plan) => void runPdf(
                      plan.hasSplits ? 'split' : 'page-edit',
                      () => advanced.api.editPdf({
                        documentId: remoteId,
                        operations: plan.operations,
                        updateDocument: !plan.hasSplits,
                        includeMetadata: true,
                        sourceMode: 'latest_version',
                      }),
                    )}
                    onMerge={(documentIds) => void runPdf('merge', () => advanced.api.mergeDocuments({
                      documentIds,
                      metadataDocumentId: remoteId,
                      deleteOriginals: false,
                      archiveFallback: false,
                      sourceMode: 'latest_version',
                    }))}
                    splitEnabled={pdfSplitEnabled}
                  />
                ) : <Text style={styles.rowMeta}>{t('paperless3.connect')}</Text>}
              </PdfCapability>
              <PdfCapability label={t('paperless3.removePassword')} supported={pdfPasswordEnabled} detail={capabilities?.features.pdf.removePassword.detail}>
                <TextInput onChangeText={setPassword} placeholder={t('paperless3.passwordPlaceholder')} placeholderTextColor={palette.faint} secureTextEntry style={styles.input} value={password} />
                <PrimaryButton compact icon={LockKeyhole} label={t('paperless3.createUnlocked')} loading={busy === 'password'} onPress={() => void runPdf('password', () => advanced.api.removePdfPassword({ documentId: remoteId, password, updateDocument: true, includeMetadata: true }))} />
              </PdfCapability>
              {!!operationResult && (
                <View accessibilityLiveRegion="polite" style={styles.operationResult}>
                  <ShieldCheck color={palette.limeDark} size={19} />
                  <View style={styles.flexCopy}>
                    <Text style={styles.rowTitle}>{t('paperless3.serverAccepted')}</Text>
                    <Text style={styles.rowMeta}>{operationResult.taskIds.length ? t('paperless3.taskIds', { ids: formatList(operationResult.taskIds) }) : t('paperless3.noTaskId')}</Text>
                  </View>
                  <Pressable onPress={onOpenTasks} style={styles.smallButton}><Text style={styles.smallButtonText}>{t('paperless3.tasks')}</Text></Pressable>
                  <Pressable onPress={() => void onRefresh()} style={styles.smallButton}><Text style={styles.smallButtonText}>{t('paperless3.refresh')}</Text></Pressable>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function CenterState({ copy, loading }: { copy: string; loading?: boolean }) { return <View style={styles.center}>{loading && <ActivityIndicator color={palette.limeDark} />}<Text style={styles.centerCopy}>{copy}</Text></View>; }
function SectionIntro({ title, copy }: { title: string; copy: string }) { return <View style={styles.intro}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionCopy}>{copy}</Text></View>; }
function Unsupported({ status }: { status?: string }) { const { t } = useI18n(); return <View style={styles.unavailable}><Text style={styles.unavailableTitle}>{t('paperless3.unavailable')}</Text><Text style={styles.unavailableCopy}>{status ? presentRuntimeMessage(status) : t('paperless3.notAdvertised')}</Text></View>; }
function Empty({ copy }: { copy: string }) { return <Text style={styles.empty}>{copy}</Text>; }
function ChoiceChip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.choiceChip, active && styles.choiceChipActive]}><Text numberOfLines={1} style={styles.choiceChipText}>{label}</Text></Pressable>; }

function DuplicateComparisonCard({ document, fallbackTitle, label }: { document?: DocumentItem; fallbackTitle?: string; label: string }) {
  const { formatDocumentDate, formatNumber, t } = useI18n();
  return (
    <View style={styles.comparisonCard}>
      <Text style={styles.comparisonLabel}>{label}</Text>
      <Text numberOfLines={2} style={styles.rowTitle}>{document?.title ?? fallbackTitle}</Text>
      <Text numberOfLines={2} style={styles.rowMeta}>
        {document
          ? `${formatDocumentDate(document.created)} · ${document.documentType} · ${formatNumber(document.pageCount)} ${t('paperless3.pagesShort')}`
          : t('paperless3.metadataUnavailable')}
      </Text>
      {!!document?.correspondent && <Text numberOfLines={1} style={styles.rowMeta}>{document.correspondent}</Text>}
    </View>
  );
}

function PrimaryButton({ compact, destructive, icon: Icon, label, loading, onPress }: { compact?: boolean; destructive?: boolean; icon?: typeof Check; label: string; loading?: boolean; onPress: () => void }) {
  return <Pressable disabled={loading} onPress={onPress} style={[styles.primary, compact && styles.primaryCompact, destructive && styles.primaryDestructive]}>{loading ? <ActivityIndicator color={destructive ? palette.paper : palette.accentInk} size="small" /> : Icon ? <Icon color={destructive ? palette.paper : palette.accentInk} size={17} /> : null}<Text style={[styles.primaryText, destructive && styles.primaryTextDestructive]}>{label}</Text></Pressable>;
}

function PermissionPrincipals({ draft, groups, onChange, users }: { draft: PaperlessPermissionSet; groups: Principal[]; onChange: (value: PaperlessPermissionSet) => void; users: Principal[] }) {
  const { t } = useI18n();
  const render = (principal: Principal, kind: 'users' | 'groups') => (
    <View key={`${kind}-${principal.id}`} style={styles.principalRow}>
      <View style={styles.flexCopy}><Text style={styles.rowTitle}>{principal.name}</Text><Text style={styles.rowMeta}>{kind === 'users' ? t('paperless3.user') : t('paperless3.group')} · ID {principal.id}</Text></View>
      {(['view', 'change'] as const).map((level) => {
        const active = draft[level][kind].includes(principal.id);
        return <Pressable key={level} onPress={() => onChange({ ...draft, [level]: { ...draft[level], [kind]: toggleId(draft[level][kind], principal.id) } })} style={[styles.permissionChip, active && styles.permissionChipActive]}><Text style={[styles.permissionText, active && styles.permissionTextActive]}>{t(level === 'view' ? 'paperless3.viewPermission' : 'paperless3.changePermission')}</Text></Pressable>;
      })}
    </View>
  );
  return <View style={styles.principalList}>{users.map((principal) => render(principal, 'users'))}{groups.map((principal) => render(principal, 'groups'))}</View>;
}

function SuggestionRow<Field extends string>({ canAccept, children, decision, field, label, onDecision, proposed = [], value }: { canAccept: boolean; children?: React.ReactNode; decision: AiSuggestionDecision; field: Field; label: string; onDecision: (field: Field, decision: 'accepted' | 'dismissed') => void; proposed?: string[]; value?: string }) {
  const { formatList, t } = useI18n();
  return <View style={styles.suggestion}><Text style={styles.fieldLabel}>{label}</Text>{children ?? <Text style={styles.suggestionValue}>{value}</Text>}{!!proposed.length && <Text style={styles.proposed}>{t('paperless3.proposedNew', { names: formatList(proposed) })}</Text>}<View style={styles.suggestionActions}><Pressable disabled={!canAccept} onPress={() => onDecision(field, 'accepted')} style={[styles.decision, decision === 'accepted' && styles.decisionAccept, !canAccept && styles.pdfDisabled]}><Text style={[styles.decisionText, decision === 'accepted' && styles.decisionTextAccepted]}>{canAccept ? t('paperless3.accept') : t('paperless3.cannotAccept')}</Text></Pressable><Pressable onPress={() => onDecision(field, 'dismissed')} style={[styles.decision, decision === 'dismissed' && styles.decisionDismiss]}><Text style={styles.decisionText}>{t('paperless3.dismiss')}</Text></Pressable></View></View>;
}

function PdfCapability({ children, detail, label, supported }: { children: React.ReactNode; detail?: string; label: string; supported: boolean }) { const { t } = useI18n(); return <View style={[styles.pdfBlock, !supported && styles.pdfDisabled]}><Text style={styles.rowTitle}>{label}</Text>{supported ? children : <Text style={styles.rowMeta}>{detail ? presentRuntimeMessage(detail) : t('paperless3.notAdvertisedPdf')}</Text>}</View>; }

const styles = createThemedStyleSheet({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 11, borderBottomWidth: 1, borderColor: palette.line },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 23, fontWeight: '600' },
  subtitle: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 3 },
  close: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.paper },
  tabScroller: { flexGrow: 0, flexShrink: 0 },
  tabs: { alignItems: 'center', gap: 7, paddingHorizontal: 16, paddingVertical: 10 },
  tab: { flexShrink: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 13, borderRadius: radii.pill, backgroundColor: palette.paper },
  tabActive: { backgroundColor: palette.lime },
  tabText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  tabTextActive: { color: palette.accentInk },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 20, paddingBottom: 50 },
  center: { minHeight: 280, alignItems: 'center', justifyContent: 'center', gap: 12 },
  centerCopy: { maxWidth: 360, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  intro: { marginBottom: 18 },
  sectionTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 25, fontWeight: '600' },
  sectionCopy: { maxWidth: 620, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 19, marginTop: 7 },
  unavailable: { padding: 16, borderRadius: radii.md, backgroundColor: palette.paper },
  unavailableTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  unavailableCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 17, marginTop: 5 },
  empty: { color: palette.muted, fontFamily: fonts.sans, fontSize: 12, paddingVertical: 18 },
  input: { minHeight: 50, color: palette.ink, fontFamily: fonts.sans, fontSize: 16, paddingHorizontal: 13, borderRadius: radii.md, backgroundColor: palette.paper, marginTop: 8 },
  inputHelper: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, marginTop: 5 },
  tree: { overflow: 'hidden', borderRadius: radii.md, backgroundColor: palette.paper, marginTop: 10 },
  tagRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: palette.line, paddingRight: 12 },
  disclosure: { width: 34, height: 44, alignItems: 'center', justifyContent: 'center' },
  tagChoice: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  checkbox: { width: 21, height: 21, alignItems: 'center', justifyContent: 'center', borderRadius: 7, borderWidth: 1, borderColor: palette.lineStrong },
  checkboxActive: { borderColor: palette.lime, backgroundColor: palette.lime },
  flexCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  rowMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, lineHeight: 14, marginTop: 3 },
  primary: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, borderRadius: radii.md, backgroundColor: palette.lime, marginTop: 16 },
  primaryCompact: { alignSelf: 'flex-start', minHeight: 44, marginTop: 10 },
  primaryDestructive: { backgroundColor: palette.danger },
  primaryText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  primaryTextDestructive: { color: palette.paper },
  fieldLabel: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900', marginTop: 12, marginBottom: 7 },
  segmented: { flexDirection: 'row', gap: 7 },
  segment: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, borderRadius: radii.md, backgroundColor: palette.paper },
  segmentActive: { backgroundColor: palette.lime },
  segmentText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900', textAlign: 'center' },
  segmentTextActive: { color: palette.accentInk },
  choiceRow: { gap: 7, paddingVertical: 2 },
  choiceChip: { maxWidth: 190, minHeight: 40, justifyContent: 'center', paddingHorizontal: 13, borderRadius: radii.pill, backgroundColor: palette.paper },
  choiceChipActive: { backgroundColor: palette.mint },
  choiceChipText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '800' },
  principalList: { gap: 7, marginTop: 14 },
  principalRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 7, padding: 10, borderRadius: radii.md, backgroundColor: palette.paper },
  permissionChip: { minWidth: 54, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radii.pill, backgroundColor: palette.canvas },
  permissionChipActive: { backgroundColor: palette.lime },
  permissionText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  permissionTextActive: { color: palette.accentInk },
  notice: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, lineHeight: 16, marginTop: 13 },
  duplicateRow: { gap: 9, padding: 11, borderRadius: radii.md, backgroundColor: palette.paper, marginBottom: 8 },
  comparisonRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  comparisonCard: { flex: 1, minWidth: 0, padding: 10, borderRadius: radii.sm, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paperStrong },
  comparisonLabel: { color: palette.muted, fontFamily: fonts.sans, fontSize: 8, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 5 },
  duplicateActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 7 },
  smallButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 11, backgroundColor: palette.canvas },
  smallButtonText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  warning: { padding: 12, borderRadius: radii.md, backgroundColor: palette.dangerSurface, marginBottom: 10 },
  warningText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 10, lineHeight: 16 },
  suggestion: { padding: 13, borderRadius: radii.md, backgroundColor: palette.paper, marginBottom: 9 },
  suggestionValue: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12 },
  proposed: { color: palette.danger, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15, marginTop: 7 },
  suggestionActions: { flexDirection: 'row', gap: 7, marginTop: 10 },
  decision: { minHeight: 37, justifyContent: 'center', paddingHorizontal: 13, borderRadius: radii.pill, backgroundColor: palette.canvas },
  decisionAccept: { backgroundColor: palette.lime },
  decisionDismiss: { backgroundColor: palette.rose },
  decisionText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  decisionTextAccepted: { color: palette.accentInk },
  pdfBlock: { padding: 14, borderRadius: radii.md, backgroundColor: palette.paper, marginBottom: 10 },
  pdfDisabled: { opacity: 0.5 },
  operationResult: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13, borderRadius: radii.md, backgroundColor: palette.mint, marginTop: 8 },
});
