export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
