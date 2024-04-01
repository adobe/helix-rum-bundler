import { Helix } from '@adobe/helix-universal';
import type BundleGroup from './Bundle';
import type Manifest from './Manifest';

declare module '@adobe/helix-universal' {
  export namespace Helix {
    export interface UniversalContext {
      env: {
        CONCURRENCY_LIMIT?: string;
        BATCH_LIMIT?: string;
        [key: string]: string;
      }

      attributes: {
        rumManifests?: Record<string, Manifest>;
        rumBundleGroups: Record<string, BundleGroup | Promise<BundleGroup>>;
        [key: string]: unknown;
      }

      data: Record<string, string>;
    }
  }
}