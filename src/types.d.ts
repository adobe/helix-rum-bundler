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

  // each bundle is all event groups belonging to an hour/date/month/year, for a single domain
  export type RUMBundle = RUMEventGroup[];
}