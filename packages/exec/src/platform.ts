const POSIX_ONLY_ERROR =
  "@kimi-next/exec is POSIX-only (darwin/linux); Windows is not supported";

let asserted = false;

export function assertPosix(): void {
  if (process.platform === "win32") {
    throw new Error(POSIX_ONLY_ERROR);
  }
  asserted = true;
}

export function posixChecked(): boolean {
  return asserted;
}
