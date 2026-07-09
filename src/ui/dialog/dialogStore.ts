import { create } from 'zustand';

export type DialogButtonStyle = 'default' | 'cancel' | 'destructive';

/** One button in a dialog. Mirrors React Native's `Alert.alert` button shape so migrating a
 *  call site is a near 1:1 swap. */
export interface DialogButton {
  text: string;
  style?: DialogButtonStyle;
  onPress?: () => void;
}

export interface DialogRequest {
  id: number;
  title: string;
  message?: string;
  buttons: DialogButton[];
}

interface DialogState {
  /** The dialog currently on screen (null = none). */
  current: DialogRequest | null;
  /** Dialogs waiting behind the current one (a confirm's handler may open another). */
  queue: DialogRequest[];
  enqueue: (req: Omit<DialogRequest, 'id'>) => void;
  /** Close the current dialog and promote the next queued one (if any). */
  dismiss: () => void;
}

let nextId = 1;

/**
 * The app-wide themed dialog queue. Replaces React Native's native `Alert.alert` (an unthemed
 * Android Material dialog) with an in-app, iOS-styled card rendered by {@link AppDialog}. A tiny
 * FIFO queue handles the "show another alert from a button handler" case (e.g. a confirm whose
 * action then reports success) without dropping the second dialog.
 */
export const useDialogStore = create<DialogState>((set, get) => ({
  current: null,
  queue: [],
  enqueue: (req) => {
    const full: DialogRequest = { ...req, id: nextId++ };
    if (get().current == null) set({ current: full });
    else set((s) => ({ queue: [...s.queue, full] }));
  },
  dismiss: () =>
    set((s) => {
      const [next, ...rest] = s.queue;
      return { current: next ?? null, queue: rest };
    }),
}));

/**
 * Show a themed dialog. Positional args mirror `Alert.alert(title, message?, buttons?)`, so a call
 * site migrates by renaming `Alert.alert` → `showDialog`. With no buttons it shows a single "OK".
 */
export function showDialog(title: string, message?: string, buttons?: DialogButton[]): void {
  useDialogStore.getState().enqueue({
    title,
    message,
    buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'OK', style: 'default' }],
  });
}

/** Ergonomic confirm (Cancel + one action). `destructive` renders the action in red. */
export function showConfirm(opts: {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}): void {
  showDialog(opts.title, opts.message, [
    { text: opts.cancelText ?? 'Cancel', style: 'cancel', onPress: opts.onCancel },
    {
      text: opts.confirmText ?? 'OK',
      style: opts.destructive ? 'destructive' : 'default',
      onPress: opts.onConfirm,
    },
  ]);
}

/** Ergonomic single-button info/error alert. */
export function showAlert(opts: {
  title: string;
  message?: string;
  buttonText?: string;
  onDismiss?: () => void;
}): void {
  showDialog(opts.title, opts.message, [
    { text: opts.buttonText ?? 'OK', style: 'default', onPress: opts.onDismiss },
  ]);
}
