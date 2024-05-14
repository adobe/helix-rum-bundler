import { Request, Response, keepAliveNoCache } from '@adobe/fetch';
import { Helix } from '@adobe/helix-universal';
import BundleGroup from './BundleGroup';
import Manifest from './Manifest';
import LRUCache from './LRUCache';

declare module '@adobe/helix-universal' {
  export namespace Helix {
    export interface UniversalContext {
      env: {
        /** 
         * concurrency for bundling steps that call s3 client operations
         * should be lower for local dev
         */
        CONCURRENCY_LIMIT?: string;
        /** 
         * log file count maximum to process per batch of bundling 
         */
        BATCH_LIMIT?: string;
        /** 
         * key to use for auth to add domainkey to runquery
         */
        RUNQUERY_ROTATION_KEY?: string;
        /** 
         * key that allows invoking the bundler process on the deployed function 
         */
        INVOKE_BUNDLER_KEY?: string;
        /**
         * maximum duration for bundler process in milliseconds
         */
        BUNDLER_DURATION_LIMIT?: string;
        /**
         * cdn url for the bundler api
         */
        CDN_ENDPOINT: string;
        /**
         * temporary known superuser key for access to domainkey api
         */
        TMP_SUPERUSER_API_KEY: string;
        /**
         * fastly api key, capable of purging cache by surrogate key
         */
        FASTLY_API_KEY: string;
        /**
         * fastly service id
         */
        FASTLY_SERVICE_ID: string;
        [key: string]: string;
      }

      attributes: {
        fetchContext?: ReturnType<typeof keepAliveNoCache>;
        rumManifests: LRUCache<Manifest | Promise<Manifest>>;
        rumBundleGroups: LRUCache<BundleGroup | Promise<BundleGroup>>;
        [key: string]: unknown;
      }

      data: Record<string, string>;
    }
  }
}

declare global {
  export type RRequest = Request;
  export type RResponse = Response;
  export type UniversalContext = Helix.UniversalContext;

  export interface RawRUMEvent {
    checkpoint: string;
    time: number;
    host: string;
    url: string;
    user_agent: string;
    referer: string | null;
    weight: number;
    id: string;
    INP?: number;
    TTFB?: number;
    CLS?: number;
    LCP?: number;
    FID?: number;
    [key: string]: string | number | null | undefined;
  }

  export interface RUMEvent {
    checkpoint: string;
    timeDelta?: number;
    value?: number;
    source?: string;
    target?: string;
  }

  export interface RUMBundle {
    id: string;
    time: string;
    timeSlot: string;
    url: string;
    userAgent: string;
    weight: number;
    events: RUMEvent[];
  }

  /**
   * collection of bundles belonging to an hour/date/month/year, for a single domain
   */
  export interface BundleGroupData {
    /** 
     * `{id}--{path}` => bundle
     */
    bundles: Record<string, RUMBundle>;
  }

  /**
   * Data to relate new events to existing sessions from past 24h.
   */
  export interface SessionData {
    hour: number;
  }

  export interface ManifestData {
    /**
     * `{id}--{path}` => session data
     */
    sessions: Record<string, SessionData>;
  }

  export interface BundleInfo {
    domain: string;
    year: number;
    month: number;
    day: number;
    hour: number;
  }

  /**
   * RUM runquery specific types
   */

  export interface RunQueryEvent {
    /** ex. '2024-03-21T21:00:01+00:00' */
    time: string;
    /** ex. 'viewmedia' */
    checkpoint: string;
    source: string | null;
    /** ex. 'https://www.adobe.com/2024/media_194022c145d5d86e5165cdaa68a9401f3c9531312.png' */
    target: string | null;
    value: number | null;
  }

  export interface RunQueryBundle {
    id: string;
    /** ex. 'https://www.adobe.com/' */
    url: string;
    /** ex. '2024-03-21T00:00:00+00:00' */
    time: string;
    weight: number;
    /** ex. 'desktop' */
    user_agent: string;
    events: RunQueryEvent[];
  }

  export interface VirtualDestination {
    /**
     * Virtual bundle file ke
     */
    key: string;
    /**
     * Virtual bundle info
     */
    info: BundleInfo;
    /**
     * Optional override of raw event.
     * If not defined uses regular raw event.
     */
    event?: RawRUMEvent;
  }
}