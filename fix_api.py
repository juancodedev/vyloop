import pathlib

p = pathlib.Path('apps/dashboard/src/lib/api.ts')
s = p.read_text()

# 1. Add types after the TimelineEvent interface
old_timeline_end = """export interface TimelineEvent {
  type: 'customer.created' | 'points.earned' | 'points.redeemed' | 'customer.event' | 'customer.profile_viewed';
  customerName: string;
  description: string;
  timestamp: string;
}

function toRewardPayload(data: Partial<Reward>): Record<string, unknown> {"""

new_timeline_end = """export interface TimelineEvent {
  type: 'customer.created' | 'points.earned' | 'points.redeemed' | 'customer.event' | 'customer.profile_viewed';
  customerName: string;
  description: string;
  timestamp: string;
}

// ============================================================================
// Push Campaigns
// ============================================================================

/** The target of a push campaign: either a single branch or a radius around a point. */
export type PushCampaignTarget =
  | { branch_id: string }
  | { latitude: number; longitude: number; radius_m: number };

/** Payload for composing a push campaign. */
export interface PushCampaignPayload {
  title: string;
  body: string;
  url?: string;
  reference_id?: string;
  target: PushCampaignTarget;
  dry_run?: boolean;
}

/** Preview response from dry-run compose. */
export interface PushCampaignPreview {
  reference_id: string;
  audience_size: number;
  per_branch?: Array<{
    branch_id: string;
    name: string;
    distance_m: number;
  }>;
}

/** Summary of a campaign for list views. */
export interface PushCampaignSummary {
  reference_id: string;
  title: string;
  target_type: 'branch' | 'radius';
  audience_size: number;
  delivered: number;
  failed: number;
  skipped: number;
  created_at: string;
}

/** Detailed campaign information. */
export interface PushCampaignDetail {
  reference_id: string;
  title: string;
  body: string;
  url?: string;
  target: PushCampaignTarget;
  target_type: 'branch' | 'radius';
  audience_size: number;
  delivered: number;
  failed: number;
  skipped: number;
  per_branch?: Array<{
    branch_id: string;
    name: string;
    distance_m: number;
    delivered: number;
    failed: number;
  }>;
  created_at: string;
}

function toRewardPayload(data: Partial<Reward>): Record<string, unknown> {"""

if old_timeline_end in s:
    s = s.replace(old_timeline_end, new_timeline_end)
    print("Added types")
else:
    print("ERROR: Could not find timeline end")

# 2. Add methods to api object
old_timeline_method = """  async getTimeline(): Promise<TimelineEvent[]> {
    return apiFetch('/v1/analytics/timeline') as Promise<TimelineEvent[]>;
  },
};"""

new_timeline_method = """  async getTimeline(): Promise<TimelineEvent[]> {
    return apiFetch('/v1/analytics/timeline') as Promise<TimelineEvent[]>;
  },

  // ============================================================================
  // Push Campaigns
  // ============================================================================

  /**
   * List push campaigns with pagination and filters.
   */
  async getPushCampaigns(params: {
    page?: number;
    per_page?: number;
    status?: 'all' | 'sent' | 'failed';
  } = {}): Promise<{
    campaigns: PushCampaignSummary[];
    total: number;
  }> {
    const search = new URLSearchParams();
    if (params.page) search.set('page', String(params.page));
    if (params.per_page) search.set('per_page', String(params.per_page));
    if (params.status && params.status !== 'all') search.set('status', params.status);

    const raw = await apiFetch(`/v1/communication/push/campaigns?${search}`) as {
      campaigns: PushCampaignSummary[];
      total: number;
    };
    return raw;
  },

  /**
   * Compose and send a push campaign.
   *
   * Supports dry_run for audience preview.
   */
  async composePushCampaign(payload: PushCampaignPayload): Promise<PushCampaignPreview> {
    const raw = await apiFetch('/v1/communication/push/campaigns', {
      method: 'POST',
      body: JSON.stringify(payload),
    }) as PushCampaignPreview;
    return raw;
  },

  /**
   * Get detailed information about a specific campaign.
   */
  async getPushCampaignDetail(referenceId: string): Promise<PushCampaignDetail> {
    const raw = await apiFetch(`/v1/communication/push/campaigns/${referenceId}`) as PushCampaignDetail;
    return raw;
  },
};"""

if '  async getTimeline(): Promise<TimelineEvent[]> {' in s:
    s = s.replace(
        '  async getTimeline(): Promise<TimelineEvent[]> {\n    return apiFetch(\'/v1/analytics/timeline\') as Promise<TimelineEvent[]>;\n  },',
        """  async getTimeline(): Promise<TimelineEvent[]> {
    return apiFetch('/v1/analytics/timeline') as Promise<TimelineEvent[]>;
  },

  // ============================================================================
  // Push Campaigns
  // ============================================================================

  /**
   * List push campaigns with pagination and filters.
   */
  async getPushCampaigns(params: {
    page?: number;
    per_page?: number;
    status?: 'all' | 'sent' | 'failed';
  } = {}): Promise<{
    campaigns: PushCampaignSummary[];
    total: number;
  }> {
    const search = new URLSearchParams();
    if (params.page) search.set('page', String(params.page));
    if (params.per_page) search.set('per_page', String(params.per_page));
    if (params.status && params.status !== 'all') search.set('status', params.status);

    const raw = await apiFetch(`/v1/communication/push/campaigns?${search}`) as {
      campaigns: PushCampaignSummary[];
      total: number;
    };
    return raw;
  },

  /**
   * Compose and send a push campaign.
   *
   * Supports dry_run for audience preview.
   */
  async composePushCampaign(payload: PushCampaignPayload): Promise<PushCampaignPreview> {
    const raw = await apiFetch('/v1/communication/push/campaigns', {
      method: 'POST',
      body: JSON.stringify(payload),
    }) as PushCampaignPreview;
    return raw;
  },

  /**
   * Get detailed information about a specific campaign.
   */
  async getPushCampaignDetail(referenceId: string): Promise<PushCampaignDetail> {
    const raw = await apiFetch(`/v1/communication/push/campaigns/${referenceId}`) as PushCampaignDetail;
    return raw;
  },
};")
    print("Added methods to api object")
else:
    print("ERROR: Could not find getTimeline method")

pathlib.Path('apps/dashboard/src/lib/api.ts').write_text(s)
print("Done")
PY
python3 fix_api.py