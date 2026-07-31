import * as DocumentPicker from 'expo-document-picker';
import {
  Archive,
  ChevronRight,
  Clock3,
  Hash,
  History,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';

import { ChoiceSheet } from '@/components/choice-sheet';
import { CustomFieldSheet } from '@/components/custom-field-sheet';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { TextEditSheet } from '@/components/text-edit-sheet';
import { fonts, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import {
  DocumentItem,
  PaperlessCustomFieldDefinition,
  PaperlessCustomFieldValue,
  PaperlessDocumentVersion,
} from '@/types/document';

type Props = {
  document: DocumentItem;
  selectedVersionId?: number | string;
  onSelectVersion: (versionId?: number | string) => void;
  onToast: (message: string, error?: boolean) => void;
};

function displayDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function customFieldDisplay(
  definition: PaperlessCustomFieldDefinition | undefined,
  value: PaperlessCustomFieldValue['value'],
  documents: DocumentItem[],
) {
  if (value === null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (!value.length) return 'No documents linked';
    return value
      .map((id) => documents.find((document) => document.remoteId === id)?.title || `Document ${id}`)
      .join(', ');
  }
  if (definition?.dataType === 'select') {
    return definition.selectOptions.find((option) => option.id === String(value))?.label || String(value);
  }
  return String(value);
}

export function DocumentDeepSections({
  document,
  selectedVersionId,
  onSelectVersion,
  onToast,
}: Props) {
  const {
    documents,
    catalog,
    updateDocument,
    addNote,
    deleteNote,
    uploadVersion,
    renameVersion,
    deleteVersion,
  } = useApp();
  const [editingAsn, setEditingAsn] = useState(false);
  const [asn, setAsn] = useState(document.archiveSerialNumber?.toString() || '');
  const [storagePicker, setStoragePicker] = useState(false);
  const [fieldPicker, setFieldPicker] = useState(false);
  const [editingField, setEditingField] = useState<PaperlessCustomFieldDefinition | null>(null);
  const pendingField = useRef<PaperlessCustomFieldDefinition | null>(null);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingVersionId, setEditingVersionId] = useState<number | string | null>(null);
  const [versionLabel, setVersionLabel] = useState('');
  const [visibleSections, setVisibleSections] = useState(1);

  useEffect(() => {
    let frame = 0;
    let nextSection = 1;
    const revealNext = () => {
      nextSection += 1;
      setVisibleSections(nextSection);
      if (nextSection < 4) frame = requestAnimationFrame(revealNext);
    };
    frame = requestAnimationFrame(revealNext);
    return () => cancelAnimationFrame(frame);
  }, []);

  const customFields = useMemo(() => document.customFields || [], [document.customFields]);
  const versions = document.versions || [];
  const notes = document.notes || [];
  const editingVersion = versions.find((version) => version.id === editingVersionId);
  const availableFields = useMemo(
    () => catalog.customFields.filter(
      (definition) => !customFields.some((field) => field.fieldId === definition.id),
    ),
    [catalog.customFields, customFields],
  );
  const fieldOptions = availableFields.map((definition) => ({
    id: definition.id,
    remoteId: definition.remoteId,
    name: definition.name,
  }));

  async function saveAsn(nextValue: string) {
    const normalized = nextValue.trim();
    if (normalized && (!/^\d+$/.test(normalized) || Number(normalized) <= 0)) {
      throw new Error('Archive serial numbers must be positive whole numbers.');
    }
    setBusy('asn');
    try {
      await updateDocument(document.id, {
        archiveSerialNumber: normalized ? Number(normalized) : null,
      });
      setAsn(normalized);
      onToast(normalized ? 'Archive serial number updated' : 'Archive serial number cleared');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update the serial number.';
      onToast(message, true);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusy(null);
    }
  }

  async function saveCustomField(next: PaperlessCustomFieldValue) {
    const nextFields = [
      ...customFields.filter((field) => field.fieldId !== next.fieldId),
      next,
    ];
    animateLayout();
    await updateDocument(document.id, { customFields: nextFields });
    onToast(`${editingField?.name || 'Custom field'} updated`);
  }

  async function removeCustomField() {
    if (!editingField) return;
    animateLayout();
    await updateDocument(document.id, {
      customFields: customFields.filter((field) => field.fieldId !== editingField.id),
    });
    onToast(`${editingField.name} removed`);
  }

  async function submitNote(nextValue: string) {
    const normalized = nextValue.trim();
    setBusy('note');
    try {
      await addNote(document.id, normalized);
      animateLayout();
      onToast('Note added');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not add this note.';
      onToast(message, true);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusy(null);
    }
  }

  function confirmDeleteNote(noteId: number | string) {
    Alert.alert('Delete note?', 'This removes the note from this document.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setBusy(`note-${noteId}`);
          deleteNote(document.id, noteId)
            .then(async () => {
              animateLayout();
              onToast('Note deleted');
              await hapticFeedback('warning');
            })
            .catch(async (error) => {
              onToast(error instanceof Error ? error.message : 'Could not delete this note.', true);
              await hapticFeedback('error');
            })
            .finally(() => setBusy(null));
        },
      },
    ]);
  }

  async function replaceFile() {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: ['application/pdf', 'image/*', 'text/plain'],
    });
    if (result.canceled) return;
    const file = result.assets[0];
    setBusy('version-upload');
    try {
      const label = file.name.replace(/\.[^.]+$/, '');
      await uploadVersion(document.id, {
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
      }, label);
      animateLayout();
      onSelectVersion(undefined);
      onToast('New version processed by Paperless');
      await hapticFeedback('confirm');
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not upload this version.', true);
      await hapticFeedback('error');
    } finally {
      setBusy(null);
    }
  }

  async function saveVersionLabel(version: PaperlessDocumentVersion, nextValue: string) {
    setBusy(`version-${version.id}`);
    try {
      await renameVersion(document.id, version.id, nextValue.trim());
      onToast('Version label updated');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not rename this version.';
      onToast(message, true);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusy(null);
    }
  }

  function confirmDeleteVersion(version: PaperlessDocumentVersion) {
    Alert.alert(
      'Delete this version?',
      'The other versions and document metadata will stay in Paperless. This version cannot be recovered.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete version',
          style: 'destructive',
          onPress: () => {
            setBusy(`version-${version.id}`);
            deleteVersion(document.id, version.id)
              .then(async () => {
                animateLayout();
                if (selectedVersionId === version.id) onSelectVersion(undefined);
                onToast('Version deleted');
                await hapticFeedback('warning');
              })
              .catch(async (error) => {
                onToast(error instanceof Error ? error.message : 'Could not delete this version.', true);
                await hapticFeedback('error');
              })
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  }

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Paperless metadata</Text>
        <View style={styles.group}>
          <Pressable
            accessibilityHint="Opens a keyboard-safe number editor"
            disabled={document.canEdit === false}
            onPress={() => setEditingAsn(true)}
            style={styles.row}>
            <View style={[styles.icon, { backgroundColor: palette.lavender }]}>
              <Hash color={palette.ink} size={18} />
            </View>
            <View style={styles.rowCopy}>
              <Text style={styles.label}>Archive serial number</Text>
              <Text style={styles.value}>{document.archiveSerialNumber || 'Not assigned'}</Text>
            </View>
            <ChevronRight color={palette.faint} size={17} />
          </Pressable>
          <Pressable
            disabled={document.canEdit === false}
            onPress={() => setStoragePicker(true)}
            style={styles.row}>
            <View style={[styles.icon, { backgroundColor: palette.mint }]}>
              <Archive color={palette.ink} size={18} />
            </View>
            <View style={styles.rowCopy}>
              <Text style={styles.label}>Storage path</Text>
              <Text style={styles.value}>{document.storagePath || 'Automatic'}</Text>
            </View>
            <ChevronRight color={palette.faint} size={17} />
          </Pressable>
        </View>
      </View>

      {visibleSections >= 2 && <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Custom fields</Text>
          {!!availableFields.length && document.canEdit !== false && (
            <Pressable onPress={() => setFieldPicker(true)} style={styles.smallAction}>
              <Plus color={palette.ink} size={15} />
              <Text style={styles.smallActionText}>Add field</Text>
            </Pressable>
          )}
        </View>
        {customFields.length ? (
          <View style={styles.group}>
            {customFields.map((field) => {
              const definition = catalog.customFields.find((item) => item.id === field.fieldId);
              return (
                <Pressable
                  disabled={!definition || document.canEdit === false}
                  key={field.fieldId}
                  onPress={() => definition && setEditingField(definition)}
                  style={styles.row}>
                  <View style={[styles.icon, { backgroundColor: palette.sky }]}>
                    <Pencil color={palette.ink} size={17} />
                  </View>
                  <View style={styles.rowCopy}>
                    <Text style={styles.label}>{definition?.name || `Field ${field.fieldRemoteId}`}</Text>
                    <Text numberOfLines={2} style={styles.value}>
                      {customFieldDisplay(definition, field.value, documents)}
                    </Text>
                  </View>
                  {!!definition && <ChevronRight color={palette.faint} size={17} />}
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>No custom fields yet</Text>
            <Text style={styles.emptyCopy}>Add structured values defined on your Paperless server.</Text>
          </View>
        )}
      </View>}

      {visibleSections >= 3 && <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <Text style={styles.count}>{notes.length}</Text>
        </View>
        <Pressable
          accessibilityHint="Opens a keyboard-safe note editor"
          disabled={document.canEdit === false}
          onPress={() => setNoteComposerOpen(true)}
          style={styles.noteComposer}>
          <MessageSquare color={palette.muted} size={18} />
          <View style={styles.noteComposerCopy}>
            <Text style={styles.noteComposerTitle}>Add a note</Text>
            <Text style={styles.noteComposerHint}>Add context for your future self</Text>
          </View>
          <View style={styles.noteComposerAction}>
            <Plus color={palette.ink} size={16} />
          </View>
        </Pressable>
        {!!notes.length && (
          <View style={styles.notes}>
            {notes.map((item) => (
              <View key={item.id} style={styles.noteCard}>
                <Text style={styles.noteText}>{item.note}</Text>
                <View style={styles.noteFooter}>
                  <Text style={styles.noteMeta}>{item.author} · {displayDate(item.created)}</Text>
                  {document.canEdit !== false && (
                    <Pressable
                      accessibilityLabel="Delete note"
                      haptic="warning"
                      onPress={() => confirmDeleteNote(item.id)}>
                      {busy === `note-${item.id}`
                        ? <ActivityIndicator color={palette.danger} size="small" />
                        : <Trash2 color={palette.danger} size={15} />}
                    </Pressable>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>}

      {visibleSections >= 4 && <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Version history</Text>
          {document.canEdit !== false && (
            <Pressable
              disabled={busy === 'version-upload'}
              haptic="medium"
              onPress={replaceFile}
              style={styles.smallAction}>
              {busy === 'version-upload'
                ? <ActivityIndicator color={palette.ink} size="small" />
                : <Upload color={palette.ink} size={15} />}
              <Text style={styles.smallActionText}>New version</Text>
            </Pressable>
          )}
        </View>
        <View style={styles.versionGroup}>
          {versions.length ? versions.map((version, index) => {
            const selected = selectedVersionId === version.id || (selectedVersionId === undefined && index === 0);
            return (
              <View key={version.id} style={[styles.versionRow, selected && styles.versionSelected]}>
                <Pressable
                  accessibilityState={{ selected }}
                  onPress={() => onSelectVersion(version.id)}
                  style={styles.versionMain}>
                  <View style={[styles.versionIcon, selected && styles.versionIconSelected]}>
                    <History color={selected ? palette.paper : palette.ink} size={17} />
                  </View>
                  <View style={styles.versionCopy}>
                    <Text numberOfLines={1} style={styles.versionTitle}>
                      {version.versionLabel || (version.isRoot ? 'Original' : `Version ${versions.length - index}`)}
                    </Text>
                    <View style={styles.versionMetaRow}>
                      <Clock3 color={palette.faint} size={12} />
                      <Text style={styles.versionMeta}>{displayDate(version.added)}{index === 0 ? ' · Current' : ''}</Text>
                    </View>
                  </View>
                </Pressable>
                {document.canEdit !== false ? (
                  <View style={styles.versionActions}>
                    <Pressable
                      accessibilityLabel="Rename version"
                      onPress={() => {
                        setVersionLabel(version.versionLabel || '');
                        setEditingVersionId(version.id);
                      }}
                      style={styles.versionAction}>
                      <Pencil color={palette.muted} size={15} />
                    </Pressable>
                    {!version.isRoot && (
                      <Pressable
                        accessibilityLabel="Delete version"
                        haptic="warning"
                        onPress={() => confirmDeleteVersion(version)}
                        style={styles.versionAction}>
                        <Trash2 color={palette.danger} size={15} />
                      </Pressable>
                    )}
                  </View>
                ) : null}
              </View>
            );
          }) : (
            <View style={styles.emptyBlock}>
              <Text style={styles.emptyTitle}>Current file only</Text>
              <Text style={styles.emptyCopy}>Upload a replacement to preserve the current file as history.</Text>
            </View>
          )}
        </View>
      </View>}

      {storagePicker && (
        <ChoiceSheet
          allowNone
          onClose={() => setStoragePicker(false)}
          onConfirm={async (selected) => {
            await updateDocument(document.id, { storagePath: selected[0] || null });
            onToast('Storage path updated');
          }}
          options={catalog.storagePaths}
          selectedIds={document.storagePathId ? [document.storagePathId] : []}
          title="Storage path"
          visible
        />
      )}
      {fieldPicker && (
        <ChoiceSheet
          onClose={() => {
            setFieldPicker(false);
            if (pendingField.current) {
              setEditingField(pendingField.current);
              pendingField.current = null;
            }
          }}
          onConfirm={(selected) => {
            const definition = catalog.customFields.find((item) => item.id === selected[0]?.id);
            if (definition) pendingField.current = definition;
          }}
          options={fieldOptions}
          selectedIds={[]}
          title="Add custom field"
          visible
        />
      )}
      {!!editingField && (
        <CustomFieldSheet
          definition={editingField}
          documents={documents.filter((item) => item.id !== document.id)}
          onClose={() => setEditingField(null)}
          onRemove={customFields.some((field) => field.fieldId === editingField.id)
            ? removeCustomField
            : undefined}
          onSave={saveCustomField}
          value={customFields.find((field) => field.fieldId === editingField.id)}
        />
      )}
      {editingAsn && (
        <TextEditSheet
          autoCapitalize="none"
          autoCorrect={false}
          helperText="Leave this empty to remove the archive serial number."
          keyboardType="number-pad"
          label="Archive serial number"
          onClose={() => setEditingAsn(false)}
          onSave={saveAsn}
          placeholder="No serial number"
          saveLabel="Save number"
          subtitle="Use a positive whole number assigned to this document."
          title="Edit serial number"
          validate={(next) => {
            const normalized = next.trim();
            return !normalized || (/^\d+$/.test(normalized) && Number(normalized) > 0)
              ? null
              : 'Archive serial numbers must be positive whole numbers.';
          }}
          value={asn}
          visible
        />
      )}
      {noteComposerOpen && (
        <TextEditSheet
          label="Note"
          multiline
          onClose={() => setNoteComposerOpen(false)}
          onSave={submitNote}
          placeholder="Add context for your future self"
          required
          saveLabel="Add note"
          subtitle="Notes are saved to this document in Paperless."
          title="New note"
          value=""
          visible
        />
      )}
      {!!editingVersion && (
        <TextEditSheet
          label="Version label"
          onClose={() => setEditingVersionId(null)}
          onSave={(next) => saveVersionLabel(editingVersion, next)}
          placeholder={editingVersion.isRoot ? 'Original' : 'Version label'}
          saveLabel="Rename version"
          subtitle="Use a short label that makes this file revision easy to recognize."
          title="Rename version"
          value={versionLabel}
          visible
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 29 },
  sectionHeading: { minHeight: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 11 },
  sectionTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 17, fontWeight: '900' },
  group: { paddingHorizontal: 14, borderRadius: radii.lg, backgroundColor: palette.paper },
  row: { minHeight: 65, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderColor: palette.line },
  icon: { width: 36, height: 36, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowCopy: { flex: 1, minWidth: 0 },
  label: { color: palette.faint, fontFamily: fonts.sans, fontSize: 9, fontWeight: '700' },
  value: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '700', lineHeight: 17, marginTop: 3 },
  smallAction: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: radii.sm, backgroundColor: palette.lime },
  smallActionText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  emptyBlock: { padding: 17, borderRadius: radii.lg, backgroundColor: palette.paper },
  emptyTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  emptyCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15, marginTop: 4 },
  count: { minWidth: 25, height: 25, textAlign: 'center', textAlignVertical: 'center', color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900', borderRadius: 13, backgroundColor: palette.paper },
  noteComposer: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radii.lg, backgroundColor: palette.paper },
  noteComposerCopy: { flex: 1, minWidth: 0 },
  noteComposerTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  noteComposerHint: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, marginTop: 3 },
  noteComposerAction: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: palette.lime },
  notes: { gap: 8, marginTop: 8 },
  noteCard: { padding: 14, borderRadius: radii.md, backgroundColor: palette.paper },
  noteText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  noteFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 10 },
  noteMeta: { flex: 1, color: palette.faint, fontFamily: fonts.sans, fontSize: 9, fontWeight: '700' },
  versionGroup: { gap: 7 },
  versionRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', padding: 9, borderRadius: radii.md, backgroundColor: palette.paper, borderWidth: 1, borderColor: 'transparent' },
  versionSelected: { borderColor: palette.ink, backgroundColor: '#F1F5E7' },
  versionMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11 },
  versionIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: palette.canvas },
  versionIconSelected: { backgroundColor: palette.ink },
  versionCopy: { flex: 1, minWidth: 0 },
  versionTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  versionMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  versionMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9 },
  versionActions: { flexDirection: 'row' },
  versionAction: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
});
