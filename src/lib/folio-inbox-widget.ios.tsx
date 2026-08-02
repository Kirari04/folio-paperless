import { Text, VStack } from '@expo/ui/swift-ui';
import {
  containerBackground,
  font,
  foregroundStyle,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget } from 'expo-widgets';

import {
  createWidgetSnapshot,
  type FolioWidgetSnapshot,
  type WidgetSnapshotAdapter,
} from './widget-privacy';

function FolioInboxWidgetLayout(props: FolioWidgetSnapshot) {
  'widget';
  const protectedState = props.state !== 'ready';
  const primary = protectedState
    ? props.state === 'locked' ? (props.labels?.locked ?? 'Folio') : (props.labels?.inbox ?? 'Folio')
    : String(props.inboxCount);
  const secondary = protectedState
    ? (props.labels?.openScan ?? '')
    : props.inboxCount === 1 ? (props.labels?.inboxItem ?? '') : (props.labels?.inboxItems ?? '');

  return (
    <VStack
      alignment="leading"
      spacing={6}
      modifiers={[
        containerBackground('#17231B', 'widget'),
        padding({ all: 14 }),
        widgetURL('folio-paperless://scan'),
      ]}
    >
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle('#CFD9D1')]}>Folio</Text>
      <Text modifiers={[font({ size: protectedState ? 22 : 36, weight: 'bold' }), foregroundStyle('#FFFFFF')]}>
        {primary}
      </Text>
      <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle('#CFD9D1')]}>
        {secondary}
      </Text>
    </VStack>
  );
}

export const FolioInboxWidget = createWidget('FolioInboxWidget', FolioInboxWidgetLayout);

export const folioWidgetSnapshotAdapter: WidgetSnapshotAdapter = {
  async updateSnapshot(snapshot) {
    FolioInboxWidget.updateSnapshot(snapshot);
  },
  async clearSnapshot() {
    FolioInboxWidget.updateSnapshot(createWidgetSnapshot({
      authenticated: false,
      unlocked: false,
      inboxCount: null,
      syncedAt: null,
    }));
  },
};
