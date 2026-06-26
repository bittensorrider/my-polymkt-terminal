// Small dependency-free leveled logger. Kept intentionally simple — this is a
// trading bot meant to run under PM2/systemd/tmux where plain stdout lines
// piped to a log file matter more than structured logging.

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
} as const;

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function emit(
  color: string,
  label: string,
  msg: string,
  rest: unknown[],
): void {
  const prefix = `${COLORS.dim}${timestamp()}${COLORS.reset} ${color}${label}${COLORS.reset}`;
  if (rest.length > 0) {
    console.log(prefix, msg, ...rest);
  } else {
    console.log(prefix, msg);
  }
}

export const logger = {
  debug(msg: string, ...rest: unknown[]): void {
    if (process.env.LOG_LEVEL === "debug") emit(COLORS.dim, "DEBUG", msg, rest);
  },
  info(msg: string, ...rest: unknown[]): void {
    emit(COLORS.blue, "INFO ", msg, rest);
  },
  success(msg: string, ...rest: unknown[]): void {
    emit(COLORS.green, "OK   ", msg, rest);
  },
  warn(msg: string, ...rest: unknown[]): void {
    emit(COLORS.yellow, "WARN ", msg, rest);
  },
  error(msg: string, ...rest: unknown[]): void {
    emit(COLORS.red, "ERROR", msg, rest);
  },
  trade(msg: string, ...rest: unknown[]): void {
    emit(COLORS.magenta, "TRADE", msg, rest);
  },
};
