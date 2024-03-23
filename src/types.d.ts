import { Request, Response } from '@adobe/fetch';
import { Helix } from '@adobe/helix-universal';

declare global {
  export type RRequest = typeof Request;
  export type RResponse = typeof Response;
  export type UniversalContext = Helix.UniversalContext;

  export interface RawRUMEvent {
    time: number;
    host: string;
    url: string;
    user_agent: string;
    referer: string | null;
    weight: number;
    id: string;
    CLS: number;
    LCP: number;
    FID: number;
  }

  export interface RUMEvent {
    checkpoint: string;
    time: string;
    value?: number;
    source?: string;
    target?: string;
  }

  // each event group has a single id
  export interface RUMEventGroup {
    id: string;
    time: string;
    timeSlot: string;
    url: string;
    user_agent: string;
    weight: number;
    events: RUMEvent[];
  }

  export interface BundleData {
    /**
     * each bundle is all event groups belonging to an hour/date/month/year, for a single domain
     * key is the event group id
     */
    groups: Record<string, RUMEventGroup>;
  }

  /**
   * Data to relate new events to existing sessions from past 24h.
   */
  export interface SessionData {
    hour: number;
  }

  export interface ManifestData {
    /**
     * session id (id from RUM event) => session data
     */
    sessions: Record<string, SessionData>;
  }
}