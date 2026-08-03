import { Check, ChevronLeft, Copy, Pencil, Plus, Save, Trash2 } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { IntakeRejectionList } from '@/components/intake-rejection-list';
import { fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n, type TranslationKey } from '@/i18n';
import { presentRuntimeError } from '@/i18n/error-presentation';
import { sanitizeIntakeFilename } from '@/lib/intake';
import { intakePermissionState } from '@/lib/intake-permissions';
import {
  applyUploadPreset,
  lastUsedCreatedDateForPreset,
  parseDocumentLinkInput,
  stalePresetReferences,
  uploadMetadataFieldProvenance,
  validateUploadMetadata,
} from '@/lib/upload-metadata';
import { useLocalSearchParams, useRouter } from '@/lib/router';
import type { PaperlessOption } from '@/types/document';
import {
  UPLOAD_PRESET_SCHEMA_VERSION,
  defaultUploadMetadataDraft,
  type ExplicitValue,
  type IntakeSource,
  type UploadPresetCreatedDate,
  type UploadMetadataDraft,
  type UploadPreset,
} from '@/types/tasks';

const uploadFieldLabelKeys: Record<keyof UploadMetadataDraft, TranslationKey> = {
  title: 'intake.title',
  created: 'intake.createdDate',
  correspondent: 'intake.correspondent',
  documentType: 'intake.documentType',
  tags: 'intake.tags',
  storagePath: 'intake.storagePath',
  archiveSerialNumber: 'intake.archiveSerial',
  owner: 'intake.owner',
  workflow: 'intake.workflow',
  customFields: 'intake.customFields',
};

function replaceField<K extends keyof UploadMetadataDraft>(
  draft: UploadMetadataDraft,
  key: K,
  value: UploadMetadataDraft[K],
) {
  return { ...draft, [key]: value };
}

function optionValue(option?: PaperlessOption): ExplicitValue<PaperlessOption> {
  return option ? { state: 'value', value: option } : { state: 'unset' };
}

function OptionPicker({
  disabled,
  label,
  options,
  quickCreate,
  value,
  onChange,
}: {
  disabled?: boolean;
  label: string;
  options: PaperlessOption[];
  quickCreate?: (name: string) => Promise<PaperlessOption>;
  value: ExplicitValue<PaperlessOption>;
  onChange: (value: ExplicitValue<PaperlessOption>) => void;
}) {
  const { t } = useI18n();
  return (
    <View style={[styles.fieldBlock, disabled && styles.disabled]}>
      <Text style={styles.label}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ disabled, selected: value.state === 'unset' }}
          disabled={disabled}
          onPress={() => onChange({ state: 'unset' })}
          style={[styles.chip, value.state === 'unset' && styles.chipSelected]}>
          <Text style={[styles.chipText, value.state === 'unset' && styles.chipTextSelected]}>
            {t('intake.paperlessDecide')}
          </Text>
        </Pressable>
        {options.map((option) => {
          const selected = value.state === 'value' && value.value.id === option.id;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ disabled, selected }}
              disabled={disabled}
              key={option.id}
              onPress={() => onChange(optionValue(option))}
              style={[styles.chip, selected && styles.chipSelected]}>
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {!!quickCreate && !disabled && (
        <QuickCreateOption
          label={label}
          onCreate={quickCreate}
          onCreated={(option) => onChange(optionValue(option))}
        />
      )}
    </View>
  );
}

function QuickCreateOption({
  label,
  onCreate,
  onCreated,
}: {
  label: string;
  onCreate: (name: string) => Promise<PaperlessOption>;
  onCreated: (option: PaperlessOption) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const normalized = name.trim();
    if (!normalized || busy) return;
    setBusy(true);
    setError(null);
    try {
      const option = await onCreate(normalized);
      onCreated(option);
      setName('');
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('catalogEditor.saveError')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.quickCreateBlock}>
      <View style={styles.quickCreateRow}>
        <TextInput
          accessibilityLabel={t('catalogEditor.createLabel', { label })}
          editable={!busy}
          onChangeText={setName}
          placeholder={t('catalogEditor.createLabel', { label })}
          placeholderTextColor={palette.faint}
          style={[styles.input, styles.quickCreateInput]}
          value={name}
        />
        <Pressable
          accessibilityLabel={t('catalogEditor.createLabel', { label })}
          accessibilityState={{ disabled: busy || !name.trim() }}
          disabled={busy || !name.trim()}
          onPress={() => void create()}
          style={[styles.quickCreateButton, (busy || !name.trim()) && styles.disabled]}>
          {busy
            ? <ActivityIndicator color={palette.accentInk} size="small" />
            : <Plus color={palette.accentInk} size={18} />}
        </Pressable>
      </View>
      {!!error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>}
    </View>
  );
}

function titleValue(draft: UploadMetadataDraft) {
  return draft.title.state === 'value' ? draft.title.value : '';
}

function dateValue(draft: UploadMetadataDraft) {
  return draft.created.state === 'value' ? draft.created.value : '';
}

