import { Request, Response } from '@adobe/fetch';
import { Helix } from '@adobe/helix-universal';

declare global {
  export type RRequest = Request;
  export type RResponse = Response;
  export type UniversalContext = Helix.UniversalContext;

  export interface RawRUMEvent {
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
    [key: string]: string | number | null;
  }

  export interface RUMEvent {
    checkpoint: string;
    timeDiff: string;
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
}