"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Shared, app-wide modal manager that replaces native
 * `window.alert/confirm/prompt`. The provider is mounted once near the
 * top of the secure tree; consumers use the `useDialogs()` hook to open
 * a dialog imperatively and `await` the result.
 *
 * Three primitives are exposed:
 *
 *   - `notify({ title?, description, variant? })` — informational or
 *     error toast-style modal with a single "OK" button. Replaces
 *     `alert()`. Resolves when the user dismisses.
 *   - `confirm({ title, description, confirmLabel?, cancelLabel?,
 *      destructive? })` — destructive confirmation modal. Replaces
 *     `window.confirm()`. Resolves with `true` if confirmed, `false`
 *     otherwise (ESC or Cancel; overlay clicks do not dismiss an
 *     AlertDialog, so the promise stays pending until a choice is made).
 *   - `promptText({ title, description?, label, defaultValue?,
 *      placeholder?, required?, confirmLabel?, cancelLabel? })` — text
 *     input modal. Replaces `window.prompt()`. Resolves with the entered
 *     string on submit, `null` on cancel.
 *
 * The dialogs are visually consistent with the existing impersonation
 * confirmation (AlertDialog primitive) so the entire admin surface
 * shares one look-and-feel.
 */

type Variant = "default" | "destructive";

interface NotifyOptions {
  title?: string;
  description: string;
  variant?: Variant;
  confirmLabel?: string;
}

interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PromptOptions {
  title: string;
  description?: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DialogContextValue {
  notify: (options: NotifyOptions) => Promise<void>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  promptText: (options: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialogs(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialogs must be used within <DialogManagerProvider>");
  }
  return ctx;
}

type NotifyState = NotifyOptions & { resolve: () => void };
type ConfirmState = ConfirmOptions & { resolve: (v: boolean) => void };
type PromptState = PromptOptions & {
  resolve: (v: string | null) => void;
  /** Monotonic instance id — keys the prompt form so a new prompt
   * mounts with fresh input state (no ref-based reset during render). */
  id: number;
};

export function DialogManagerProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("common.dialogs");
  const [notifyState, setNotifyState] = useState<NotifyState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);

  const notify = useCallback((options: NotifyOptions) => {
    return new Promise<void>((resolve) => {
      setNotifyState({ ...options, resolve });
    });
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...options, resolve });
    });
  }, []);

  const promptSeq = useRef(0);
  const promptText = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      promptSeq.current += 1;
      setPromptState({ ...options, resolve, id: promptSeq.current });
    });
  }, []);

  const value = useMemo<DialogContextValue>(
    () => ({ notify, confirm, promptText }),
    [notify, confirm, promptText],
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
      <NotifyDialog
        state={notifyState}
        defaultTitle={t("notifyTitle")}
        defaultOk={t("ok")}
        onClose={() => {
          notifyState?.resolve();
          setNotifyState(null);
        }}
      />
      <ConfirmDialog
        state={confirmState}
        defaultConfirm={t("confirm")}
        defaultCancel={t("cancel")}
        onResult={(value) => {
          confirmState?.resolve(value);
          setConfirmState(null);
        }}
      />
      <PromptDialog
        state={promptState}
        defaultConfirm={t("ok")}
        defaultCancel={t("cancel")}
        onResult={(value) => {
          promptState?.resolve(value);
          setPromptState(null);
        }}
      />
    </DialogContext.Provider>
  );
}

function NotifyDialog({
  state,
  defaultTitle,
  defaultOk,
  onClose,
}: {
  state: NotifyState | null;
  defaultTitle: string;
  defaultOk: string;
  onClose: () => void;
}) {
  const open = state !== null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{state?.title ?? defaultTitle}</AlertDialogTitle>
          <AlertDialogDescription
            className={cn(state?.variant === "destructive" && "text-destructive")}
          >
            {state?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => onClose()}>
            {state?.confirmLabel ?? defaultOk}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConfirmDialog({
  state,
  defaultConfirm,
  defaultCancel,
  onResult,
}: {
  state: ConfirmState | null;
  defaultConfirm: string;
  defaultCancel: string;
  onResult: (value: boolean) => void;
}) {
  const open = state !== null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onResult(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{state?.title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {state?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onResult(false)}>
            {state?.cancelLabel ?? defaultCancel}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              state?.destructive &&
                "bg-destructive hover:bg-destructive/90 focus-visible:ring-destructive/20 text-destructive-foreground",
            )}
            onClick={() => onResult(true)}
          >
            {state?.confirmLabel ?? defaultConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PromptDialog({
  state,
  defaultConfirm,
  defaultCancel,
  onResult,
}: {
  state: PromptState | null;
  defaultConfirm: string;
  defaultCancel: string;
  onResult: (value: string | null) => void;
}) {
  const open = state !== null;
  const t = useTranslations("common.dialogs");

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onResult(null);
      }}
    >
      <DialogContent closeLabel={t("close")}>
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          {state?.description ? <DialogDescription>{state.description}</DialogDescription> : null}
        </DialogHeader>
        {state ? (
          // Keyed by the prompt instance id: each new prompt mounts a
          // fresh form with its own input state — no ref bookkeeping or
          // render-phase resets.
          <PromptForm
            key={state.id}
            state={state}
            defaultConfirm={defaultConfirm}
            defaultCancel={defaultCancel}
            onResult={onResult}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PromptForm({
  state,
  defaultConfirm,
  defaultCancel,
  onResult,
}: {
  state: PromptState;
  defaultConfirm: string;
  defaultCancel: string;
  onResult: (value: string | null) => void;
}) {
  const [value, setValue] = useState(state.defaultValue ?? "");

  const submit = () => {
    if (state.required && value.trim() === "") return;
    onResult(value);
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="text-sm font-medium" htmlFor="dialog-prompt-input">
        {state.label}
      </label>
      <Input
        id="dialog-prompt-input"
        autoFocus
        value={value}
        placeholder={state.placeholder}
        onChange={(e) => setValue(e.target.value)}
      />
      <DialogFooter className="pt-2">
        <Button type="button" variant="outline" onClick={() => onResult(null)}>
          {state.cancelLabel ?? defaultCancel}
        </Button>
        <Button type="submit" disabled={state.required ? value.trim() === "" : false}>
          {state.confirmLabel ?? defaultConfirm}
        </Button>
      </DialogFooter>
    </form>
  );
}
