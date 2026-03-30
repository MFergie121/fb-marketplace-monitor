export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export function createLogger(debugEnabled: boolean): Logger {
  return {
    info(message: string) {
      console.log(formatLog('INFO', message));
    },
    debug(message: string) {
      if (debugEnabled) {
        console.log(formatLog('DEBUG', message));
      }
    },
    warn(message: string) {
      console.warn(formatLog('WARN', message));
    },
    error(message: string) {
      console.error(formatLog('ERROR', message));
    }
  };
}

function formatLog(level: 'INFO' | 'DEBUG' | 'WARN' | 'ERROR', message: string): string {
  return `[fbm][${new Date().toISOString()}][${level}] ${message}`;
}
