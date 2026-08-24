import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import { approveNewServerUrl } from '@/services/realtimeControl';
import {
  serverRotationCoordinator,
  type ServerRotationRequest,
} from '@/services/realtime/serverRotationCoordinator';
import { showToast } from '@ui/toast/toastStore';
import { Button, TextField } from '../primitives';
import { useTheme } from '../theme';
import { useReduceMotionPreference } from '../hooks/useReduceMotionPreference';

/** Foreground-only password reconfirmation host for an authenticated `new-server` proposal. */
export function ServerRotationApprovalHost(): React.JSX.Element | null {
  const request = useSyncExternalStore(
    serverRotationCoordinator.subscribe,
    serverRotationCoordinator.getSnapshot,
    serverRotationCoordinator.getSnapshot,
  );
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppState(nextState);
      if (nextState === 'active') return;
      serverRotationCoordinator.cancel();
    });
    return () => subscription.remove();
  }, []);

  if (!request || appState !== 'active') return null;
  return <ServerRotationPrompt key={request.id} request={request} />;
}

function ServerRotationPrompt({ request }: { request: ServerRotationRequest }): React.JSX.Element {
  const theme = useTheme();
  const reduceMotion = useReduceMotionPreference();
  const [password, setPassword] = useState('');
  const [cleartextApproved, setCleartextApproved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const cancel = useCallback(() => {
    serverRotationCoordinator.cancel(request.id);
  }, [request.id]);

  const submit = useCallback(async () => {
    if (submitting || !password) return;
    const requestId = request.id;
    setSubmitting(true);
    setError(null);
    const enteredPassword = password;
    const result = await approveNewServerUrl(requestId, enteredPassword, cleartextApproved);
    if (result.ok) {
      showToast('Server connection updated.');
      return;
    }
    if (result.kind === 'stale') return;
    if (result.terminal || serverRotationCoordinator.getSnapshot()?.id !== requestId) {
      showToast(result.message, { durationMs: 6_000 });
      return;
    }
    if (!mounted.current) return;
    setPassword('');
    setSubmitting(false);
    setError(result.message);
  }, [cleartextApproved, password, request, submitting]);

  const cleartextMissing = request.requiresCleartextApproval && !cleartextApproved;
  const approveDisabled = !password || cleartextMissing || submitting;

  return (
    <Modal
      visible
      transparent
      animationType={reduceMotion === false ? 'fade' : 'none'}
      onRequestClose={cancel}
      statusBarTranslucent
    >
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <View style={styles.backdrop}>
          <Pressable accessible={false} style={styles.backdropDismiss} onPress={cancel} />
          <View
            accessibilityViewIsModal
            style={[
              styles.card,
              {
                backgroundColor: theme.color.background,
                borderRadius: theme.radius.card,
                borderColor: theme.color.separator,
              },
            ]}
          >
            <ScrollView
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
              bounces={false}
            >
              <Text style={[styles.title, { color: theme.color.label }]}>
                Approve server change?
              </Text>
              <Text style={[styles.explanation, { color: theme.color.secondaryLabel }]}>
                Your current server asked Gator to use a different address. Confirm the exact
                destination and re-enter your current server password before Gator contacts it.
              </Text>

              <View
                style={[styles.originBlock, { backgroundColor: theme.color.secondaryBackground }]}
              >
                <Text style={[styles.originLabel, { color: theme.color.secondaryLabel }]}>
                  Current server
                </Text>
                <Text selectable style={[styles.originValue, { color: theme.color.label }]}>
                  {request.currentOrigin}
                </Text>
              </View>
              <View
                style={[styles.originBlock, { backgroundColor: theme.color.secondaryBackground }]}
              >
                <Text style={[styles.originLabel, { color: theme.color.secondaryLabel }]}>
                  Proposed server
                </Text>
                <Text selectable style={[styles.originValue, { color: theme.color.label }]}>
                  {request.candidateOrigin}
                </Text>
              </View>

              {request.requiresCleartextApproval ? (
                <View style={styles.cleartextRow}>
                  <View style={styles.cleartextCopy}>
                    <Text style={[styles.warningTitle, { color: theme.color.destructive }]}>
                      Insecure connection
                    </Text>
                    <Text style={[styles.warningBody, { color: theme.color.secondaryLabel }]}>
                      This http:// address does not encrypt your password or messages in transit.
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel="Allow insecure server change"
                    value={cleartextApproved}
                    onValueChange={setCleartextApproved}
                    disabled={submitting}
                  />
                </View>
              ) : null}

              <TextField
                label="Server password"
                placeholder="Re-enter current password"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={() => {
                  if (!approveDisabled) void submit();
                }}
                editable={!submitting}
                returnKeyType="go"
              />

              {error ? (
                <View
                  accessible
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  style={styles.errorWrap}
                >
                  <Text style={[styles.error, { color: theme.color.destructive }]}>{error}</Text>
                </View>
              ) : null}

              <View style={styles.actions}>
                <Button
                  title="Cancel"
                  variant="tinted"
                  disabled={submitting}
                  onPress={cancel}
                  style={styles.action}
                />
                <Button
                  title="Approve server change"
                  loading={submitting}
                  disabled={approveDisabled}
                  accessibilityHint="Validates the proposed server, then saves and reconnects"
                  onPress={() => void submit()}
                  style={styles.action}
                />
              </View>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 32,
    backgroundColor: 'rgba(0,0,0,0.68)',
  },
  backdropDismiss: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  card: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '92%',
    alignSelf: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  content: { padding: 20 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  explanation: { fontSize: 15, lineHeight: 21, marginBottom: 18 },
  originBlock: { padding: 12, borderRadius: 10, marginBottom: 12 },
  originLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 5 },
  originValue: { fontSize: 15, lineHeight: 21 },
  cleartextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 4,
    marginBottom: 18,
  },
  cleartextCopy: { flex: 1 },
  warningTitle: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  warningBody: { fontSize: 13, lineHeight: 18 },
  errorWrap: { marginTop: -4, marginBottom: 12 },
  error: { fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  action: { flex: 1 },
});
