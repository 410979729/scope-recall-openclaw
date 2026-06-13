declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    config?: unknown;
    registrationMode?: string;
    logger: {
      debug(...args: unknown[]): void;
      info(...args: unknown[]): void;
      warn(...args: unknown[]): void;
      error(...args: unknown[]): void;
    };
    resolvePath(path: string): string;
    registerTool(
      factory: (toolContext?: Record<string, unknown>) => unknown,
      metadata?: { name?: string },
    ): void;
    registerCli(
      register: unknown,
      metadata?: { commands?: string[] },
    ): void;
    on(
      event: string,
      handler: (...args: any[]) => unknown,
      options?: Record<string, unknown>,
    ): void;
    registerHook(
      event: string,
      handler: (...args: any[]) => unknown,
      options?: Record<string, unknown>,
    ): void;
    registerService(service: Record<string, unknown>): void;
  }
}

declare module "commander" {
  export interface Command {
    command(nameAndArgs: string): Command;
    alias(name: string): Command;
    description(value: string): Command;
    option(flags: string, description?: string, defaultValue?: unknown): Command;
    requiredOption(flags: string, description?: string, defaultValue?: unknown): Command;
    action(handler: (...args: any[]) => unknown): Command;
  }
}
