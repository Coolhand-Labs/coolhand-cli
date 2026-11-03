/** `COOLHAND_CAPTURE_DISABLED=1|true|yes`: the kill switch for people who didn't choose to run a skill's hook. */
export function isCaptureDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.COOLHAND_CAPTURE_DISABLED ?? '');
}
