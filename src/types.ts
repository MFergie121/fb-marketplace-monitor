export type SearchProfile = {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  category?: string;
  brandPreferences: string[];
  keywords?: string[];
  maxPrice?: number;
  minPrice?: number;
  locationLabel?: string;
};

export type AppConfig = {
  profiles: SearchProfile[];
};

export type RawListing = {
  externalId: string;
  title: string;
  url: string;
  price?: number | null;
  currency?: string | null;
  location?: string | null;
  imageUrl?: string | null;
  sellerName?: string | null;
  description?: string | null;
  postedText?: string | null;
};

export type ListingObservation = RawListing & {
  profileId: string;
  observedAt: string;
};

export type ScoreReasonCode =
  | 'BRAND_MATCH'
  | 'KEYWORD_MATCH'
  | 'PRICE_UNDER_MAX'
  | 'PRICE_OVER_MAX'
  | 'MISSING_PRICE'
  | 'NEW_LISTING'
  | 'LOCATION_MATCH';

export type ScoreReason = {
  code: ScoreReasonCode;
  weight: number;
  detail: string;
};

export type ScoredObservation = ListingObservation & {
  score: number;
  reasons: ScoreReason[];
  isNewListing: boolean;
};

export type RunStatus = 'success' | 'partial' | 'failed' | 'suspicious_empty';

export type RunResult = {
  runId: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  profileSummaries: Array<{
    profileId: string;
    collected: number;
    suspiciousEmpty: boolean;
  }>;
  digest: string;
};

export type MockInput = {
  profiles: Array<{
    profileId: string;
    items: RawListing[];
  }>;
};
