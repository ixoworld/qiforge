import { Logger } from '@ixo/logger';
import { config } from 'dotenv';
import z from 'zod';

config();

export class EnvService<T extends z.ZodType> {
  private static instance: EnvService<z.ZodType> | null = null;
  private readonly validatedEnv: z.infer<T>;

  private constructor(schema: T, onError?: (error: z.ZodError) => void) {
    try {
      // Parse and validate environment variables
      this.validatedEnv = schema.parse(process.env);
    } catch (error) {
      if (error instanceof z.ZodError) {
        if (onError) {
          onError(error);
          return;
        }
        Logger.error('Environment validation failed:' + error.message);
      }
      throw error;
    }
  }

  /**
   * Initialize the environment service with a schema
   * @param schema - Zod schema to validate environment variables
   * @returns EnvService instance
   */
  public static initialize<S extends z.ZodType>(schema: S): EnvService<S> {
    if (EnvService.instance === null) {
      EnvService.instance = new EnvService(schema);
    }
    return EnvService.instance;
  }

  /**
   * Get the singleton instance of EnvService
   * @throws Error if service hasn't been initialized
   */
  public static getInstance<S extends z.ZodType>(): EnvService<S> {
    if (EnvService.instance === null) {
      throw new Error('EnvService must be initialized with a schema first');
    }
    return EnvService.instance;
  }

  /**
   * Get all validated environment variables
   */
  public getAll(): z.infer<T> {
    return this.validatedEnv;
  }

  /**
   * Get a specific environment variable
   * @param key - The key of the environment variable
   */
  public get<K extends keyof z.infer<T>>(key: K): z.infer<T>[K] {
    return this.validatedEnv[key];
  }
}
