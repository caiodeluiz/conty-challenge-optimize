import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type LatestReachRow = { creator_id: string; latest_reach: number };
type DeliveryCountRow = { creator_id: string; n: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT id, niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const since = deliveriesSince();
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const campaignNicheFrequency = new Map<string, number>();
  for (const niche of campaignNiches) {
    campaignNicheFrequency.set(niche, (campaignNicheFrequency.get(niche) ?? 0) + 1);
  }

  const latestReachRows = await all<LatestReachRow>(
    db,
    `WITH ranked_metrics AS (
      SELECT
        account_id,
        views,
        ROW_NUMBER() OVER (
          PARTITION BY account_id
          ORDER BY captured_at DESC, id DESC
        ) AS metric_rank
      FROM metrics
    )
    SELECT
      social_accounts.creator_id AS creator_id,
      SUM(ranked_metrics.views) AS latest_reach
    FROM social_accounts
    JOIN ranked_metrics
      ON ranked_metrics.account_id = social_accounts.id
      AND ranked_metrics.metric_rank = 1
    GROUP BY social_accounts.creator_id`,
  );
  const latestReachByCreator = new Map<string, number>();
  for (const row of latestReachRows) {
    latestReachByCreator.set(row.creator_id, Number(row.latest_reach));
  }

  const deliveryRows = await all<DeliveryCountRow>(
    db,
    `SELECT creator_id, COUNT(*) AS n
    FROM deliveries
    WHERE delivered_at >= ?
    GROUP BY creator_id`,
    since,
  );
  const deliveriesByCreator = new Map<string, number>();
  for (const row of deliveryRows) {
    deliveriesByCreator.set(row.creator_id, Number(row.n));
  }

  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const creatorNiche of creatorNiches) {
      // Keep the previous multiplicative count if either JSON array has duplicates.
      nicheScore += campaignNicheFrequency.get(creatorNiche) ?? 0;
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: latestReachByCreator.get(creator.id) ?? 0,
      deliveries_90d: deliveriesByCreator.get(creator.id) ?? 0,
    });
  }

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