function asnValue(draft: UploadMetadataDraft) {
  return draft.archiveSerialNumber.state === 'value'
    ? String(draft.archiveSerialNumber.value)
    : '';
}

export default function IntakeScreen() {
  const router = useRouter();
  const { formatList, formatNumber, t } = useI18n();
  const { batchId } = useLocalSearchParams<{ batchId?: string }>();
  const {
    activeProfile,
    catalog,
    creationCapabilities,
    intakeRejectionBatches,
    tasks,
    uploadPresets,
    createCatalogOption,
    updateUploadTask,
    submitUploadTasks,
    saveUploadPreset,
    deleteUploadPreset,
    dismissIntakeRejectionBatch,
  } = useApp();
  const batch = useMemo(() => tasks.filter((task) => {
    const editable = task.kind === 'upload'
      && (task.stage === 'preparing' || task.stage === 'queued' || task.stage === 'failed');
    return editable && (batchId ? task.batchId === batchId : task.stage === 'preparing')
      && !!task.localUri
      && !!task.metadata;
  }), [batchId, tasks]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, UploadMetadataDraft>>({});
  const [presetName, setPresetName] = useState('');
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetCreatedDate, setPresetCreatedDate] = useState<UploadPresetCreatedDate>('paperless');
  const [presetFilenameTitle, setPresetFilenameTitle] = useState<UploadPreset['filenameTitle']>('sanitized');
  const [presetAutoSubmit, setPresetAutoSubmit] = useState(false);
  const [presetDefaults, setPresetDefaults] = useState<Exclude<IntakeSource, 'unknown'>[]>([]);
  const [selectedPresetIds, setSelectedPresetIds] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoSubmitPrompts = useRef(new Set<string>());
  const {
    canUpload: uploadAllowed,
    canAssignOwner: ownerAssignmentAllowed,
    canQuickCreate,
  } =
    intakePermissionState(creationCapabilities);
  const rejectionBatch = useMemo(() => intakeRejectionBatches.find((notice) => (
    notice.batchId === batchId && notice.profileId === activeProfile?.id
  )), [activeProfile?.id, batchId, intakeRejectionBatches]);

  function chooseOtherFiles() {
    if (rejectionBatch) dismissIntakeRejectionBatch(rejectionBatch.batchId);
    router.replace('/scan');
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!selectedId && batch[0]) setSelectedId(batch[0].id);
      setDrafts((current) => {
        const next = { ...current };
        batch.forEach((task) => {
          if (!next[task.id] && task.metadata) next[task.id] = task.metadata;
        });
        return next;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [batch, selectedId]);

  useEffect(() => {
    const changed = batch.filter((task) => {
      const metadata = drafts[task.id];
      if (!metadata) return false;
      const presetId = selectedPresetIds[task.id] ?? task.presetId;
      return JSON.stringify(metadata) !== JSON.stringify(task.metadata)
        || presetId !== task.presetId;
    });
    if (!changed.length) return;
    const timer = setTimeout(() => {
      void Promise.all(changed.map((task) => updateUploadTask(
        task.id,
        drafts[task.id],
        selectedPresetIds[task.id] ?? task.presetId,
      ))).catch((nextError) => {
        setError(presentRuntimeError(nextError, t('intake.submitError')));
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [batch, drafts, selectedPresetIds, t, updateUploadTask]);

  const selected = batch.find((task) => task.id === selectedId) ?? batch[0];
  const draft = selected ? drafts[selected.id] ?? selected.metadata : undefined;
  const activeUploadPresets = useMemo(
    () => uploadPresets.filter((preset) => preset.profileId === activeProfile?.id),
    [activeProfile?.id, uploadPresets],
  );
  const effectivePresetId = selected
    ? selectedPresetIds[selected.id] ?? selected.presetId
    : undefined;
  const selectedPreset = activeUploadPresets.find((preset) => preset.id === effectivePresetId);

  useEffect(() => {
    if (!batch.length || batch.some((task) => task.stage !== 'preparing')) return;
    const presetId = batch[0].presetId;
    if (!presetId || batch.some((task) => task.presetId !== presetId)) return;
    const preset = activeUploadPresets.find((candidate) => candidate.id === presetId);
    const source = batch[0].source;
    if (source === 'unknown' || !preset?.autoSubmit || !preset.defaultFor?.includes(source)) return;
    const promptKey = `${batch[0].batchId ?? batch[0].id}:${preset.id}`;
    if (autoSubmitPrompts.current.has(promptKey)) return;
    autoSubmitPrompts.current.add(promptKey);
    Alert.alert(t('intake.autoSubmitConfirmTitle'), t('intake.autoSubmitConfirmBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: batch.length === 1
          ? t('intake.queueOne')
          : t('intake.queueMany', { count: formatNumber(batch.length) }),
        onPress: () => {
          setBusy(true);
          void submitUploadTasks(batch.map((task) => task.id))
            .then(() => router.replace('/tasks'))
            .catch((nextError) => setError(
              presentRuntimeError(nextError, t('intake.submitError')),
            ))
            .finally(() => setBusy(false));
        },
      },
    ]);
  }, [activeUploadPresets, batch, formatNumber, router, submitUploadTasks, t]);
  const presetProvenance = (() => {
    if (!selected || !draft || !selectedPreset) return null;
    const sanitizedTitle = sanitizeIntakeFilename(selected.originalName ?? '')
      .replace(/\.[^.]+$/, '');
    const selectedThisSession = Object.prototype.hasOwnProperty.call(selectedPresetIds, selected.id);
    const inherited = applyUploadPreset(
      defaultUploadMetadataDraft(sanitizedTitle),
      selectedPreset,
      {
        originalName: selected.originalName ?? '',
        lastUsedDate: lastUsedCreatedDateForPreset(
          tasks.filter((task) => task.id !== selected.id),
          selectedPreset.id,
        ),
        today: selectedThisSession
          ? new Date().toISOString().slice(0, 10)
          : selected.createdAt.slice(0, 10),
      },
    );
    return uploadMetadataFieldProvenance(draft, inherited);
  })();

  const attachedPresetError = (() => {
    if (!selected?.presetId) return null;
    const preset = activeUploadPresets.find((item) => item.id === selected.presetId);
    if (!preset) {
      return t('intake.missingPreset');
    }
    const stale = stalePresetReferences(preset, catalog);
    return stale.length
      ? t('intake.repairPreset', { references: formatList(stale.map(String)) })
      : null;
  })();
  const displayedError = error ?? attachedPresetError;

  function updateSelected(next: UploadMetadataDraft) {
    if (!selected) return;
    setDrafts((current) => ({ ...current, [selected.id]: next }));
  }

  function applyToAll() {
    if (!draft) return;
    setDrafts((current) => Object.fromEntries(batch.map((task) => {
      const existing = current[task.id] ?? task.metadata!;
      return [task.id, {
        ...draft,
        title: existing.title,
        archiveSerialNumber: existing.archiveSerialNumber,
      }];
    })));
    void hapticFeedback('medium');
  }

  function selectPreset(preset: UploadPreset, allowAutoSubmit = true) {
    if (!activeProfile || preset.profileId !== activeProfile.id) {
      setError(t('intake.otherProfile'));
      return;
    }
    const stale = stalePresetReferences(preset, catalog);
    if (stale.length) {
      setError(t('intake.repairPreset', { references: formatList(stale.map(String)) }));
      return;
    }
    if (!selected || !draft) return;
    const next = {
      ...applyUploadPreset(draft, preset, {
        originalName: selected.originalName ?? '',
        lastUsedDate: lastUsedCreatedDateForPreset(
          tasks.filter((task) => task.id !== selected.id),
          preset.id,
        ),
      }),
      archiveSerialNumber: draft.archiveSerialNumber,
    };
    const issues = validateUploadMetadata(next, { catalog });
    if (issues.length) {
      setError(issues.map((issue) => issue.message).join(' '));
      return;
    }
    setDrafts((current) => ({ ...current, [selected.id]: next }));
    setSelectedPresetIds((current) => ({ ...current, [selected.id]: preset.id }));
    setError(null);
    if (preset.autoSubmit && allowAutoSubmit) {
      autoSubmitPrompts.current.add(`${selected.batchId ?? selected.id}:${preset.id}`);
      Alert.alert(t('intake.autoSubmitConfirmTitle'), t('intake.autoSubmitConfirmBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('intake.queueOne'),
          onPress: () => {
            setBusy(true);
            void updateUploadTask(selected.id, next, preset.id)
              .then(() => submitUploadTasks([selected.id]))
              .then(() => router.replace('/tasks'))
              .catch((nextError) => setError(
                presentRuntimeError(nextError, t('intake.submitError')),
              ))
              .finally(() => setBusy(false));
          },
        },
      ]);
    }
  }

  function editPreset(preset: UploadPreset) {
    selectPreset(preset, false);
    setEditingPresetId(preset.id);
    setPresetName(preset.name);
    setPresetCreatedDate(preset.createdDateBehavior);
    setPresetFilenameTitle(preset.filenameTitle);
    setPresetAutoSubmit(preset.autoSubmit);
    setPresetDefaults(preset.defaultFor ?? []);
  }

  function resetPresetEditor() {
    setEditingPresetId(null);
    setPresetName('');
    setPresetCreatedDate('paperless');
    setPresetFilenameTitle('sanitized');
    setPresetAutoSubmit(false);
    setPresetDefaults([]);
  }

  async function savePreset(duplicate?: UploadPreset) {
    if (!activeProfile || (!draft && !duplicate)) return;
    const existing = editingPresetId
      ? activeUploadPresets.find((preset) => preset.id === editingPresetId)
      : undefined;
    const name = (duplicate ? t('intake.presetCopy', { name: duplicate.name }) : presetName).trim();
    if (!name) {
      setError(t('intake.presetNameError'));
      return;
    }
    const metadata = duplicate?.metadata ?? draft!;
    const issues = validateUploadMetadata(metadata, { catalog });
    if (issues.length) {
      setError(issues.map((issue) => issue.message).join(' '));
      return;
    }
    const now = new Date().toISOString();
    try {
      await saveUploadPreset({
        schemaVersion: UPLOAD_PRESET_SCHEMA_VERSION,
        id: duplicate || !existing
          ? globalThis.crypto?.randomUUID?.() ?? `preset-${Date.now()}`
          : existing.id,
        profileId: activeProfile.id,
        name,
        icon: duplicate?.icon ?? existing?.icon,
        color: duplicate?.color ?? existing?.color,
        createdDateBehavior: duplicate?.createdDateBehavior ?? presetCreatedDate,
        metadata,
        filenameTitle: duplicate?.filenameTitle ?? presetFilenameTitle,
        autoSubmit: duplicate?.autoSubmit ?? presetAutoSubmit,
        defaultFor: duplicate?.defaultFor ?? presetDefaults,
        createdAt: duplicate ? now : existing?.createdAt ?? now,
        updatedAt: now,
      });
      if (!duplicate) resetPresetEditor();
      setError(null);
      await hapticFeedback('confirm');
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('intake.submitError')));
      await hapticFeedback('error');
    }
  }

  function confirmDeletePreset(preset: UploadPreset) {
    Alert.alert(t('intake.deletePreset', { name: preset.name }), preset.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void deleteUploadPreset(preset.id).catch((nextError) => setError(
            presentRuntimeError(nextError, t('intake.submitError')),
          ));
        },
      },
    ]);
  }

  async function submit() {
    if (!batch.length) return;
    for (const task of batch) {
      const metadata = drafts[task.id] ?? task.metadata!;
      const issues = validateUploadMetadata(metadata, { catalog });
      if (issues.length) {
        setSelectedId(task.id);
        setError(`${task.originalName ?? t('intake.documentFallback')}: ${issues.map((issue) => issue.message).join(' ')}`);
        await hapticFeedback('error');
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      for (const task of batch) {
        await updateUploadTask(
          task.id,
          drafts[task.id] ?? task.metadata!,
          selectedPresetIds[task.id] ?? task.presetId,
        );
      }
      await submitUploadTasks(batch.map((task) => task.id));
      await hapticFeedback('confirm');
      router.replace('/tasks');
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('intake.submitError')));
      await hapticFeedback('error');
    } finally {
      setBusy(false);
    }
  }

  if (!selected || !draft) {
    return (
      <SafeAreaView edges={['top']} style={styles.root}>
        <View style={styles.header}>
          <Pressable accessibilityLabel={t('intake.back')} onPress={() => router.back()} style={styles.iconButton}>
            <ChevronLeft color={palette.ink} size={22} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{activeProfile?.displayName ?? 'Paperless'}</Text>
            <Text style={styles.title}>{t('intake.review')}</Text>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {!!rejectionBatch ? (
            <IntakeRejectionList
              acceptedCount={rejectionBatch.acceptedCount}
              items={rejectionBatch.items}
              onChooseMore={chooseOtherFiles}
              onDismiss={() => dismissIntakeRejectionBatch(rejectionBatch.batchId)}
            />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.title}>{t('intake.noDrafts')}</Text>
              <Text style={styles.help}>{t('intake.noDraftsCopy')}</Text>
              <Pressable onPress={() => router.replace('/scan')} style={styles.primaryButton}>
                <Text style={styles.primaryText}>{t('intake.addDocuments')}</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.root}>
      <View style={styles.header}>
        <Pressable accessibilityLabel={t('intake.back')} onPress={() => router.back()} style={styles.iconButton}>
          <ChevronLeft color={palette.ink} size={22} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{activeProfile?.displayName ?? 'Paperless'}</Text>
          <Text style={styles.title}>{t('intake.review')}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!!rejectionBatch && (
          <IntakeRejectionList
            acceptedCount={rejectionBatch.acceptedCount}
            items={rejectionBatch.items}
            onChooseMore={chooseOtherFiles}
            onDismiss={() => dismissIntakeRejectionBatch(rejectionBatch.batchId)}
          />
        )}
        {batch.length > 1 && (
          <>
            <Text style={styles.sectionTitle}>
              {t('intake.independentDocuments', { count: formatNumber(batch.length) })}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fileTabs}>
              {batch.map((task, index) => (
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: task.id === selected.id }}
                  key={task.id}
                  onPress={() => setSelectedId(task.id)}
                  style={[styles.fileTab, task.id === selected.id && styles.fileTabSelected]}>
                  <Text numberOfLines={1} style={[
                    styles.fileTabText,
                    task.id === selected.id && styles.fileTabTextSelected,
                  ]}>
                    {formatNumber(index + 1)}. {task.originalName}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable onPress={applyToAll} style={styles.secondaryButton}>
              <Copy color={palette.ink} size={16} />
              <Text style={styles.secondaryText}>{t('intake.applyAll')}</Text>
            </Pressable>
            <Text style={styles.help}>{t('intake.perFileCopy')}</Text>
          </>
        )}

        {!!activeUploadPresets.length && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('intake.presets')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {activeUploadPresets.map((preset) => (
                <View key={preset.id} style={styles.presetGroup}>
                  <Pressable
                    accessibilityState={{ selected: effectivePresetId === preset.id }}
                    onPress={() => selectPreset(preset)}
                    style={[styles.chip, effectivePresetId === preset.id && styles.chipSelected]}>
                    <Text style={[
                      styles.chipText,
                      effectivePresetId === preset.id && styles.chipTextSelected,
                    ]}>
                      {preset.name}
                    </Text>
                  </Pressable>
                  <Pressable accessibilityLabel={t('intake.duplicatePreset', { name: preset.name })} accessibilityRole="button" onPress={() => void savePreset(preset)} style={styles.presetIconButton}>
                    <Copy color={palette.muted} size={15} />
                  </Pressable>
                  <Pressable accessibilityLabel={t('intake.editPreset', { name: preset.name })} accessibilityRole="button" onPress={() => editPreset(preset)} style={styles.presetIconButton}>
                    <Pencil color={palette.muted} size={15} />
                  </Pressable>
                  <Pressable accessibilityLabel={t('intake.deletePreset', { name: preset.name })} accessibilityRole="button" onPress={() => confirmDeletePreset(preset)} style={styles.presetIconButton}>
                    <Trash2 color={palette.danger} size={15} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            {!!selectedPreset && !!presetProvenance && (
              <Text style={styles.help}>
                {t('intake.presetInherited', {
                  name: selectedPreset.name,
                  fields: formatList(presetProvenance.inherited.map((field) => t(uploadFieldLabelKeys[field]))),
                })}
                {presetProvenance.overridden.length
                  ? t('intake.presetOverrides', {
                      fields: formatList(presetProvenance.overridden.map((field) => t(uploadFieldLabelKeys[field]))),
                    })
                  : ''}
              </Text>
            )}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{selected.originalName}</Text>
          {!uploadAllowed && (
            <Text accessibilityLiveRegion="polite" style={styles.permissionWarning}>
              {t('intake.uploadPermissionDenied')}
            </Text>
          )}
          <Text style={styles.label}>{t('intake.title')}</Text>
          <TextInput
            accessibilityLabel={t('intake.documentTitle')}
            editable={uploadAllowed}
            onChangeText={(value) => updateSelected(replaceField(draft, 'title', value.trim()
              ? { state: 'value', value }
              : { state: 'unset' }))}
            placeholder={t('intake.paperlessDecide')}
            placeholderTextColor={palette.faint}
            style={styles.input}
            value={titleValue(draft)}
          />
          <View style={styles.twoColumns}>
            <View style={styles.column}>
              <Text style={styles.label}>{t('intake.createdDate')}</Text>
              <TextInput
                accessibilityLabel={t('intake.createdDateAccessibility')}
                editable={uploadAllowed}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
                onChangeText={(value) => updateSelected(replaceField(draft, 'created', value
                  ? { state: 'value', value }
                  : { state: 'unset' }))}
                placeholder={t('intake.datePlaceholder')}
                placeholderTextColor={palette.faint}
                style={styles.input}
                value={dateValue(draft)}
              />
            </View>
            <View style={styles.column}>
              <Text style={styles.label}>{t('intake.archiveSerial')}</Text>
              <TextInput
                accessibilityLabel={t('intake.archiveSerial')}
                editable={uploadAllowed}
                keyboardType="number-pad"
                onChangeText={(value) => updateSelected(replaceField(draft, 'archiveSerialNumber', value
                  ? { state: 'value', value: Number(value) }
                  : { state: 'unset' }))}
                placeholder={t('intake.automatic')}
                placeholderTextColor={palette.faint}
                style={styles.input}
                value={asnValue(draft)}
              />
            </View>
          </View>
          <OptionPicker disabled={!uploadAllowed} label={t('intake.correspondent')} options={catalog.correspondents} quickCreate={canQuickCreate.correspondent ? (name) => createCatalogOption('correspondent', name) : undefined} value={draft.correspondent} onChange={(value) => updateSelected(replaceField(draft, 'correspondent', value))} />
          <OptionPicker disabled={!uploadAllowed} label={t('intake.documentType')} options={catalog.documentTypes} quickCreate={canQuickCreate.documentType ? (name) => createCatalogOption('documentType', name) : undefined} value={draft.documentType} onChange={(value) => updateSelected(replaceField(draft, 'documentType', value))} />
          <OptionPicker disabled={!uploadAllowed} label={t('intake.storagePath')} options={catalog.storagePaths} value={draft.storagePath} onChange={(value) => updateSelected(replaceField(draft, 'storagePath', value))} />
          <OptionPicker disabled={!ownerAssignmentAllowed} label={t('intake.owner')} options={catalog.owners} value={draft.owner} onChange={(value) => updateSelected(replaceField(draft, 'owner', value))} />
          {!ownerAssignmentAllowed && uploadAllowed && <Text style={styles.permissionWarning}>{t('intake.ownerPermissionDenied')}</Text>}
          {creationCapabilities.uploadWorkflowOverride === true && !!catalog.workflows?.length && (
            <OptionPicker disabled={!uploadAllowed} label={t('intake.workflow')} options={catalog.workflows} value={draft.workflow} onChange={(value) => updateSelected(replaceField(draft, 'workflow', value))} />
          )}
          {creationCapabilities.uploadWorkflowOverride !== true && draft.workflow.state !== 'unset' && (
            <View style={styles.fieldBlock}>
              <Text style={styles.permissionWarning}>{t('uploadValidation.workflowUnsupported')}</Text>
              <Pressable
                onPress={() => updateSelected(replaceField(draft, 'workflow', { state: 'unset' }))}
                style={styles.secondaryButton}>
                <Text style={styles.secondaryText}>{t('intake.unset')}</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.fieldBlock}>
            <Text style={styles.label}>{t('intake.tags')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              <Pressable
                disabled={!uploadAllowed}
                onPress={() => updateSelected(replaceField(draft, 'tags', { state: 'unset' }))}
                style={[styles.chip, draft.tags.state === 'unset' && styles.chipSelected]}>
                <Text style={[
                  styles.chipText,
                  draft.tags.state === 'unset' && styles.chipTextSelected,
                ]}>
                  {t('intake.paperlessDecide')}
                </Text>
              </Pressable>
              {catalog.tags.map((tag) => {
                const selectedTags = draft.tags.state === 'value' ? draft.tags.value : [];
                const checked = selectedTags.some((item) => item.id === tag.id);
                return (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked, disabled: !uploadAllowed }}
                    disabled={!uploadAllowed}
                    key={tag.id}
                    onPress={() => updateSelected(replaceField(draft, 'tags', {
                      state: 'value',
                      value: checked
                        ? selectedTags.filter((item) => item.id !== tag.id)
                        : [...selectedTags, tag],
                    }))}
                    style={[styles.chip, checked && styles.chipSelected]}>
                    {checked && <Check color={palette.accentInk} size={13} />}
                    <Text style={[styles.chipText, checked && styles.chipTextSelected]}>{tag.pathLabel || tag.name}{tag.isInboxTag ? ` · ${t('nav.inbox')}` : ''}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {canQuickCreate.tag && uploadAllowed && (
              <QuickCreateOption
                label={t('catalogEditor.tag')}
                onCreate={(name) => createCatalogOption('tag', name)}
                onCreated={(tag) => {
                  const selectedTags = draft.tags.state === 'value' ? draft.tags.value : [];
                  updateSelected(replaceField(draft, 'tags', {
                    state: 'value',
                    value: selectedTags.some((item) => item.id === tag.id)
                      ? selectedTags
                      : [...selectedTags, tag],
                  }));
                }}
              />
            )}
          </View>

          {!!catalog.customFields.length && (
            <View style={styles.customFields}>
              <Text style={styles.sectionTitle}>{t('intake.customFields')}</Text>
              {catalog.customFields.map((field) => {
                const existing = draft.customFields.find((item) => item.fieldId === field.id);
                const explicit = existing?.value ?? { state: 'unset' as const };
                const setValue = (value: ExplicitValue<string | number | boolean | number[] | null>) => {
                  const next = draft.customFields.filter((item) => item.fieldId !== field.id);
                  if (value.state !== 'unset') {
                    next.push({
                      fieldId: field.id,
                      fieldRemoteId: field.remoteId,
                      dataType: field.dataType,
                      selectOptionIds: field.selectOptions.map((option) => option.id),
                      defaultCurrency: field.defaultCurrency,
                      value,
                    });
                  }
                  updateSelected({ ...draft, customFields: next });
                };
                if (field.dataType === 'boolean') {
                  return (
                    <View key={field.id} style={styles.switchRow}>
                      <View style={styles.switchCopy}>
                        <Text style={styles.label}>{field.name}</Text>
                        <Text style={styles.help}>
                          {explicit.state === 'unset'
                            ? t('intake.paperlessDecides')
                            : explicit.state === 'clear'
                              ? t('intake.explicitClear')
                              : t('intake.explicitValue')}
                        </Text>
                      </View>
                      <Pressable disabled={!uploadAllowed} onPress={() => setValue({ state: 'unset' })} style={styles.clearButton}>
                        <Text style={styles.clearText}>{t('intake.unset')}</Text>
                      </Pressable>
                      <Pressable disabled={!uploadAllowed} onPress={() => setValue({ state: 'clear' })} style={styles.clearButton}>
                        <Text style={styles.clearText}>{t('intake.clearValue')}</Text>
                      </Pressable>
                      <Switch
                        disabled={!uploadAllowed}
                        onValueChange={(value) => setValue({ state: 'value', value })}
                        value={explicit.state === 'value' && explicit.value === true}
                      />
                    </View>
                  );
                }
                if (field.dataType === 'select') {
                  return (
                    <View key={field.id} style={styles.fieldBlock}>
                      <Text style={styles.label}>{field.name}</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityState={{ disabled: !uploadAllowed, selected: explicit.state === 'unset' }}
                          disabled={!uploadAllowed}
                          onPress={() => setValue({ state: 'unset' })}
                          style={[styles.chip, explicit.state === 'unset' && styles.chipSelected]}>
                          <Text style={[styles.chipText, explicit.state === 'unset' && styles.chipTextSelected]}>
                            {t('intake.paperlessDecide')}
                          </Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityState={{ disabled: !uploadAllowed, selected: explicit.state === 'clear' }}
                          disabled={!uploadAllowed}
                          onPress={() => setValue({ state: 'clear' })}
                          style={[styles.chip, explicit.state === 'clear' && styles.chipSelected]}>
                          <Text style={[styles.chipText, explicit.state === 'clear' && styles.chipTextSelected]}>
                            {t('intake.clearValue')}
                          </Text>
                        </Pressable>
                        {field.selectOptions.map((option) => {
                          const checked = explicit.state === 'value' && explicit.value === option.id;
                          return (
                            <Pressable
                              accessibilityRole="radio"
                              accessibilityState={{ disabled: !uploadAllowed, selected: checked }}
                              disabled={!uploadAllowed}
                              key={option.id || '__empty__'}
                              onPress={() => setValue({ state: 'value', value: option.id })}
                              style={[styles.chip, checked && styles.chipSelected]}>
                              <Text style={[styles.chipText, checked && styles.chipTextSelected]}>
                                {option.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    </View>
                  );
                }
                return (
                  <View key={field.id} style={styles.fieldBlock}>
                    <Text style={styles.label}>
                      {field.name} · {t(`custom.type.${field.dataType}` as TranslationKey)}
                    </Text>
                    <TextInput
                      accessibilityLabel={field.name}
                      editable={uploadAllowed}
                      multiline={field.dataType === 'longtext'}
                      onChangeText={(value) => {
                        if (!value) return setValue({ state: 'unset' });
                        if (field.dataType === 'integer' || field.dataType === 'float') {
                          return setValue({ state: 'value', value: Number(value) });
                        }
                        if (field.dataType === 'documentlink') {
                          return setValue({
                            state: 'value',
                            value: parseDocumentLinkInput(value),
                          });
                        }
                        setValue({ state: 'value', value });
                      }}
                      placeholder={field.dataType === 'monetary'
                        ? `${field.defaultCurrency ?? 'CHF'}12.30`
                        : t('intake.paperlessDecide')}
                      placeholderTextColor={palette.faint}
                      style={[styles.input, field.dataType === 'longtext' && styles.multiline]}
                      value={explicit.state === 'value'
                        ? Array.isArray(explicit.value) ? formatList(explicit.value.map(String)) : String(explicit.value ?? '')
                        : ''}
                    />
                    <View style={styles.wrappedChips}>
                      <Pressable
                        disabled={!uploadAllowed}
                        onPress={() => setValue({ state: 'unset' })}
                        style={[styles.chip, explicit.state === 'unset' && styles.chipSelected]}>
                        <Text style={[styles.chipText, explicit.state === 'unset' && styles.chipTextSelected]}>
                          {t('intake.unset')}
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={!uploadAllowed}
                        onPress={() => setValue({ state: 'clear' })}
                        style={[styles.chip, explicit.state === 'clear' && styles.chipSelected]}>
                        <Text style={[styles.chipText, explicit.state === 'clear' && styles.chipTextSelected]}>
                          {t('intake.clearValue')}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {editingPresetId ? t('intake.editReusable') : t('intake.saveReusable')}
          </Text>
          <View style={styles.presetCreate}>
            <TextInput
              accessibilityLabel={t('intake.presetName')}
              onChangeText={setPresetName}
              placeholder={t('intake.presetExample')}
              placeholderTextColor={palette.faint}
              style={[styles.input, styles.presetInput]}
              value={presetName}
            />
            <Pressable accessibilityLabel={t('intake.savePreset')} onPress={() => void savePreset()} style={styles.savePresetButton}>
              <Save color={palette.accentInk} size={18} />
            </Pressable>
          </View>
          <Text style={styles.label}>{t('intake.presetCreatedDate')}</Text>
          <View style={styles.wrappedChips}>
            {(['paperless', 'today', 'last-used'] as const).map((behavior) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: presetCreatedDate === behavior }}
                key={behavior}
                onPress={() => setPresetCreatedDate(behavior)}
                style={[styles.chip, presetCreatedDate === behavior && styles.chipSelected]}>
                <Text style={[styles.chipText, presetCreatedDate === behavior && styles.chipTextSelected]}>
                  {t(`intake.dateBehavior.${behavior}` as TranslationKey)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>{t('intake.presetFilenameTitle')}</Text>
          <View style={styles.wrappedChips}>
            {(['sanitized', 'original', 'blank'] as const).map((behavior) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: presetFilenameTitle === behavior }}
                key={behavior}
                onPress={() => setPresetFilenameTitle(behavior)}
                style={[styles.chip, presetFilenameTitle === behavior && styles.chipSelected]}>
                <Text style={[styles.chipText, presetFilenameTitle === behavior && styles.chipTextSelected]}>
                  {t(`intake.filenameTitle.${behavior}` as TranslationKey)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>{t('intake.defaultEntryPoints')}</Text>
          <View style={styles.wrappedChips}>
            {(['camera', 'picker', 'share'] as const).map((source) => {
              const checked = presetDefaults.includes(source);
              return (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  key={source}
                  onPress={() => setPresetDefaults((current) => checked
                    ? current.filter((item) => item !== source)
                    : [...current, source])}
                  style={[styles.chip, checked && styles.chipSelected]}>
                  {checked && <Check color={palette.accentInk} size={13} />}
                  <Text style={[styles.chipText, checked && styles.chipTextSelected]}>
                    {t(`intake.source.${source}` as TranslationKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.label}>{t('intake.autoSubmit')}</Text>
              <Text style={styles.help}>{t('intake.autoSubmitCopy')}</Text>
            </View>
            <Switch onValueChange={setPresetAutoSubmit} value={presetAutoSubmit} />
          </View>
          {!!editingPresetId && (
            <Pressable onPress={resetPresetEditor} style={styles.clearButton}>
              <Text style={styles.clearText}>{t('intake.cancelPresetEdit')}</Text>
            </Pressable>
          )}
        </View>

        {!!displayedError && (
          <Text accessibilityLiveRegion="assertive" style={styles.error}>{displayedError}</Text>
        )}
        <Pressable accessibilityState={{ disabled: busy || !uploadAllowed }} disabled={busy || !uploadAllowed} onPress={() => void submit()} style={[styles.primaryButton, !uploadAllowed && styles.disabled]}>
          {busy ? <ActivityIndicator color={palette.accentInk} /> : <Check color={palette.accentInk} size={19} />}
          <Text style={styles.primaryText}>
            {batch.length === 1
              ? t('intake.queueOne')
              : t('intake.queueMany', { count: formatNumber(batch.length) })}
          </Text>
        </Pressable>
        <Text style={styles.footerHelp}>{t('intake.unsetCopy')}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.paper },
  headerCopy: { flex: 1 },
  eyebrow: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 27, fontWeight: '700' },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 18, paddingBottom: 48, gap: 14 },
  card: { padding: 17, borderRadius: radii.lg, backgroundColor: palette.paper, gap: 13, ...shadows.card },
  sectionTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 15, fontWeight: '900' },
  fileTabs: { gap: 8 },
  fileTab: { maxWidth: 220, paddingHorizontal: 13, paddingVertical: 10, borderRadius: radii.sm, backgroundColor: palette.paper },
  fileTabSelected: { backgroundColor: palette.lime },
  fileTabText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  fileTabTextSelected: { color: palette.accentInk },
  fieldBlock: { gap: 7 },
  label: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  input: { minHeight: 48, color: palette.ink, fontFamily: fonts.sans, fontSize: 15, paddingHorizontal: 13, paddingVertical: 11, borderWidth: 1, borderColor: palette.line, borderRadius: radii.sm, backgroundColor: palette.paperStrong },
  multiline: { minHeight: 92, textAlignVertical: 'top' },
  twoColumns: { flexDirection: 'row', gap: 10 },
  column: { flex: 1, gap: 7 },
  chips: { gap: 8, alignItems: 'center', paddingRight: 8 },
  wrappedChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, borderWidth: 1, borderColor: palette.line, borderRadius: radii.pill, backgroundColor: palette.paperStrong },
  chipSelected: { borderColor: palette.limeDark, backgroundColor: palette.lime },
  chipText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  chipTextSelected: { color: palette.accentInk },
  presetGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 5 },
  presetIconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  presetCreate: { flexDirection: 'row', gap: 8 },
  quickCreateBlock: { gap: 6 },
  quickCreateRow: { flexDirection: 'row', gap: 8 },
  quickCreateInput: { flex: 1 },
  quickCreateButton: { width: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radii.sm, backgroundColor: palette.lime },
  presetInput: { flex: 1 },
  savePresetButton: { width: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radii.sm, backgroundColor: palette.lime },
  customFields: { gap: 12, paddingTop: 4 },
  switchRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchCopy: { flex: 1 },
  clearButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 7 },
  clearText: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  permissionWarning: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  secondaryButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: radii.md, backgroundColor: palette.paper },
  secondaryText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  primaryButton: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.lime },
  primaryText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 14, fontWeight: '900' },
  help: { color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 13, fontWeight: '800', lineHeight: 19 },
  footerHelp: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, textAlign: 'center' },
  empty: { minHeight: 360, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 28 },
});
