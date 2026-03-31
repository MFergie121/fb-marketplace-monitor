export type ValuationAssessment = 'attractive' | 'fair' | 'uncertain' | 'overpriced' | 'withheld';

export type ListingType = 'single_item' | 'bundle_or_set' | 'accessory_service_modification' | 'ambiguous';
export type ListingTypeConfidence = 'high' | 'medium' | 'low';
export type ListingTypeScope = 'single_item' | 'bundle_or_set' | 'accessory_service_modification' | 'any';

export type SearchExpansion = {
  label: string;
  query: string;
};

export type ValuationReference = {
  label: string;
  matchTerms: string[];
  priceLow: number;
  priceHigh: number;
  confidence?: 'high' | 'medium' | 'low';
  notes?: string;
  listingTypeScope?: ListingTypeScope;
};

export type ValuationHeuristicRule = {
  key: string;
  appliesWhen: string[];
  referenceLow: number;
  referenceHigh: number;
  note: string;
  listingTypeScope?: ListingTypeScope;
};

export type ValuationSource = {
  source: 'manual_reference' | 'category_heuristic' | 'local_baseline';
  label: string;
  priceLow: number;
  priceHigh: number;
  confidence: 'high' | 'medium' | 'low';
  detail: string;
  listingTypeScope?: ListingTypeScope;
};

export type ListingClassification = {
  listingType: ListingType;
  confidence: ListingTypeConfidence;
  summary: string;
  matchedSignals: string[];
  identifiedComponents: string[];
  canDecomposeBundle: boolean;
};

export type ValuationContext = {
  assessment: ValuationAssessment;
  summary: string;
  price: number | null;
  matchedReferenceLabel?: string;
  confidence: 'high' | 'medium' | 'low';
  sources: ValuationSource[];
  classification: ListingClassification;
};

export type SearchProfile = {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  category?: string;
  brandPreferences: string[];
  keywords?: string[];
  modelFamilies?: string[];
  unwantedKeywords?: string[];
  maxPrice?: number;
  minPrice?: number;
  locationLabel?: string;
  searchExpansions?: SearchExpansion[];
  valuationReferences?: ValuationReference[];
};

export type AppConfig = {
  profiles: SearchProfile[];
};

export type TitleConfidence = 'high' | 'medium' | 'low';

export type RawListing = {
  externalId: string;
  title: string;
  url: string;
  price?: number | null;
  priceText?: string | null;
  currency?: string | null;
  location?: string | null;
  imageUrl?: string | null;
  sellerName?: string | null;
  description?: string | null;
  postedText?: string | null;
  condition?: string | null;
  detailCollectedAt?: string | null;
  titleConfidence?: TitleConfidence;
  parserNotes?: string[];
};

export type ListingObservation = RawListing & {
  profileId: string;
  observedAt: string;
};

export type ScoreReasonCode =
  | 'BRAND_MATCH'
  | 'KEYWORD_MATCH'
  | 'MODEL_FAMILY_MATCH'
  | 'PRICE_UNDER_MAX'
  | 'PRICE_OVER_MAX'
  | 'MISSING_PRICE'
  | 'NEW_LISTING'
  | 'LOCATION_MATCH'
  | 'LOW_TITLE_CONFIDENCE'
  | 'TITLE_PARSE_FALLBACK'
  | 'TITLE_LOOKS_LIKE_PRICE'
  | 'PLACEHOLDER_PRICE'
  | 'SUSPICIOUS_PRICE_PATTERN'
  | 'FROM_PRICE_PATTERN'
  | 'QUICK_SALE_PHRASE'
  | 'BULK_MIXED_WORDING'
  | 'UNWANTED_VARIANT'
  | 'SPEC_CUE'
  | 'SPECIFIC_LISTING'
  | 'SINGLE_ITEM_SIGNAL'
  | 'VAGUE_LISTING'
  | 'LISTING_TYPE_SINGLE_ITEM'
  | 'LISTING_TYPE_BUNDLE'
  | 'LISTING_TYPE_ACCESSORY_SERVICE'
  | 'LISTING_TYPE_AMBIGUOUS'
  | 'VALUATION_ATTRACTIVE'
  | 'VALUATION_FAIR'
  | 'VALUATION_UNCERTAIN'
  | 'VALUATION_OVERPRICED'
  | 'VALUATION_WITHHELD';

export type ScoreReason = {
  code: ScoreReasonCode;
  weight: number;
  detail: string;
};

export type ScoredObservation = ListingObservation & {
  score: number;
  reasons: ScoreReason[];
  isNewListing: boolean;
  valuation: ValuationContext;
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
    enriched: number;
    suspiciousEmpty: boolean;
    status: 'success' | 'failed';
    errorMessage: string | null;
  }>;
  digest: string;
  digests: {
    discord: string;
    email: string;
  };
};

export type MockInput = {
  profiles: Array<{
    profileId: string;
    items: RawListing[];
  }>;
};
