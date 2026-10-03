import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const patch = readFileSync(
  join(process.cwd(), 'patches/react-native-notify-kit+10.4.8.patch'),
  'utf8',
);

it('mints one process-scoped sequence at receipt in both native body-press paths', () => {
  expect(patch).toContain('PRESS_OCCURRENCE_EPOCH = UUID.randomUUID().toString()');
  expect(patch).toContain('PRESS_OCCURRENCE_SEQUENCE = new AtomicLong()');
  expect(patch).toContain('PRESS_OCCURRENCE_SEQUENCE.incrementAndGet()');
  expect(patch).toContain('+    extras.putString("pressOccurrenceId", nextPressOccurrenceId());');
  expect(patch).toContain(
    '+    extras.putString("pressOccurrenceId", NotificationReceiverHandler.nextPressOccurrenceId());',
  );
});

it('shares receiver extras with PRESS and sticky delivery and forwards identity through Kotlin', () => {
  for (const [file, method] of [
    ['NotificationReceiverHandler.java', 'private static void handleNotificationPressIntent'],
    ['ReceiverService.java', 'private void onPressIntent'],
  ]) {
    const source = readFileSync(
      join(
        process.cwd(),
        'node_modules/react-native-notify-kit/android/src/main/java/app/notifee/core',
        file!,
      ),
      'utf8',
    );
    const body = source.slice(source.indexOf(method!));
    const token = body.indexOf('extras.putString("pressOccurrenceId"');
    expect(token).toBeGreaterThan(-1);
    expect(token).toBeLessThan(
      body.indexOf('new NotificationEvent(TYPE_PRESS, notificationModel, extras)'),
    );
    expect(token).toBeLessThan(
      body.indexOf('new InitialNotificationEvent(notificationModel, extras)'),
    );
  }
  expect(patch).toContain('extras.getString(KEY_DETAIL_PRESS_OCCURRENCE_ID)');
  expect(patch).toContain('eventDetailMap.putString(KEY_DETAIL_PRESS_OCCURRENCE_ID, occurrenceId)');
});
