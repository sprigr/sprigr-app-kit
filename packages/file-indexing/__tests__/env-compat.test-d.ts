/**
 * Type-level: a real app env, typed with @sprigr/apps-app-sdk 0.14.0 (the
 * version this package pins), satisfies FileIndexingEnv with NO cast. The
 * first shape is google-workspace's GwsEnv as it stands on sprigr-apps
 * staging (interfaces throughout, an app-local extract surface on top of the
 * SDK's SprigrFilesApiWithEdit); the second uses only the SDK's own bridge
 * types. Run by `vitest run` (typecheck enabled in vitest.config.ts), so a
 * regression fails CI rather than the next app migration.
 *
 * Regression for the first cut of 0.1.0: FilesJobResult carried an index
 * signature, the SDK's SprigrFilesJobResult is an interface without one, and
 * `GwsEnv extends FileIndexingEnv` failed.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type {
  D1Like,
  SprigrDataApi as SdkSprigrDataApi,
  SprigrFilesApiWithEdit as SdkSprigrFilesApiWithEdit,
} from '@sprigr/apps-app-sdk';
import { indexActorFiles, type FileIndexingEnv, type FileIndexingStore, type FileSourceAdapter } from '../src';

interface AppExtractInput {
  file_key: string;
  format?: 'pdf' | 'docx' | 'xlsx' | 'pptx';
  max_chars?: number;
  job_token?: string;
}
interface AppExtractResult {
  ok: boolean;
  text?: string;
  char_count?: number;
  truncated?: boolean;
  format?: string;
  needs_job?: boolean;
  job_token?: string;
  error?: string;
}
interface AppFilesApi extends SdkSprigrFilesApiWithEdit {
  extract?(input: AppExtractInput): Promise<AppExtractResult>;
}
interface AppDataApi {
  import(
    objects: Array<{ objectID: string; [key: string]: unknown }>,
    opts?: { withAcl?: boolean },
  ): Promise<{ ok: boolean; indexed: number; index: string }>;
  delete?(objectIDs: string[], opts?: { withAcl?: boolean }): Promise<{ ok: boolean; deleted: number; index: string }>;
  listIds?(
    prefix: string,
    opts?: { withAcl?: boolean },
  ): Promise<{ ok: boolean; objectIDs: string[]; total: number; truncated: boolean; index: string }>;
}
/** google-workspace's GwsEnv shape. */
interface GwsLikeEnv {
  DB: D1Like;
  GOOGLE_CLIENT_ID: string;
  SPRIGR_PLATFORM_BASE?: string;
  SPRIGR_INSTALL_TOKEN?: string;
  SPRIGR?: {
    files?: AppFilesApi;
    data?: AppDataApi;
    emit?(event: string, payload: unknown): Promise<{ ok: boolean; eventId?: string }>;
    acl?: {
      linkIdentity(owner: { kind: 'user' | 'agent'; id: string }, email: string): Promise<unknown>;
      unlinkIdentity(owner: { kind: 'user' | 'agent'; id: string }, email?: string): Promise<unknown>;
    };
  };
  [key: string]: unknown;
}
/** Only the SDK's own bridge types, as an app on 0.14.0 with no local additions would write. */
interface SdkOnlyEnv {
  DB: D1Like;
  SPRIGR?: {
    files?: SdkSprigrFilesApiWithEdit;
    data?: SdkSprigrDataApi;
    emit?(event: string, payload: unknown): Promise<{ ok: boolean; eventId?: string }>;
  };
}

/** Compiles only when T satisfies the constraint, with no cast at the call site. */
function acceptsEnv<T extends FileIndexingEnv>(env: T): T {
  return env;
}

describe('FileIndexingEnv accepts real app envs with no cast', () => {
  it('google-workspace GwsEnv shape', () => {
    const env = {} as GwsLikeEnv;
    expectTypeOf(acceptsEnv(env)).toEqualTypeOf<GwsLikeEnv>();
    const asBase: FileIndexingEnv = env;
    void asBase;
    const adapter = {} as FileSourceAdapter<unknown, GwsLikeEnv>;
    void (() => indexActorFiles(adapter, {} as FileIndexingStore, env, { actor: { platformUserId: 'u' } }));
  });
  it('an env typed only with app-sdk 0.14.0 bridge types', () => {
    const env = {} as SdkOnlyEnv;
    expectTypeOf(acceptsEnv(env)).toEqualTypeOf<SdkOnlyEnv>();
    const asBase: FileIndexingEnv = env;
    void asBase;
    const adapter = {} as FileSourceAdapter<unknown, SdkOnlyEnv>;
    void (() => indexActorFiles(adapter, {} as FileIndexingStore, env, { actor: { platformUserId: 'u' } }));
  });
});
