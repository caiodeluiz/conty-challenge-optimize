import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { BENCH_SEED, CAMPAIGN_ID, FIXTURE_SEED, seed } from "../src/seed.ts";

function appWithSeed(creators: number = FIXTURE_SEED.creators) {
  const db = openDatabase(":memory:");
  seed(db, { creators, seed: 7 });
  return createApp(db);
}

describe("listagem em lote", () => {
  it("soma as métricas vencedoras de cada conta e preserva o desempate e o corte inclusivo", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_batch', 'Lote', '["a","a","b"]');
      INSERT INTO creators VALUES
        ('crt_multi', 'Multiconta', '["a","b"]', ''),
        ('crt_no_account', 'Sem conta', '["a"]', ''),
        ('crt_no_metric', 'Sem métrica', '["b"]', ''),
        ('crt_excluded', 'Sem nicho comum', '["z"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_multi_1', 'crt_multi', 'instagram'),
        ('acc_multi_2', 'crt_multi', 'tiktok'),
        ('acc_no_metric', 'crt_no_metric', 'instagram');
      INSERT INTO metrics VALUES
        ('met_multi_1_old', 'acc_multi_1', 500, '2026-05-29T00:00:00.000Z', ''),
        ('met_multi_1_tie_a', 'acc_multi_1', 4, '2026-05-30T00:00:00.000Z', ''),
        ('met_multi_1_tie_z', 'acc_multi_1', 9, '2026-05-30T00:00:00.000Z', ''),
        ('met_multi_2_old', 'acc_multi_2', 900, '2026-05-30T00:00:00.000Z', ''),
        ('met_multi_2_latest', 'acc_multi_2', 6, '2026-05-31T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_on_cutoff', 'crt_multi', '2026-03-03T12:00:00.000Z'),
        ('del_before_cutoff', 'crt_multi', '2026-03-03T11:59:59.999Z');
    `);
    const app = createApp(db);

    const response = await app.request("/campaigns/cmp_batch/creators");

    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.total).toBe(3);
    expect(page.creators.map((creator: { id: string }) => creator.id)).toEqual([
      "crt_multi",
      "crt_no_account",
      "crt_no_metric",
    ]);
    expect(page.creators[0]).toMatchObject({
      niche_score: 3,
      latest_reach: 15,
      deliveries_90d: 1,
    });
    expect(page.creators[1].latest_reach).toBe(0);
    expect(page.creators[2].latest_reach).toBe(0);
  });

  it("não multiplica alcance nem entregas quando um creator tem duas contas e duas entregas", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_fanout', 'Fanout', '["tech"]');
      INSERT INTO creators VALUES ('crt_fanout', 'Creator', '["tech"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_fanout_1', 'crt_fanout', 'instagram'),
        ('acc_fanout_2', 'crt_fanout', 'tiktok');
      INSERT INTO metrics VALUES
        ('met_fanout_1', 'acc_fanout_1', 10, '2026-05-31T00:00:00.000Z', ''),
        ('met_fanout_2', 'acc_fanout_2', 20, '2026-05-31T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_fanout_1', 'crt_fanout', '2026-05-01T00:00:00.000Z'),
        ('del_fanout_2', 'crt_fanout', '2026-05-02T00:00:00.000Z');
    `);
    const app = createApp(db);

    const response = await app.request("/campaigns/cmp_fanout/creators");

    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.creators).toHaveLength(1);
    expect(page.creators[0]).toMatchObject({ latest_reach: 30, deliveries_90d: 2 });
  });

  it("mantém a primeira página para limite zero e parâmetros de paginação inválidos", async () => {
    const app = appWithSeed();
    const readPage = async (query: string) => {
      const response = await app.request(`/campaigns/${CAMPAIGN_ID}/creators${query}`);
      expect(response.status).toBe(200);
      return response.json();
    };

    const defaultPage = await readPage("");
    const zeroLimitPage = await readPage("?limit=0&offset=0");
    const invalidPage = await readPage("?limit=invalid&offset=invalid");
    const negativePage = await readPage("?limit=-1&offset=-1");

    expect(zeroLimitPage).toEqual(defaultPage);
    expect(invalidPage).toEqual(defaultPage);
    expect(negativePage).toEqual(defaultPage);
  });

  it.each([FIXTURE_SEED.creators, 600, BENCH_SEED.creators])(
    "mantém o orçamento de consultas em até 8 com %i creators",
    async (creatorCount) => {
      const app = appWithSeed(creatorCount);
      resetQueryCount();

      const response = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);

      expect(response.status).toBe(200);
      expect(getQueryCount()).toBeLessThanOrEqual(8);
    },
  );
});
