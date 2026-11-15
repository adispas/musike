import { CheckIcon, ScreencastIcon, SpeakerHifiIcon, TelevisionSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { castBackend, useCast, type CastDevice } from "../cast/cast";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";

/** Android TV is a cast target itself, so it gets no cast button. */
const castUi = () => castBackend !== null && document.documentElement.dataset.tv !== "1";

/** Opens the device picker; lit up while casting. */
export function CastButton({ size = "sm", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const t = useT();
  const device = useCast((s) => s.device);
  const openPicker = useCast((s) => s.openPicker);
  if (!castUi()) return null;
  return (
    <IconButton
      label={device ? t.cast.castingTo(device.name) : t.cast.castTo}
      active={!!device}
      size={size}
      onClick={openPicker}
      className={className}
    >
      <ScreencastIcon size={size === "lg" ? 24 : size === "md" ? 21 : 18} weight={device ? "fill" : "regular"} />
    </IconButton>
  );
}

/** "Casting to Kitchen" under the controls, so it's clear where the sound is coming from. */
export function CastingNote({ className }: { className?: string }) {
  const t = useT();
  const device = useCast((s) => s.device);
  const openPicker = useCast((s) => s.openPicker);
  if (!device) return null;
  return (
    <button
      type="button"
      onClick={openPicker}
      className={cn(
        "mx-auto flex h-8 max-w-full items-center gap-2 truncate rounded-full bg-accent-soft px-3 text-[13px] font-medium text-accent-text",
        className,
      )}
    >
      <ScreencastIcon size={15} weight="fill" className="shrink-0" />
      <span className="truncate">{t.cast.castingTo(device.name)}</span>
    </button>
  );
}

const isSpeaker = (d: CastDevice) => /nest|home|speaker|audio|mini|max|hub/i.test(`${d.model ?? ""}`) && !/tv|chromecast/i.test(d.model ?? "");

/** The devices on the network, and "Stop casting" while connected. Discovery runs while it's open. */
export function CastPicker() {
  const t = useT();
  const open = useCast((s) => s.pickerOpen);
  const close = useCast((s) => s.closePicker);
  const devices = useCast((s) => s.devices);
  const device = useCast((s) => s.device);
  const connecting = useCast((s) => s.connecting);
  const connect = useCast((s) => s.connect);
  const disconnect = useCast((s) => s.disconnect);
  // After a while with nothing found, say what to check instead of spinning forever.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!open) return;
    const id = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(id);
  }, [open]);

  return (
    <Modal open={open} onClose={close} title={t.cast.pickerTitle}>
      <div className="flex flex-col gap-1">
        {devices.length === 0 && !device && (
          <p className="flex items-center gap-3 px-1 py-6 text-sm text-fg-2">
            {!slow && <span className="block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            {slow ? t.cast.noneFound : t.cast.searching}
          </p>
        )}
        {devices.map((d) => {
          const current = device?.id === d.id;
          const busy = connecting === d.id;
          const Glyph = isSpeaker(d) ? SpeakerHifiIcon : TelevisionSimpleIcon;
          return (
            <button
              key={d.id}
              type="button"
              disabled={!!connecting || current}
              onClick={() => void connect(d.id)}
              className={cn(
                "flex min-h-14 items-center gap-3 rounded-xl px-3 text-left transition-colors hover:bg-surface-3 disabled:hover:bg-transparent",
                current && "text-accent-text",
              )}
            >
              <Glyph size={22} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{d.name}</span>
                <span className="block truncate text-[12px] text-fg-3">
                  {busy ? t.cast.connecting : current ? t.cast.connected : d.model}
                </span>
              </span>
              {busy && <span className="block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              {current && <CheckIcon size={18} />}
            </button>
          );
        })}
        {device && (
          <>
            <p className="px-1 pt-3 text-[12px] text-fg-3">{t.cast.audioOnly}</p>
            <button
              type="button"
              onClick={() => void disconnect()}
              className="mt-3 flex h-11 items-center justify-center rounded-full bg-surface-1 text-sm font-medium ring-1 ring-line transition-colors hover:bg-surface-3"
            >
              {t.cast.stop}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
