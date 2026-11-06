import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The patch file is named after the installed version; follow it so a reviewed upgrade that
// re-applies the same hunks (as 10.4.8 → 10.10.0 did) keeps this proof instead of breaking it.
const notifyKitVersion = (
  JSON.parse(
    readFileSync(join(process.cwd(), 'node_modules/react-native-notify-kit/package.json'), 'utf8'),
  ) as { version: string }
).version;
const patch = readFileSync(
  join(process.cwd(), `patches/react-native-notify-kit+${notifyKitVersion}.patch`),
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
    // 10.10.0 wraps some constructor calls across lines; match the shape, not the formatting.
    const pressEvent = body.search(
      /new NotificationEvent\(\s*TYPE_PRESS,\s*notificationModel,\s*extras\s*\)/,
    );
    const initialEvent = body.search(
      /new InitialNotificationEvent\(\s*notificationModel,\s*extras\b/,
    );
    expect(token).toBeGreaterThan(-1);
    expect(pressEvent).toBeGreaterThan(-1);
    expect(initialEvent).toBeGreaterThan(-1);
    expect(token).toBeLessThan(pressEvent);
    expect(token).toBeLessThan(initialEvent);
  }
  expect(patch).toContain('extras.getString(KEY_DETAIL_PRESS_OCCURRENCE_ID)');
  expect(patch).toContain('eventDetailMap.putString(KEY_DETAIL_PRESS_OCCURRENCE_ID, occurrenceId)');
});
